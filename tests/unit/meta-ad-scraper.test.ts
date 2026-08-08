import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fixtureAd, graphqlResponse, rateLimitResponse } from '../fixtures/graphql-response-fixture.js';
import { scrapeMetaAds } from '../../src/scraper/meta-ad-scraper.js';
import { ExecutionLogger } from '../../src/mcp/execution-logger.js';
import { sanitizeExtractionError, type Browser, type BrowserContext, type BrowserLauncher, type BrowserPage, type BrowserPageRequest, type BrowserPageResponse } from '../../src/scraper/scraper-types.js';
import { buildNetworkEvidence, classifyDiagnostic, effectiveBodyLimit, networkEvidenceSummary } from '../../src/scraper/network-evidence.js';

type PageEvent = unknown | BrowserPageResponse | { requestFailed: BrowserPageRequest };

class InstrumentedPage implements BrowserPage {
  private responseListener?: (response: BrowserPageResponse) => void | Promise<void>;
  private requestFailedListener?: (request: BrowserPageRequest) => void | Promise<void>;
  readonly gotoUrls: string[] = [];
  evaluateCount = 0;
  closeCount = 0;
  constructor(private readonly responses: PageEvent[][], private readonly gotoFailures = 0, private readonly responseDelayMs?: number) {}
  on(event: 'response' | 'requestfailed', listener: ((response: BrowserPageResponse) => void | Promise<void>) | ((request: BrowserPageRequest) => void | Promise<void>)): void {
    if (event === 'response') this.responseListener = listener as (response: BrowserPageResponse) => void | Promise<void>;
    else this.requestFailedListener = listener as (request: BrowserPageRequest) => void | Promise<void>;
  }
  async goto(url: string): Promise<void> {
    this.gotoUrls.push(url); if (this.gotoUrls.length <= this.gotoFailures) throw new Error('temporary navigation error');
    const emit = () => this.emit(this.responses.shift() ?? []);
    if (this.responseDelayMs === undefined) emit(); else setTimeout(emit, this.responseDelayMs);
  }
  async reload(): Promise<void> { await this.goto(this.gotoUrls[this.gotoUrls.length - 1] ?? ''); }
  async evaluate(): Promise<void> { this.evaluateCount++; this.emit(this.responses.shift() ?? []); }
  async close(): Promise<void> { this.closeCount++; }
  emit(payloads: unknown[]): void {
    for (const payload of payloads) {
      if (isResponse(payload)) { this.responseListener?.(payload); continue; }
      if (isRequestFailed(payload)) { this.requestFailedListener?.(payload.requestFailed); continue; }
      this.responseListener?.({
      url: () => 'https://www.facebook.com/api/graphql/?q=x',
      json: async () => payload,
      text: async () => JSON.stringify(payload),
      status: () => 200,
      headers: () => ({ 'content-type': 'application/json' }),
      });
    }
  }
  emitNext(): void { this.emit(this.responses.shift() ?? []); }
}
function isResponse(value: PageEvent): value is BrowserPageResponse { return typeof value === 'object' && value !== null && 'url' in value && typeof (value as BrowserPageResponse).url === 'function'; }
function isRequestFailed(value: PageEvent): value is { requestFailed: BrowserPageRequest } { return typeof value === 'object' && value !== null && 'requestFailed' in value; }
function documentResponse(url: string, body: string, status = 200, contentType = 'text/html'): BrowserPageResponse {
  const request: BrowserPageRequest = { url: () => url, resourceType: () => 'document', response: async () => response };
  const response: BrowserPageResponse = { url: () => url, request: () => request, json: async () => ({}), text: async () => body, status: () => status, headers: () => ({ 'content-type': contentType }) };
  return response;
}
function failedRequest(url: string, errorText: string): BrowserPageRequest { return { url: () => url, resourceType: () => 'document', failure: () => ({ errorText }) }; }
function requestForTest(url: string, resourceType: string, from?: BrowserPageRequest): BrowserPageRequest { return { url: () => url, resourceType: () => resourceType, redirectedFrom: () => from ?? null }; }
function documentResponseWithRequest(url: string, body: string, request: BrowserPageRequest, status = 200, contentType = 'text/html'): BrowserPageResponse {
  const response: BrowserPageResponse = { url: () => url, request: () => request, json: async () => ({}), text: async () => body, status: () => status, headers: () => ({ 'content-type': contentType }) };
  request.response = async () => response;
  return response;
}
function fakeLauncher(page: InstrumentedPage, counters: { contextClose: number; browserClose: number }): BrowserLauncher {
  const context: BrowserContext = { newPage: async () => page, close: async () => { counters.contextClose++; } };
  const browser: Browser = { newContext: async () => context, close: async () => { counters.browserClose++; } };
  return { launch: async (options) => { expect(options.headless).toBe(true); return browser; } };
}
const noWait = async (): Promise<void> => {};
afterEach(() => { vi.useRealTimers(); });

