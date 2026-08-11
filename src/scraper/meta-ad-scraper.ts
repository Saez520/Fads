import { chromium } from 'playwright';
import { normalizeAndFingerprintAd } from '../domain/fingerprints.js';
import type { NormalizedAdRecord } from '../domain/ad-model.js';
import { isGraphQlEndpoint, parseGraphQlResponse, parseSsrSearchResultsConnection } from './graphql-response-parser.js';
import { waitForRetry } from './retry-policy.js';
import { waitForThrottle } from './timing-policy.js';
import { buildNetworkEvidence, classifyDiagnostic, classifyNetworkEvidence, isEligibleDocument, isGraphQlUrl, networkEvidenceSummary, redirectHops, sanitizeDiagnosticText, type NetworkEvidence } from './network-evidence.js';
import type { AdInput } from '../domain/ad-input.js';
import { extractionStatusFor, sanitizeExtractionError, type Browser, type BrowserContext, type BrowserLauncher, type BrowserPage, type BrowserPageRequest, type BrowserPageResponse, type CaptureWindow, type Clock, type DiagnosticDomSignals, type DiagnosticTrigger, type ExtractionDiagnostic, type ExtractionStatus, type Logger, type MetaAdScraperOptions, type Random, type ScrapeRequest, type ScrapeStatus, type Sleeper, type StopReason } from './scraper-types.js';
export type { MetaAdScraperOptions } from './scraper-types.js';

const defaultLauncher: BrowserLauncher = { launch: (options) => chromium.launch(options) as unknown as Promise<Browser> };
const defaultSleep: Sleeper = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const defaultClock: Clock = { now: () => performance.now() };
const defaultRandom: Random = () => Math.random();
const MAX_NETWORK_EVIDENCE_COUNT = 5;
const MAX_NETWORK_EVIDENCE_BODY_BYTES = 160 * 1024;

export interface ScraperResult { records: NormalizedAdRecord[]; status: ScrapeStatus; stopReason: StopReason; sourceCount: number; extractionStatus: ExtractionStatus; diagnostic?: ExtractionDiagnostic }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
type PhaseOperation = 'initial_goto' | 'recovery_reload' | 'recovery_goto' | 'bootstrap' | 'pagination';
const phaseNames: Record<PhaseOperation, string> = {
  initial_goto: 'scraper.nav.goto',
  recovery_reload: 'scraper.recovery.reload',
  recovery_goto: 'scraper.recovery.goto',
  bootstrap: 'scraper.scroll.bootstrap',
  pagination: 'scraper.scroll.pagination',
};

