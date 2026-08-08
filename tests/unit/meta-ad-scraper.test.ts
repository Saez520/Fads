import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fixtureAd, graphqlResponse, rateLimitResponse } from '../fixtures/graphql-response-fixture.js';
import { scrapeMetaAds } from '../../src/scraper/meta-ad-scraper.js';
import { ExecutionLogger } from '../../src/mcp/execution-logger.js';
import { sanitizeExtractionError, type Browser, type BrowserContext, type BrowserLauncher, type BrowserPage, type BrowserPageResponse } from '../../src/scraper/scraper-types.js';
import { buildNetworkEvidence, networkEvidenceSummary } from '../../src/scraper/network-evidence.js';

class InstrumentedPage implements BrowserPage {
  private listener?: (response: BrowserPageResponse) => void | Promise<void>;
  readonly gotoUrls: string[] = [];
  evaluateCount = 0;
  closeCount = 0;
  constructor(private readonly responses: unknown[][], private readonly gotoFailures = 0, private readonly responseDelayMs?: number) {}
  on(_event: 'response', listener: (response: BrowserPageResponse) => void | Promise<void>): void { this.listener = listener; }
  async goto(url: string): Promise<void> {
    this.gotoUrls.push(url); if (this.gotoUrls.length <= this.gotoFailures) throw new Error('temporary navigation error');
    const emit = () => this.emit(this.responses.shift() ?? []);
    if (this.responseDelayMs === undefined) emit(); else setTimeout(emit, this.responseDelayMs);
  }
  async evaluate(): Promise<void> { this.evaluateCount++; this.emit(this.responses.shift() ?? []); }
  async close(): Promise<void> { this.closeCount++; }
  emit(payloads: unknown[]): void {
    for (const payload of payloads) this.listener?.({
      url: () => 'https://www.facebook.com/api/graphql/?q=x',
      json: async () => payload,
      text: async () => JSON.stringify(payload),
      status: () => 200,
      headers: () => ({ 'content-type': 'application/json' }),
    });
  }
  emitNext(): void { this.emit(this.responses.shift() ?? []); }
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

describe('network evidence', () => {
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
});

describe('Meta Ad scraper', () => {
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
    expect(url.searchParams.get('start_date')).toBe('1778112000');
    expect(url.searchParams.get('end_date')).toBe('1786147199');
    expect([...url.searchParams.keys()]).toEqual(['q', 'country', 'ad_type', 'start_date', 'end_date']);
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
    const page = new InstrumentedPage([[], [], [], []], 4); const waits: number[] = [];
    const result = await scrapeMetaAds({ query: 'x', country: 'CO', dateFrom: '2026-05-07', dateTo: '2026-08-07', adType: 'all' }, { launcher: fakeLauncher(page, { contextClose: 0, browserClose: 0 }), sleep: async (ms) => { waits.push(ms); }, random: () => 0 });
    expect(result.status).toBe('incompleta'); expect(result.stopReason).toBe('retries_exhausted'); expect(page.gotoUrls).toHaveLength(4);
    expect(waits.filter((ms) => [60000, 120000, 240000].includes(ms))).toEqual([60000, 120000, 240000]);
  });
});