describe('extraction diagnostic sanitization', () => {
  it('redacts bearer credentials and local details', () => {
    const diagnostic = sanitizeExtractionError(new Error('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.secret-signature /Users/test/app.ts'), false);
    expect(diagnostic.userMessage).toContain('no se recuperaron');
    expect(diagnostic.technicalDetail).not.toContain('eyJhbGci');
    expect(diagnostic.technicalDetail).not.toContain('/Users/test');
  });
});

describe('diagnostic activation contract', () => {
  it('keeps the successful timeline buffered while persisting its summary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'diagnostic-activation-'));
    const logger = new ExecutionLogger(root, 'success');
    await scrapeMetaAds({ query: 'ok', country: 'CO', dateFrom: '2026-05-07', dateTo: '2026-08-07', adType: 'all' }, { launcher: fakeLauncher(new InstrumentedPage([[graphqlResponse([fixtureAd('ok')], false)]]), { contextClose: 0, browserClose: 0 }), sleep: noWait, random: () => 0, logger: logger.scraperLogger() });
    const diagnostic = await readFile(logger.diagnosticPath, 'utf8');
    expect(diagnostic).toContain('diagnostic.summary'); expect(diagnostic).not.toContain('diagnostic.navigation'); expect(diagnostic).not.toContain('diagnostic.graphql'); await rm(root, { recursive: true, force: true });
  });
});

describe('diagnostic classification precedence', () => {
  const base = { challenge: false, captcha: false, login: false, ssrResults: false, explicitEmpty: false, shellWithoutResults: false, resultCount: 0, connectionCount: 0 };
  it.each([
    ['network_failure', {}, true, false], ['challenge_or_http_block', { challenge: true }, false, false], ['captcha', { captcha: true }, false, false], ['ssr_results', { ssrResults: true }, false, false],
    ['explicit_empty', { explicitEmpty: true }, false, false], ['login_required', { login: true }, false, false], ['shell_without_results', { shellWithoutResults: true }, false, false], ['unknown', {}, false, false]
  ])('classifies %s deterministically', (expected, signals, networkFailure, httpBlock) => {
    expect(classifyDiagnostic({ ...base, ...signals, ...(expected === 'unknown' ? {} : {}) }, networkFailure, httpBlock)).toBe(expected);
  });
});

describe('network evidence', () => {
  const request = (url: string, from?: BrowserPageRequest): BrowserPageRequest => ({ url: () => url, resourceType: () => 'document', redirectedFrom: () => from ?? null });
  it('redacts sensitive values and truncates by UTF-8 bytes after redaction', () => {
    const evidence = buildNetworkEvidence({
      responsePresent: true,
      url: 'https://example.test/graphql?token=secret-token&query=cafe',
      body: `cookie: session-secret authorization: Bearer bearer-secret token=token-secret ${'界'.repeat(20000)}`,
      bodyLimitBytes: 32768,
    });
    expect(evidence.url).not.toContain('secret-token');
    expect(evidence.body).not.toContain('session-secret');
    expect(evidence.body).not.toContain('bearer-secret');
    expect(evidence.body).not.toContain('token-secret');
    expect(Buffer.byteLength(evidence.body ?? '', 'utf8')).toBeLessThanOrEqual(32768);
    expect(evidence.bodyTruncated).toBe(true);
    expect(networkEvidenceSummary(evidence)).not.toHaveProperty('body');
  });
  it('redacts session and cookie value variants without matching legitimate fields', () => {
    const evidence = buildNetworkEvidence({
      responsePresent: true,
      body: JSON.stringify({
        session_id: 'leaked-session-value',
        cookieValue: 'leaked-cookie-value',
        session_title: 'keep-session-title',
        tokenCount: 3,
      }),
    });
    expect(evidence.body).not.toContain('leaked-session-value');
    expect(evidence.body).not.toContain('leaked-cookie-value');
    expect(evidence.body).toContain('keep-session-title');
    expect(evidence.body).toContain('tokenCount');
  });
  it('represents a missing response without a body', () => {
    const evidence = buildNetworkEvidence({ responsePresent: false, url: 'https://example.test/ads' });
    expect(evidence.responsePresent).toBe(false);
    expect(evidence).not.toHaveProperty('body');
  });
  it('normalizes configurable body limits, including zero and negative values', () => {
    expect(effectiveBodyLimit(0)).toBe(1);
    expect(effectiveBodyLimit(-20)).toBe(1);
    expect(effectiveBodyLimit(999999)).toBe(32768);
    expect(effectiveBodyLimit(undefined)).toBe(32768);
  });
  it('keeps redirect chains ordered and classifies their observable signal', async () => {
    const origin = request('https://example.test/start');
    const terminal = request('https://example.test/login', origin);
    const response = documentResponse('https://example.test/login', '<html>login</html>');
    terminal.response = async () => response;
    const evidence = buildNetworkEvidence({ responsePresent: true, url: terminal.url(), hops: [{ url: origin.url(), status: 302, destination: terminal.url() }, { url: terminal.url(), status: 200 }] });
    expect(evidence.hops).toHaveLength(2);
    expect(evidence.classification).toBeUndefined();
  });
});