export async function scrapeMetaAds(request: ScrapeRequest, options: MetaAdScraperOptions = {}): Promise<ScraperResult> {
  const launcher = options.launcher ?? defaultLauncher;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? defaultRandom;
  const clock = options.clock ?? defaultClock;
  const logger: Logger = options.logger ?? (() => undefined);
  const diagnosticState = options.diagnosticState ?? logger.diagnosticState;
  const captureTimeoutMs = options.captureTimeoutMs ?? 15_000;
  const captureWindow: CaptureWindow = options.captureWindow ?? ((nextGraphQlResponse) => waitForCaptureWindow(nextGraphQlResponse, captureTimeoutMs));
  const maxSourceAds = options.maxSourceAds ?? 1500;
  const diagnosticsEnabled = options.diagnosticsEnabled ?? process.env.NODE_ENV !== 'production';
  const networkEvidenceBodyLimitBytes = options.networkEvidenceBodyLimitBytes ?? 32 * 1024;
  const records: NormalizedAdRecord[] = [];
  const sourceIds = new Set<string>();
  const started = clock.now();
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let page: BrowserPage | undefined;
  let status: ScrapeStatus = 'completa';
  let stopReason: StopReason = 'end_of_results';
  let exhaustedRetries = false;
  let primaryError: unknown;
  let latestEvidence: NetworkEvidence | undefined;
  const networkEvidence: NetworkEvidence[] = [];
  let networkEvidenceBodyBytes = 0;
  let diagnosticIncomplete = false;
  const domSignals: DiagnosticDomSignals = { challenge: false, captcha: false, login: false, ssrResults: false, explicitEmpty: false, shellWithoutResults: false, resultCount: 0, connectionCount: 0 };
  let networkFailure = false;
  let httpBlock = false;
  let challengeRecoveryFailed = false;
  let diagnosticEventCount = 0;
  const diagnosticEvent = (event: Record<string, unknown>, reinforced = false): void => {
    diagnosticEventCount++;
    logger({ type: 'diagnostic', query: request.query, event: { ...event, priority: reinforced ? 'high' : 'low' } as never, reinforced });
  };
  logger({ type: 'start', query: request.query });
  try {
    browser = await launcher.launch({ headless: true });
    context = await browser.newContext();
    page = await context.newPage();
    logger({ type: 'browser', query: request.query, message: 'browser.ready' });
    try {
      const metadata = await readBrowserMetadata(page, context);
      diagnosticEvent({ family: 'runtime', type: 'diagnostic.runtime', kind: 'browser', metadata }, false);
    } catch { diagnosticIncomplete = true; }
    const pending: Promise<void>[] = [];
    let finalRateLimit = false;
    let recognizedResponses = 0;
    let discardedResponses = 0;
    let responseReadError: unknown;
    let hasNextPage = true;
    let latestIds = 0;
    let captureSignal: Deferred<import('./scraper-types.js').CaptureSignal> | undefined;
    const collect = async (evidence: NetworkEvidence): Promise<void> => {
      const bodyBytes = Buffer.byteLength(evidence.body ?? '', 'utf8');
      const chainKey = evidence.hops?.[0]?.url ?? evidence.url;
      const existingIndex = networkEvidence.findIndex((existing) => (existing.hops?.[0]?.url ?? existing.url) === chainKey);
      if (existingIndex >= 0) {
        const existing = networkEvidence[existingIndex];
        if ((existing.hops?.length ?? 0) >= (evidence.hops?.length ?? 0)) return;
        if (networkEvidenceBodyBytes - Buffer.byteLength(existing.body ?? '', 'utf8') + bodyBytes > MAX_NETWORK_EVIDENCE_BODY_BYTES) {
          diagnosticIncomplete = true;
          return;
        }
        networkEvidenceBodyBytes -= Buffer.byteLength(existing.body ?? '', 'utf8');
        networkEvidence.splice(existingIndex, 1);
      } else if (networkEvidence.length >= MAX_NETWORK_EVIDENCE_COUNT) return;
      if (networkEvidenceBodyBytes + bodyBytes > MAX_NETWORK_EVIDENCE_BODY_BYTES) {
        diagnosticIncomplete = true;
        return;
      }
      evidence.classification = classifyNetworkEvidence(evidence);
      networkEvidence.push(evidence);
      networkEvidenceBodyBytes += bodyBytes;
    };
    const ingestBatch = async (batch: import('./scraper-types.js').ParsedBatch): Promise<void> => {
      for (const ad of batch.ads) {
        if (sourceIds.size >= maxSourceAds || sourceIds.has(ad.ad_archive_id)) continue;
        sourceIds.add(ad.ad_archive_id); latestIds++;
        records.push(...normalizeAndFingerprintAd(ad));
      }
      logger({ type: 'batch', query: request.query, sourceCount: sourceIds.size, count: records.length });
      if (latestIds > 0 && options.onBatch) await options.onBatch(records);
    };
    const collectResponse = async (response: BrowserPageResponse): Promise<void> => {
      try {
        const request = response.request?.();
        if (!isEligibleDocument(request)) return;
        const status = response.status?.();
        const headers = response.headers ? response.headers() : {};
        const contentType = headers['content-type'] ?? headers['Content-Type'];
        const isHtml = Boolean(contentType && /text\/html|application\/xhtml\+xml/i.test(contentType));
        const isHttpError = status !== undefined && status >= 400 && status < 600;
        const blockStatus = status !== undefined && ([403, 429, 451].includes(status) || status >= 500);
        if (blockStatus) httpBlock = true;
        const isTextualError = Boolean(contentType && /text\//i.test(contentType));
        const body = status !== undefined && status >= 300 && status < 400 ? undefined : (isHtml || (isHttpError && isTextualError)) && response.text ? await response.text() : undefined;
        const hops = request ? await redirectHops(request) : [];
        await collect(buildNetworkEvidence({ responsePresent: true, status, contentType, url: response.url(), body, hops, kind: 'document', bodyLimitBytes: networkEvidenceBodyLimitBytes }));
        diagnosticEvent({ family: 'navigation', type: 'diagnostic.navigation', url: response.url(), status, contentType, resourceType: request?.resourceType?.(), redirectCount: hops.length }, false);
        const blockText = `${response.url()} ${body ?? ''}`;
        if (blockStatus || /rd_challenge|challenge|blocked|forbidden/i.test(blockText)) { domSignals.challenge = true; captureSignal?.resolve('challenge_or_http_block'); return; }
        if (/captcha|log in|login|inicia sesión|checkpoint/i.test(blockText)) { domSignals.captcha = /captcha/i.test(blockText); domSignals.login = !domSignals.captcha; captureSignal?.resolve('captcha_or_login'); return; }
        if (isHttpError) { captureSignal?.resolve('http_error'); return; }
        if (body) {
          const parsed = parseSsrSearchResultsConnection(body);
          if (parsed.batch) {
            domSignals.ssrResults = parsed.batch.ads.length > 0;
            hasNextPage = parsed.batch.hasNextPage;
            recognizedResponses++;
            await ingestBatch(parsed.batch);
            captureSignal?.resolve('ssr_batch');
          }
        }
      } catch { diagnosticIncomplete = true; }
    };
    const publishNetworkEvidence = (reason: string, evidence: NetworkEvidence | NetworkEvidence[]): boolean => {
      try {
        logger({ type: 'error', query: request.query, message: 'scraper.network_evidence', reason, evidence });
        return true;
      } catch {
        diagnosticIncomplete = true;
        return false;
      }
    };
    page.on('response', (response) => {
      if (!isGraphQlUrl(response.url()) && !isGraphQlEndpoint(response.url())) {
        const task = collectResponse(response); pending.push(task); return;
      }
      const emitEvidence = async (reason: string, error?: unknown): Promise<void> => {
        let body: string | undefined;
        try { body = response.text ? await response.text() : undefined; } catch { body = undefined; }
        const headers = response.headers ? response.headers() : {};
        const contentType = headers['content-type'] ?? headers['Content-Type'];
        const evidence = buildNetworkEvidence({ responsePresent: true, status: response.status?.(), contentType, url: response.url(), body, bodyLimitBytes: networkEvidenceBodyLimitBytes });
        diagnosticEvent({ family: 'graphql', type: 'diagnostic.graphql', status: response.status?.(), responseBytes: Buffer.byteLength(body ?? '', 'utf8'), classification: reason }, false);
        if (publishNetworkEvidence(reason, evidence)) latestEvidence = evidence;
      };
      const task = response.json().then(async (payload) => {
        const parsed = parseGraphQlResponse(payload);
        if (parsed.finalRateLimit) { finalRateLimit = true; captureSignal?.resolve('http_error'); return; }
        if (!parsed.batch) {
          discardedResponses++;
          await emitEvidence('unrecognized_response');
          return;
        }
        recognizedResponses++;
        hasNextPage = parsed.batch.hasNextPage;
        await ingestBatch(parsed.batch);
        captureSignal?.resolve(parsed.classification === 'empty' ? 'confirmed_empty' : 'recognized_batch');
      }).catch(async (error) => {
        discardedResponses++;
        responseReadError = error;
        await emitEvidence('response_read_error', error);
      });
      pending.push(task);
    });
    page.on('requestfailed', (request: BrowserPageRequest) => {
      const task = (async () => {
        try {
          if (!isEligibleDocument(request)) return;
           const failureText = request.failure?.()?.errorText;
           networkFailure = true;
           diagnosticEvent({ family: 'runtime', type: 'diagnostic.runtime', kind: 'requestfailed', message: sanitizeDiagnosticText(failureText ?? 'request failed') }, true);
          await collect(buildNetworkEvidence({ responsePresent: false, url: request.url(), failureText, kind: 'network_failure' }));
        } catch { diagnosticIncomplete = true; }
      })();
      pending.push(task);
    });
    installRuntimeAdapters(page, (message) => diagnosticEvent(message, message.kind === 'pageerror'));
    const url = buildSearchUrl(request);
    logger({ type: 'search', query: request.query, message: 'search.started' });
    let retryIndex = 0;
    const action = async (work: () => Promise<unknown>, deadline?: number, beforeSemanticCapture?: () => Promise<void>): Promise<import('./scraper-types.js').CaptureSignal> => {
      while (true) {
        try {
          latestIds = 0;
          captureSignal = createDeferred<import('./scraper-types.js').CaptureSignal>();
          await waitForThrottle(sleep, random);
          await work();
          await Promise.all(pending.splice(0));
          if (beforeSemanticCapture) {
            await beforeSemanticCapture();
            await Promise.all(pending.splice(0));
          }
          const signal = await waitForSemanticCapture(captureSignal.promise, deadline === undefined ? captureTimeoutMs : Math.max(0, deadline - clock.now()));
          await Promise.all(pending.splice(0));
          return signal;
        }
        catch (error) {
          const delay = await waitForRetry(sleep, retryIndex++);
          if (delay === null) { exhaustedRetries = true; status = 'incompleta'; stopReason = 'retries_exhausted'; throw error; }
          logger({ type: 'retry', query: request.query, retry: retryIndex, delayMs: delay, error: errorMessage(error) });
        }
      }
    };
    const initialDeadline = clock.now() + captureTimeoutMs;
    let bootstrapAttempted = false;
    const runBootstrap = async (): Promise<void> => {
      if (bootstrapAttempted || domSignals.challenge || domSignals.captcha || domSignals.login || httpBlock || finalRateLimit) return;
      bootstrapAttempted = true;
      const phaseStarted = clock.now();
      diagnosticEvent({ family: 'navigation', type: 'diagnostic.navigation', name: `${phaseNames.bootstrap}.started`, phase: 'scroll', operation: 'bootstrap', outcome: 'started' }, false);
      if (!page) {
        diagnosticEvent({ family: 'navigation', type: 'diagnostic.navigation', name: `${phaseNames.bootstrap}.failed`, phase: 'scroll', operation: 'bootstrap', outcome: 'failed', cause: 'page_unavailable', durationMs: clock.now() - phaseStarted }, true);
        return;
      }
      try {
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        diagnosticEvent({ family: 'navigation', type: 'diagnostic.navigation', name: `${phaseNames.bootstrap}.completed`, phase: 'scroll', operation: 'bootstrap', outcome: 'succeeded', durationMs: clock.now() - phaseStarted }, false);
      } catch (error) {
        diagnosticEvent({ family: 'navigation', type: 'diagnostic.navigation', name: `${phaseNames.bootstrap}.failed`, phase: 'scroll', operation: 'bootstrap', outcome: 'failed', cause: sanitizeDiagnosticText(errorMessage(error)), durationMs: clock.now() - phaseStarted }, true);
      }
    };
    const initialStarted = clock.now();
    diagnosticEvent({ family: 'navigation', type: 'diagnostic.navigation', name: `${phaseNames.initial_goto}.started`, phase: 'navigation', operation: 'initial_goto', outcome: 'started' }, false);
    let initialSignal: import('./scraper-types.js').CaptureSignal;
    try {
      initialSignal = await action(() => page ? page.goto(url) : Promise.reject(new Error('page unavailable')), initialDeadline, runBootstrap);
      diagnosticEvent({ family: 'navigation', type: 'diagnostic.navigation', name: `${phaseNames.initial_goto}.completed`, phase: 'navigation', operation: 'initial_goto', outcome: 'succeeded', signal: initialSignal, durationMs: clock.now() - initialStarted }, false);
    } catch (error) {
      diagnosticEvent({ family: 'navigation', type: 'diagnostic.navigation', name: `${phaseNames.initial_goto}.failed`, phase: 'navigation', operation: 'initial_goto', outcome: 'failed', cause: page ? sanitizeDiagnosticText(errorMessage(error)) : 'page_unavailable', durationMs: clock.now() - initialStarted }, true);
      throw error;
    }
    if (initialSignal === 'challenge_or_http_block') {
      await sleep(1500);
      const recoveryDeadline = clock.now() + captureTimeoutMs;
      // The first block is retained in evidence, but must not condemn a valid second load.
      httpBlock = false;
      domSignals.challenge = false;
      captureSignal = createDeferred<import('./scraper-types.js').CaptureSignal>();
      let recoveryStarted = false;
      try {
        const phaseStarted = clock.now();
        diagnosticEvent({ family: 'navigation', type: 'diagnostic.navigation', name: `${phaseNames.recovery_reload}.started`, phase: 'navigation', operation: 'recovery_reload', outcome: 'started' }, false);
        if (!page) throw new Error('page_unavailable');
        if (!page.reload) throw new Error('page.reload unavailable');
        await page.reload();
        diagnosticEvent({ family: 'navigation', type: 'diagnostic.navigation', name: `${phaseNames.recovery_reload}.completed`, phase: 'navigation', operation: 'recovery_reload', outcome: 'succeeded', durationMs: clock.now() - phaseStarted }, false);
        recoveryStarted = true;
      } catch (error) {
        diagnosticEvent({ family: 'navigation', type: 'diagnostic.navigation', name: `${phaseNames.recovery_reload}.failed`, phase: 'navigation', operation: 'recovery_reload', outcome: 'failed', cause: !page ? 'page_unavailable' : sanitizeDiagnosticText(errorMessage(error)), durationMs: 0 }, true);
        try {
          const phaseStarted = clock.now();
          diagnosticEvent({ family: 'navigation', type: 'diagnostic.navigation', name: `${phaseNames.recovery_goto}.started`, phase: 'navigation', operation: 'recovery_goto', outcome: 'started' }, false);
          if (!page) throw new Error('page_unavailable');
          await page.goto(url);
          diagnosticEvent({ family: 'navigation', type: 'diagnostic.navigation', name: `${phaseNames.recovery_goto}.completed`, phase: 'navigation', operation: 'recovery_goto', outcome: 'succeeded', durationMs: clock.now() - phaseStarted }, false);
          recoveryStarted = true;
        } catch (fallbackError) {
          diagnosticEvent({ family: 'navigation', type: 'diagnostic.navigation', name: `${phaseNames.recovery_goto}.failed`, phase: 'navigation', operation: 'recovery_goto', outcome: 'failed', cause: !page ? 'page_unavailable' : sanitizeDiagnosticText(errorMessage(fallbackError)), durationMs: 0 }, true);
          challengeRecoveryFailed = true;
          status = 'bloqueada';
          stopReason = 'unrecognized_response';
          initialSignal = 'challenge_or_http_block';
          logger({ type: 'blocked', query: request.query, reason: 'challenge_recovery_failed' });
        }
      }
      if (recoveryStarted) {
        await Promise.all(pending.splice(0));
        initialSignal = await waitForSemanticCapture(captureSignal.promise, Math.max(0, recoveryDeadline - clock.now()));
        if (initialSignal === 'challenge_or_http_block') {
          challengeRecoveryFailed = true;
          status = 'bloqueada';
          stopReason = 'unrecognized_response';
          logger({ type: 'blocked', query: request.query, reason: 'challenge_recovery_failed' });
        }
      }
    }
    if (initialSignal === 'challenge_or_http_block' && !challengeRecoveryFailed) { status = 'bloqueada'; stopReason = 'unrecognized_response'; logger({ type: 'blocked', query: request.query, reason: 'challenge_or_http_block' }); }
    if (initialSignal === 'http_error') { status = 'incompleta'; stopReason = 'error'; }
    if (initialSignal === 'captcha_or_login') { status = 'bloqueada'; stopReason = 'unrecognized_response'; }
    if (finalRateLimit) { status = 'bloqueada'; stopReason = 'rate_limit'; logger({ type: 'blocked', query: request.query, reason: stopReason }); }
    while (!finalRateLimit && status !== 'bloqueada' && initialSignal !== 'timeout' && hasNextPage && sourceIds.size < maxSourceAds && latestIds > 0) {
      const previousCount = sourceIds.size;
      const phaseStarted = clock.now();
      diagnosticEvent({ family: 'navigation', type: 'diagnostic.navigation', name: `${phaseNames.pagination}.started`, phase: 'scroll', operation: 'pagination', outcome: 'started' }, false);
      try {
        if (!page) throw new Error('page_unavailable');
        const paginationPage = page;
        initialSignal = await action(() => paginationPage.evaluate(() => window.scrollTo(0, document.body.scrollHeight)));
        diagnosticEvent({ family: 'navigation', type: 'diagnostic.navigation', name: `${phaseNames.pagination}.completed`, phase: 'scroll', operation: 'pagination', outcome: 'succeeded', signal: initialSignal, durationMs: clock.now() - phaseStarted }, false);
      } catch (error) {
        diagnosticEvent({ family: 'navigation', type: 'diagnostic.navigation', name: `${phaseNames.pagination}.failed`, phase: 'scroll', operation: 'pagination', outcome: 'failed', cause: !page ? 'page_unavailable' : sanitizeDiagnosticText(errorMessage(error)), durationMs: clock.now() - phaseStarted }, true);
        throw error;
      }
      if (finalRateLimit) { status = 'bloqueada'; stopReason = 'rate_limit'; logger({ type: 'blocked', query: request.query, reason: stopReason }); break; }
      if (sourceIds.size >= maxSourceAds) { stopReason = 'ad_limit'; break; }
      if (sourceIds.size === previousCount || latestIds === 0) { stopReason = 'no_new_ads'; break; }
    }
    if (!finalRateLimit && sourceIds.size >= maxSourceAds) stopReason = 'ad_limit';
    if (!finalRateLimit && !hasNextPage) stopReason = 'end_of_results';
    if (!finalRateLimit && status !== 'bloqueada' && initialSignal !== 'http_error' && (recognizedResponses === 0 || discardedResponses > 0 || initialSignal === 'timeout')) {
      status = 'incompleta';
      stopReason = recognizedResponses === 0 && discardedResponses === 0 ? 'empty_capture' : 'unrecognized_response';
      if (stopReason === 'empty_capture') {
        const evidence = networkEvidence.length > 0
          ? networkEvidence
          : buildNetworkEvidence({ responsePresent: false, url: page?.url?.(), bodyLimitBytes: networkEvidenceBodyLimitBytes });
        if (publishNetworkEvidence('empty_capture', evidence)) {
          if (Array.isArray(evidence)) latestEvidence = evidence[evidence.length - 1];
          else latestEvidence = evidence;
        } else {
          latestEvidence = undefined;
          networkEvidence.length = 0;
        }
      }
    }
  } catch (error) {
    primaryError = error;
    logger({ type: 'error', query: request.query, message: 'scraper.error', error, stopReason });
    if (!exhaustedRetries) { status = 'incompleta'; stopReason = 'error'; }
    diagnosticEvent({ family: 'runtime', type: 'diagnostic.runtime', kind: 'pageerror', message: sanitizeDiagnosticText(errorMessage(error)) }, true);
  } finally {
    if (page) {
      try {
        const observed = await readDiagnosticSignals(page, { ...domSignals, resultCount: records.length });
        Object.assign(domSignals, observed);
      } catch { diagnosticIncomplete = true; }
    } else {
      diagnosticIncomplete = true;
    }
    domSignals.resultCount = Math.max(domSignals.resultCount, records.length);
    const primary = classifyDiagnostic(domSignals, networkFailure, httpBlock);
    const finalStopReason = stopReason as StopReason;
    const trigger: DiagnosticTrigger | undefined = finalStopReason === 'rate_limit'
      ? 'rate_limit'
      : finalStopReason === 'empty_capture'
        ? 'empty_capture'
        : finalStopReason === 'unrecognized_response'
          ? 'unrecognized_response'
          : finalStopReason === 'error'
            ? 'error'
            : finalStopReason === 'retries_exhausted'
              ? 'retries_exhausted'
              : primary === 'challenge_or_http_block'
                ? 'challenge'
                : primary === 'captcha'
                  ? 'captcha'
                  : primary === 'login_required'
                    ? 'login_required'
                    : primary === 'unknown' && records.length === 0 ? 'unknown' : undefined;
    diagnosticEvent({ family: 'dom', type: 'diagnostic.dom', signals: domSignals }, Boolean(trigger));
    diagnosticEvent({ family: 'summary', type: 'diagnostic.summary', primary, secondary: [], signals: domSignals, durationMs: clock.now() - started, eventCount: diagnosticEventCount + 1, droppedEvents: diagnosticState?.droppedDiagnosticEvents ?? 0, diagnosticIncomplete: diagnosticIncomplete || Boolean(diagnosticState?.diagnosticIncomplete) || Boolean(trigger && options.diagnosticsEnabled === false) }, Boolean(trigger));
    for (const [name, resource] of [['page', page], ['context', context], ['browser', browser]] as const) {
      if (!resource) continue;
      try { await resource.close(); } catch (error) { logger({ type: 'finish', query: request.query, cleanupError: `${name}: ${errorMessage(error)}` }); }
    }
  }
  const diagnostic = primaryError !== undefined
    ? sanitizeExtractionError(primaryError, records.length > 0)
      : stopReason === 'unrecognized_response' || stopReason === 'empty_capture'
         ? captureDiagnostic(request, records.length > 0, latestEvidence, networkEvidence, diagnosticIncomplete, challengeRecoveryFailed)
      : undefined;
  const result = { records, status, stopReason, sourceCount: sourceIds.size, extractionStatus: extractionStatusFor(primaryError !== undefined || stopReason === 'unrecognized_response' || stopReason === 'empty_capture', records.length), ...(diagnostic ? { diagnostic } : {}) };
  logger({ type: 'finish', query: request.query, count: records.length, durationMs: clock.now() - started, status, stopReason });
  return result;
}

function installRuntimeAdapters(page: BrowserPage, emit: (event: Record<string, unknown>) => void): void {
  if (page.onConsole && page.onPageError) {
    page.onConsole((message) => emit({ family: 'runtime', type: 'diagnostic.runtime', kind: 'console', name: sanitizeDiagnosticText(message.type?.() ?? 'log'), message: sanitizeDiagnosticText(message.text?.() ?? '') }));
    page.onPageError((error) => emit({ family: 'runtime', type: 'diagnostic.runtime', kind: 'pageerror', message: sanitizeDiagnosticText(error.message), name: error.name }));
    return;
  }
  const realPageObject = page as unknown as { context?: () => unknown; on(event: string, listener: (value: unknown) => void): void };
  if (typeof realPageObject.context !== 'function') return;
  const realPage = realPageObject;
  realPage.on('console', (message) => {
    const value = message as { type?: () => string; text?: () => string };
    emit({ family: 'runtime', type: 'diagnostic.runtime', kind: 'console', name: sanitizeDiagnosticText(value.type?.() ?? 'log'), message: sanitizeDiagnosticText(value.text?.() ?? '') });
  });
  realPage.on('pageerror', (error) => {
    const value = error as Error;
    emit({ family: 'runtime', type: 'diagnostic.runtime', kind: 'pageerror', message: sanitizeDiagnosticText(value.message), name: value.name });
  });
}

async function readDiagnosticSignals(page: BrowserPage, fallback: DiagnosticDomSignals): Promise<DiagnosticDomSignals> {
  if (page.diagnosticSignals) return page.diagnosticSignals();
  const realPageObject = page as unknown as { context?: () => unknown; evaluate(script: () => unknown): Promise<unknown> };
  if (typeof realPageObject.context !== 'function') return fallback;
  const realPage = realPageObject;
  const value = await realPage.evaluate(() => {
    const text = document.body?.innerText ?? '';
    const resultCount = document.querySelectorAll('[role="article"], [data-testid*="ad_archive_id"]').length;
    return { challenge: /challenge|unusual activity|blocked/i.test(text), captcha: /captcha/i.test(text), login: /log in|inicia sesión|iniciar sesión/i.test(text), ssrResults: resultCount > 0, explicitEmpty: /no results|sin resultados|no ads/i.test(text), shellWithoutResults: Boolean(document.body) && resultCount === 0, resultCount, connectionCount: document.querySelectorAll('[data-testid*="connection"], [role="article"]').length };
  });
  return value && typeof value === 'object' ? { ...fallback, ...(value as Partial<DiagnosticDomSignals>) } : fallback;
}

async function readBrowserMetadata(page: BrowserPage, context: BrowserContext): Promise<Record<string, unknown>> {
  if (page.browserMetadata) return page.browserMetadata() as Promise<Record<string, unknown>>;
  if (context.diagnosticMetadata) return context.diagnosticMetadata() as Promise<Record<string, unknown>>;
  const realPageObject = page as unknown as { context?: () => unknown; evaluate(script: () => unknown): Promise<unknown> };
  if (typeof realPageObject.context !== 'function') return {};
  const realPage = realPageObject;
  const value = await realPage.evaluate(() => ({ locale: navigator.language, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, webdriver: navigator.webdriver === true, viewport: { width: window.innerWidth, height: window.innerHeight }, cookieNames: document.cookie.split(';').map((item) => item.split('=')[0].trim()).filter(Boolean) }));
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function captureDiagnostic(request: ScrapeRequest, hasRecords: boolean, evidence?: NetworkEvidence, networkEvidence: NetworkEvidence[] = [], diagnosticIncomplete = false, challengeRecoveryFailed = false): ExtractionDiagnostic {
  const alternativeSearchUrl = buildSearchUrl(request);
  return {
    userMessage: hasRecords
      ? 'La captura quedó inconclusa; se conservaron resultados parciales. Puede continuar con la búsqueda manual.'
      : 'La captura quedó inconclusa y no se recuperaron resultados interpretables. Puede continuar con la búsqueda manual.',
    technicalDetail: challengeRecoveryFailed
      ? 'Meta respondió con un challenge HTTP 403 y la recuperación (reload/goto) no permitió continuar.'
      : 'Meta no devolvió una respuesta GraphQL interpretable durante la ventana de captura.',
    alternativeSearchUrl,
    ...(evidence ? networkEvidenceSummary(evidence) : {}),
    ...(networkEvidence.length ? { networkEvidence: networkEvidence.map(networkEvidenceSummary), classifications: networkEvidence.map((item) => item.classification).filter((item): item is NonNullable<typeof item> => item !== undefined) } : {}),
    ...(diagnosticIncomplete ? { diagnosticIncomplete: true } : {}),
  };
}

function buildSearchUrl(request: ScrapeRequest): string {
  const params = new URLSearchParams();
  params.set('q', request.query); params.set('active_status', 'all'); params.set('ad_type', request.adType); params.set('country', request.country);
  params.set('is_targeted_country', 'false'); params.set('media_type', 'all'); params.set('search_type', 'keyword_unordered');
  params.set('start_date[min]', request.dateFrom); params.set('start_date[max]', request.dateTo);
  return `https://www.facebook.com/ads/library/?${params.toString()}`;
}

type Deferred<T> = { promise: Promise<T>; resolve: (value?: T | PromiseLike<T>) => void; reject: (error: unknown) => void };
function createDeferred<T>(): Deferred<T> {
  let resolve!: (value?: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => { resolve = (value) => resolvePromise(value as T); reject = rejectPromise; });
  return { promise, resolve, reject };
}

async function waitForCaptureWindow(nextGraphQlResponse: Promise<void>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); });
  await Promise.race([nextGraphQlResponse, timeout]);
  if (timer !== undefined) clearTimeout(timer);
}

async function waitForSemanticCapture(signal: Promise<import('./scraper-types.js').CaptureSignal>, timeoutMs: number): Promise<import('./scraper-types.js').CaptureSignal> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<import('./scraper-types.js').CaptureSignal>((resolve) => { timer = setTimeout(() => resolve('timeout'), timeoutMs); });
  const result = await Promise.race([signal, timeout]);
  if (timer !== undefined) clearTimeout(timer);
  return result;
}