describe('Meta Ad scraper', () => {
  const scrapeEvidence = async (events: PageEvent[], options: Parameters<typeof scrapeMetaAds>[1] = {}) => {
    const page = new InstrumentedPage([events]);
    return scrapeMetaAds({ query: 'classification', country: 'CO', dateFrom: '2026-05-07', dateTo: '2026-08-07', adType: 'all' }, { launcher: fakeLauncher(page, { contextClose: 0, browserClose: 0 }), sleep: noWait, random: () => 0, captureTimeoutMs: 1, ...options });
  };

  it('enforces five evidence and 160 KiB body caps in the logger payload', async () => {
    const events: unknown[] = [];
    const documents = Array.from({ length: 6 }, (_, index) => documentResponse(`https://example.test/document-${index}`, 'x'.repeat(32 * 1024)));
    await scrapeEvidence(documents, { logger: (event) => events.push(event) });
    const evidenceEvent = events.find((event) => typeof event === 'object' && event !== null && 'message' in event && (event as { message?: unknown }).message === 'scraper.network_evidence' && Array.isArray((event as { evidence?: unknown }).evidence)) as { evidence: Array<{ body?: string }> } | undefined;
    expect(evidenceEvent).toBeDefined();
    expect(evidenceEvent?.evidence).toHaveLength(5);
    expect(evidenceEvent?.evidence.every((evidence) => Buffer.byteLength(evidence.body ?? '', 'utf8') <= 32 * 1024)).toBe(true);
    expect(evidenceEvent?.evidence.reduce((total, evidence) => total + Buffer.byteLength(evidence.body ?? '', 'utf8'), 0)).toBeLessThanOrEqual(160 * 1024);
  });

  it('classifies each real evidence source with observable signals', async () => {
    const originRequest = requestForTest('https://example.test/origin', 'document');
    const terminalRequest = requestForTest('https://example.test/terminal', 'document', originRequest);
    const redirect = await scrapeEvidence([
      documentResponseWithRequest('https://example.test/origin', '<html>redirect</html>', originRequest, 302),
      documentResponseWithRequest('https://example.test/terminal', '<html>done</html>', terminalRequest, 200),
    ]);
    const login = await scrapeEvidence([documentResponse('https://example.test/login', '<html>sign in</html>')]);
    const block = await scrapeEvidence([documentResponse('https://example.test/blocked', '<html>blocked</html>', 403)]);
    const failure = await scrapeEvidence([{ requestFailed: failedRequest('https://example.test/failure', 'connection reset') }]);
    const unknown = await scrapeEvidence([documentResponse('https://example.test/ordinary', '<html>ordinary page</html>')]);
    const labels = (result: Awaited<ReturnType<typeof scrapeEvidence>>) => result.diagnostic?.classifications ?? [];
    expect(labels(redirect)).toEqual(expect.arrayContaining([expect.objectContaining({ label: 'possible_redirect', signals: expect.arrayContaining([expect.any(String)]) })]));
    expect(labels(login)).toEqual(expect.arrayContaining([expect.objectContaining({ label: 'possible_login', signals: expect.arrayContaining([expect.any(String)]) })]));
    expect(labels(block)).toEqual(expect.arrayContaining([expect.objectContaining({ label: 'possible_http_block', signals: expect.arrayContaining([expect.any(String)]) })]));
    expect(labels(failure)).toEqual(expect.arrayContaining([expect.objectContaining({ label: 'possible_network_failure', signals: expect.arrayContaining([expect.any(String)]) })]));
    expect(labels(unknown)).toEqual(expect.arrayContaining([expect.objectContaining({ label: 'unknown', signals: expect.arrayContaining([expect.any(String)]) })]));
  });

  it('captures non-GraphQL HTML, excludes assets, redirects duplicates, and request failures', async () => {
    const origin = requestForTest('https://example.test/start', 'document');
    const terminal = requestForTest('https://example.test/login', 'document', origin);
    const terminalResponse = documentResponseWithRequest('https://example.test/login', '<html>login</html>', terminal);
    const asset = documentResponseWithRequest('https://example.test/app.js', 'secret', requestForTest('https://example.test/app.js', 'script'));
    const page = new InstrumentedPage([[documentResponseWithRequest('https://example.test/start', '<html>redirect</html>', origin), terminalResponse, asset, { requestFailed: failedRequest('https://example.test/fail?token=secret', 'DNS failure') }]]);
    const result = await scrapeMetaAds({ query: 'evidence', country: 'CO', dateFrom: '2026-05-07', dateTo: '2026-08-07', adType: 'all' }, { launcher: fakeLauncher(page, { contextClose: 0, browserClose: 0 }), sleep: noWait, random: () => 0, captureTimeoutMs: 1 });
    expect(result.stopReason).toBe('unrecognized_response');
    expect(result.diagnostic?.networkEvidence).toHaveLength(2);
    expect(result.diagnostic?.networkEvidence?.filter((item) => item.kind === 'document')).toHaveLength(1);
    expect(result.diagnostic?.networkEvidence?.some((item) => item.kind === 'network_failure')).toBe(true);
    expect(JSON.stringify(result)).not.toContain('secret');
  });
  it('publishes one consolidated evidence event for empty_capture', async () => {
    const events: unknown[] = [];
    const page = new InstrumentedPage([[documentResponse('https://example.test/blocked', '<html>blocked</html>', 403)]]);
    const result = await scrapeMetaAds({ query: 'consolidated', country: 'CO', dateFrom: '2026-05-07', dateTo: '2026-08-07', adType: 'all' }, { launcher: fakeLauncher(page, { contextClose: 0, browserClose: 0 }), sleep: noWait, random: () => 0, captureTimeoutMs: 1, logger: (event) => events.push(event) });
    const evidenceEvents = events.filter((event) => typeof event === 'object' && event !== null && 'message' in event && (event as { message?: unknown }).message === 'scraper.network_evidence') as Array<{ reason?: string; evidence?: unknown }>;
    expect(result.stopReason).toBe('empty_capture');
    expect(evidenceEvents).toHaveLength(1);
    expect(evidenceEvents[0]).toMatchObject({ reason: 'empty_capture', evidence: expect.any(Array) });
    expect(evidenceEvents[0].evidence).toHaveLength(1);
  });
  it('preserves empty_capture when diagnostic logging fails', async () => {
    const page = new InstrumentedPage([[documentResponse('https://example.test/blocked', '<html>blocked</html>', 403)]]);
    const result = await scrapeMetaAds({ query: 'failure', country: 'CO', dateFrom: '2026-05-07', dateTo: '2026-08-07', adType: 'all' }, { launcher: fakeLauncher(page, { contextClose: 0, browserClose: 0 }), sleep: noWait, random: () => 0, captureTimeoutMs: 1, logger: (event) => { if (event.type === 'error') throw new Error('logger unavailable'); } });
    expect(result.stopReason).toBe('empty_capture');
    expect(result.diagnostic?.diagnosticIncomplete).toBe(true);
    expect(result.diagnostic).not.toHaveProperty('logReference');
    expect(result.diagnostic).not.toHaveProperty('evidenceId');
    expect(result.diagnostic).not.toHaveProperty('networkEvidence');
  });
  it('builds the filtered URL from structured fields without polluting the query', async () => {
    const page = new InstrumentedPage([[{ data: { ad_library_main: { search_results_connection: { edges: [] } } } }]]);
    await scrapeMetaAds({ query: 'café especialidad', country: 'CO', dateFrom: '2026-05-07', dateTo: '2026-08-07', adType: 'all' }, { launcher: fakeLauncher(page, { contextClose: 0, browserClose: 0 }), sleep: noWait, random: () => 0 });
    expect(page.gotoUrls[0]).toContain('q=caf%C3%A9+especialidad');
    const url = new URL(page.gotoUrls[0]);
    expect(url.searchParams.get('q')).toBe('café especialidad');
    expect(url.searchParams.get('q')).not.toContain('Colombia');
    expect(url.searchParams.get('q')).not.toContain('últimos 3 meses');
    expect(url.searchParams.get('country')).toBe('CO');
    expect(url.searchParams.get('ad_type')).toBe('all');
    expect(url.searchParams.get('start_date[min]')).toBe('2026-05-07');
    expect(url.searchParams.get('start_date[max]')).toBe('2026-08-07');
    expect(url.searchParams.get('active_status')).toBe('all');
    expect(url.searchParams.get('is_targeted_country')).toBe('false');
    expect(url.searchParams.get('media_type')).toBe('all');
    expect(url.searchParams.get('search_type')).toBe('keyword_unordered');
    expect([...url.searchParams.keys()]).toEqual(['q', 'active_status', 'ad_type', 'country', 'is_targeted_country', 'media_type', 'search_type', 'start_date[min]', 'start_date[max]']);
  });
  it('captures late GraphQL responses inside the injected window', async () => {
    vi.useFakeTimers();
    const page = new InstrumentedPage([[graphqlResponse([fixtureAd('1')], false)]], 0, 25);
    const counters = { contextClose: 0, browserClose: 0 };
    const scraping = scrapeMetaAds({ query: 'diabetes', country: 'CO', dateFrom: '2026-05-07', dateTo: '2026-08-07', adType: 'all' }, { launcher: fakeLauncher(page, counters), sleep: noWait, random: () => 0 });
    await vi.advanceTimersByTimeAsync(25);
    const result = await scraping;
    expect(result.sourceCount).toBe(1); expect(result.stopReason).toBe('end_of_results');
    expect(page.gotoUrls).toHaveLength(1); expect(page.gotoUrls[0]).toContain('q=diabetes'); expect(page.evaluateCount).toBe(0);
    expect(page.closeCount).toBe(1); expect(counters.contextClose).toBe(1); expect(counters.browserClose).toBe(1);
  });
  it('recovers a transient document block with one reload in the same page', async () => {
    const page = new InstrumentedPage([[documentResponse('https://example.test/rd_challenge', '<html>rd_challenge</html>', 403)], [graphqlResponse([fixtureAd('reloaded')], false)]]);
    const waits: number[] = [];
    const result = await scrapeMetaAds({ query: 'reload', country: 'CO', dateFrom: '2026-05-07', dateTo: '2026-08-07', adType: 'all' }, { launcher: fakeLauncher(page, { contextClose: 0, browserClose: 0 }), sleep: async (ms) => { waits.push(ms); }, random: () => 0 });
    expect(result.sourceCount).toBe(1);
    expect(page.gotoUrls).toHaveLength(2);
    expect(waits).toContain(1500);
  });
  it('stops after one reload when the document challenge persists', async () => {
    const page = new InstrumentedPage([
      [documentResponse('https://example.test/rd_challenge', '<html>rd_challenge</html>', 403)],
      [documentResponse('https://example.test/rd_challenge', '<html>blocked</html>', 403)],
    ]);
    const result = await scrapeMetaAds({ query: 'persistent-block', country: 'CO', dateFrom: '2026-05-07', dateTo: '2026-08-07', adType: 'all' }, { launcher: fakeLauncher(page, { contextClose: 0, browserClose: 0 }), sleep: noWait, random: () => 0, captureTimeoutMs: 1 });
    expect(result).toMatchObject({ status: 'bloqueada', stopReason: 'unrecognized_response' });
    expect(page.gotoUrls).toHaveLength(2);
    expect(result.diagnostic?.classifications).toEqual(expect.arrayContaining([expect.objectContaining({ label: 'possible_http_block' })]));
  });
  it('captures a valid SSR document as the initial batch', async () => {
    const body = '<script>{"bootstrap":{"search_results_connection":{"edges":[{"node":{"collated_results":[{"ad_archive_id":"ssr-scraper"}]}}],"page_info":{"has_next_page":false}}}}</script>';
    const page = new InstrumentedPage([[documentResponse('https://example.test/ads', body)]]);
    const result = await scrapeMetaAds({ query: 'ssr', country: 'CO', dateFrom: '2026-05-07', dateTo: '2026-08-07', adType: 'all' }, { launcher: fakeLauncher(page, { contextClose: 0, browserClose: 0 }), sleep: noWait, random: () => 0 });
    expect(result).toMatchObject({ status: 'completa', stopReason: 'end_of_results', sourceCount: 1 });
    expect(page.evaluateCount).toBe(0);
  });
  it('terminates explicitly for CAPTCHA or login documents', async () => {
    const page = new InstrumentedPage([[documentResponse('https://example.test/login', '<html>captcha required</html>')]]);
    const result = await scrapeMetaAds({ query: 'captcha', country: 'CO', dateFrom: '2026-05-07', dateTo: '2026-08-07', adType: 'all' }, { launcher: fakeLauncher(page, { contextClose: 0, browserClose: 0 }), sleep: noWait, random: () => 0, captureTimeoutMs: 1 });
    expect(result.status).toBe('bloqueada');
    expect(result.diagnostic?.classifications).toEqual(expect.arrayContaining([expect.objectContaining({ label: 'possible_login' })]));
  });
  it('terminates explicitly for a non-blocking HTTP error document', async () => {
    const page = new InstrumentedPage([[documentResponse('https://example.test/not-found', '<html>not found</html>', 404)]]);
    const result = await scrapeMetaAds({ query: 'http-error', country: 'CO', dateFrom: '2026-05-07', dateTo: '2026-08-07', adType: 'all' }, { launcher: fakeLauncher(page, { contextClose: 0, browserClose: 0 }), sleep: noWait, random: () => 0, captureTimeoutMs: 1 });
    expect(result).toMatchObject({ status: 'incompleta', stopReason: 'error' });
  });
  it('does not complete on unrecognized traffic before the semantic timeout', async () => {
    vi.useFakeTimers();
    const page = new InstrumentedPage([[{ data: { incidental: true } }]]);
    const scraping = scrapeMetaAds({ query: 'semantic-timeout', country: 'CO', dateFrom: '2026-05-07', dateTo: '2026-08-07', adType: 'all' }, { launcher: fakeLauncher(page, { contextClose: 0, browserClose: 0 }), sleep: noWait, random: () => 0, captureTimeoutMs: 50 });
    await vi.advanceTimersByTimeAsync(10);
    expect(page.closeCount).toBe(0);
    await vi.advanceTimersByTimeAsync(40);
    const result = await scraping;
    expect(result).toMatchObject({ status: 'incompleta', stopReason: 'unrecognized_response' });
  });
  it('emits browser, search, batch and finish events', async () => {
    const events: string[] = []; const page = new InstrumentedPage([[graphqlResponse([fixtureAd('logged')], false)]]);
    await scrapeMetaAds({ query: 'logged', country: 'CO', dateFrom: '2026-05-07', dateTo: '2026-08-07', adType: 'all' }, { launcher: fakeLauncher(page, { contextClose: 0, browserClose: 0 }), sleep: noWait, random: () => 0, logger: (event) => events.push(event.type) });
    expect(events).toEqual(expect.arrayContaining(['start', 'browser', 'search', 'batch', 'finish']));
  });
  it('times out an action without GraphQL and still cleans up', async () => {
    vi.useFakeTimers();
    const page = new InstrumentedPage([[]]); const counters = { contextClose: 0, browserClose: 0 };
    const scraping = scrapeMetaAds({ query: 'x', country: 'CO', dateFrom: '2026-05-07', dateTo: '2026-08-07', adType: 'all' }, { launcher: fakeLauncher(page, counters), sleep: noWait, random: () => 0, captureTimeoutMs: 10 });
    await vi.advanceTimersByTimeAsync(10);
    const result = await scraping;
    expect(result.sourceCount).toBe(0); expect(page.closeCount).toBe(1); expect(counters.contextClose).toBe(1); expect(counters.browserClose).toBe(1);
  });
  it('stops on no-new, without an extra scroll', async () => {
    const page = new InstrumentedPage([[graphqlResponse([fixtureAd('1')], true)], [graphqlResponse([fixtureAd('1')], true)]]);
    const result = await scrapeMetaAds({ query: 'x', country: 'CO', dateFrom: '2026-05-07', dateTo: '2026-08-07', adType: 'all' }, { launcher: fakeLauncher(page, { contextClose: 0, browserClose: 0 }), sleep: noWait, random: () => 0 });
    expect(result.stopReason).toBe('no_new_ads'); expect(page.evaluateCount).toBe(1);
  });
  it('cuts at 1,500 source ads and does not scroll', async () => {
    const ads = Array.from({ length: 1501 }, (_, index) => fixtureAd(String(index)));
    const page = new InstrumentedPage([[graphqlResponse(ads, true)]]);
    const result = await scrapeMetaAds({ query: 'x', country: 'CO', dateFrom: '2026-05-07', dateTo: '2026-08-07', adType: 'all' }, { launcher: fakeLauncher(page, { contextClose: 0, browserClose: 0 }), sleep: noWait, random: () => 0 });
    expect(result.sourceCount).toBe(1500); expect(result.stopReason).toBe('ad_limit'); expect(page.evaluateCount).toBe(0);
  });
  it('retains partial records and stops on final rate limit', async () => {
    const page = new InstrumentedPage([[graphqlResponse([fixtureAd('1')], true)], [rateLimitResponse]]);
    const result = await scrapeMetaAds({ query: 'x', country: 'CO', dateFrom: '2026-05-07', dateTo: '2026-08-07', adType: 'all' }, { launcher: fakeLauncher(page, { contextClose: 0, browserClose: 0 }), sleep: noWait, random: () => 0 });
    expect(result.status).toBe('bloqueada'); expect(result.stopReason).toBe('rate_limit'); expect(result.records).toHaveLength(1); expect(page.evaluateCount).toBe(1);
  });
  it('writes retry, scraper error and stack details through ExecutionLogger', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scraper-log-')); const logger = new ExecutionLogger(root, 'retry-task');
    try { const page = new InstrumentedPage([[], [], [], []], 4); await scrapeMetaAds({ query: 'retry', country: 'CO', dateFrom: '2026-05-07', dateTo: '2026-08-07', adType: 'all' }, { launcher: fakeLauncher(page, { contextClose: 0, browserClose: 0 }), sleep: noWait, random: () => 0, logger: logger.scraperLogger() }); const execution = await readFile(logger.executionPath, 'utf8'); const errors = await readFile(logger.errorPath, 'utf8'); expect(execution).toContain('scraper.retry'); expect(errors).toContain('stack'); } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('writes blocked events without creating error.jsonl for rate limits', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scraper-log-')); const logger = new ExecutionLogger(root, 'blocked-task');
    try { const page = new InstrumentedPage([[graphqlResponse([fixtureAd('1')], true)], [rateLimitResponse]]); await scrapeMetaAds({ query: 'blocked', country: 'CO', dateFrom: '2026-05-07', dateTo: '2026-08-07', adType: 'all' }, { launcher: fakeLauncher(page, { contextClose: 0, browserClose: 0 }), sleep: noWait, random: () => 0, logger: logger.scraperLogger() }); expect(await readFile(logger.executionPath, 'utf8')).toContain('scraper.blocked'); await expect(stat(logger.errorPath)).rejects.toMatchObject({ code: 'ENOENT' }); } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('diagnoses unrecognized responses with complete raw evidence and a manual alternative', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scraper-log-')); const logger = new ExecutionLogger(root, 'unrecognized-task');
    try {
      const raw = { data: { unexpected: true }, marker: 'keep-me' };
      const page = new InstrumentedPage([[raw]]);
      const result = await scrapeMetaAds({ query: 'café colombiano', country: 'CO', dateFrom: '2026-05-07', dateTo: '2026-08-07', adType: 'all' }, { launcher: fakeLauncher(page, { contextClose: 0, browserClose: 0 }), sleep: noWait, random: () => 0, logger: logger.scraperLogger(), captureTimeoutMs: 1 });
      expect(result.extractionStatus).toBe('fallida');
      expect(result.diagnostic?.alternativeSearchUrl).toContain('q=caf%C3%A9+colombiano');
      expect(await readFile(logger.errorPath, 'utf8')).toContain('keep-me');
      expect(result.diagnostic).toMatchObject({ responsePresent: true, status: 200, contentType: 'application/json', evidenceId: expect.any(String), logReference: expect.stringContaining('scraper.network_evidence:') });
      expect(result.diagnostic).not.toHaveProperty('body');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('marks a later unrecognized response as partial while preserving captured records', async () => {
    const page = new InstrumentedPage([[graphqlResponse([fixtureAd('kept')], true)], [{ data: { unexpected: true } }]]);
    const result = await scrapeMetaAds({ query: 'partial', country: 'CO', dateFrom: '2026-05-07', dateTo: '2026-08-07', adType: 'all' }, { launcher: fakeLauncher(page, { contextClose: 0, browserClose: 0 }), sleep: noWait, random: () => 0, captureTimeoutMs: 1 });
    expect(result.records).toHaveLength(1);
    expect(result).toMatchObject({ status: 'incompleta', stopReason: 'unrecognized_response', extractionStatus: 'parcial' });
  });
  it('keeps a recognized empty connection successful without an error log', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scraper-log-')); const logger = new ExecutionLogger(root, 'empty-task');
    try {
      const page = new InstrumentedPage([[{ data: { ad_library_main: { search_results_connection: { edges: [] } } } }]]);
      const result = await scrapeMetaAds({ query: 'empty', country: 'CO', dateFrom: '2026-05-07', dateTo: '2026-08-07', adType: 'all' }, { launcher: fakeLauncher(page, { contextClose: 0, browserClose: 0 }), sleep: noWait, random: () => 0, logger: logger.scraperLogger(), captureTimeoutMs: 1 });
      expect(result).toMatchObject({ status: 'completa', extractionStatus: 'completada', sourceCount: 0 });
      await expect(stat(logger.errorPath)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('always records sanitized evidence even when optional diagnostics are disabled', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scraper-log-')); const logger = new ExecutionLogger(root, 'production-task');
    try {
      const page = new InstrumentedPage([[{ data: { unexpected: true }, secret: 'not-logged' }]]);
      const result = await scrapeMetaAds({ query: 'production', country: 'CO', dateFrom: '2026-05-07', dateTo: '2026-08-07', adType: 'all' }, { launcher: fakeLauncher(page, { contextClose: 0, browserClose: 0 }), sleep: noWait, random: () => 0, logger: logger.scraperLogger(), diagnosticsEnabled: false, captureTimeoutMs: 1 });
      expect(result.diagnostic).toMatchObject({ responsePresent: true, evidenceId: expect.any(String) });
      expect(await readFile(logger.errorPath, 'utf8')).not.toContain('not-logged');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('uses all three backoffs and no fourth attempt', async () => {
    const page = new InstrumentedPage([[], [], [], []], 4); const waits: number[] = []; const root = await mkdtemp(join(tmpdir(), 'scraper-retries-summary-')); const logger = new ExecutionLogger(root, 'retries-task');
    const result = await scrapeMetaAds({ query: 'x', country: 'CO', dateFrom: '2026-05-07', dateTo: '2026-08-07', adType: 'all' }, { launcher: fakeLauncher(page, { contextClose: 0, browserClose: 0 }), sleep: async (ms) => { waits.push(ms); }, random: () => 0, logger: logger.scraperLogger() });
    expect(result.status).toBe('incompleta'); expect(result.stopReason).toBe('retries_exhausted'); expect(page.gotoUrls).toHaveLength(4);
    expect(waits.filter((ms) => [60000, 120000, 240000].includes(ms))).toEqual([60000, 120000, 240000]);
    expect(await readFile(logger.diagnosticPath, 'utf8')).toContain('diagnostic.summary'); await rm(root, { recursive: true, force: true });
  });
  it('writes a diagnostic summary when browser setup fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scraper-error-summary-')); const logger = new ExecutionLogger(root, 'error-task');
    try {
      const launcher: BrowserLauncher = { launch: async () => { throw new Error('browser unavailable'); } };
      const result = await scrapeMetaAds({ query: 'x', country: 'CO', dateFrom: '2026-05-07', dateTo: '2026-08-07', adType: 'all' }, { launcher, logger: logger.scraperLogger() });
      expect(result.stopReason).toBe('error');
      expect(await readFile(logger.diagnosticPath, 'utf8')).toContain('diagnostic.summary');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
