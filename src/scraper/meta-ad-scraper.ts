import { chromium } from 'playwright';
import { normalizeAndFingerprintAd } from '../domain/fingerprints.js';
import type { NormalizedAdRecord } from '../domain/ad-model.js';
import { isGraphQlEndpoint, parseGraphQlResponse } from './graphql-response-parser.js';
import { waitForRetry } from './retry-policy.js';
import { waitForThrottle } from './timing-policy.js';
import { buildNetworkEvidence, networkEvidenceSummary, type NetworkEvidence } from './network-evidence.js';
import type { AdInput } from '../domain/ad-input.js';
import { extractionStatusFor, sanitizeExtractionError, type Browser, type BrowserLauncher, type BrowserPage, type CaptureWindow, type Clock, type ExtractionDiagnostic, type ExtractionStatus, type Logger, type MetaAdScraperOptions, type Random, type ScrapeRequest, type ScrapeStatus, type Sleeper, type StopReason } from './scraper-types.js';
export type { MetaAdScraperOptions } from './scraper-types.js';

const defaultLauncher: BrowserLauncher = { launch: (options) => chromium.launch(options) as unknown as Promise<Browser> };
const defaultSleep: Sleeper = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const defaultClock: Clock = { now: () => performance.now() };
const defaultRandom: Random = () => Math.random();

export interface ScraperResult { records: NormalizedAdRecord[]; status: ScrapeStatus; stopReason: StopReason; sourceCount: number; extractionStatus: ExtractionStatus; diagnostic?: ExtractionDiagnostic }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }

export async function scrapeMetaAds(request: ScrapeRequest, options: MetaAdScraperOptions = {}): Promise<ScraperResult> {
  const launcher = options.launcher ?? defaultLauncher;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? defaultRandom;
  const clock = options.clock ?? defaultClock;
  const logger = options.logger ?? (() => undefined);
  const captureTimeoutMs = options.captureTimeoutMs ?? 2000;
  const captureWindow: CaptureWindow = options.captureWindow ?? ((nextGraphQlResponse) => waitForCaptureWindow(nextGraphQlResponse, captureTimeoutMs));
  const maxSourceAds = options.maxSourceAds ?? 1500;
  const diagnosticsEnabled = options.diagnosticsEnabled ?? process.env.NODE_ENV !== 'production';
  const networkEvidenceBodyLimitBytes = options.networkEvidenceBodyLimitBytes ?? 32 * 1024;
  const records: NormalizedAdRecord[] = [];
  const sourceIds = new Set<string>();
  const started = clock.now();
  let browser: Browser | undefined;
  let context: { newPage(): Promise<BrowserPage>; close(): Promise<void> } | undefined;
  let page: BrowserPage | undefined;
  let status: ScrapeStatus = 'completa';
  let stopReason: StopReason = 'end_of_results';
  let exhaustedRetries = false;
  let primaryError: unknown;
  let latestEvidence: NetworkEvidence | undefined;
  logger({ type: 'start', query: request.query });
  try {
    browser = await launcher.launch({ headless: true });
    context = await browser.newContext();
    page = await context.newPage();
    logger({ type: 'browser', query: request.query, message: 'browser.ready' });
    const pending: Promise<void>[] = [];
    let finalRateLimit = false;
    let recognizedResponses = 0;
    let discardedResponses = 0;
    let responseReadError: unknown;
    let hasNextPage = true;
    let latestIds = 0;
    let nextGraphQlResponse: Deferred<void> | undefined;
    page.on('response', (response) => {
      if (!isGraphQlEndpoint(response.url())) return;
      nextGraphQlResponse?.resolve();
      const emitEvidence = async (reason: string, error?: unknown): Promise<void> => {
        let body: string | undefined;
        try { body = response.text ? await response.text() : undefined; } catch { body = undefined; }
        const headers = response.headers ? response.headers() : {};
        const contentType = headers['content-type'] ?? headers['Content-Type'];
        latestEvidence = buildNetworkEvidence({ responsePresent: true, status: response.status?.(), contentType, url: response.url(), body, bodyLimitBytes: networkEvidenceBodyLimitBytes });
        logger({ type: 'error', query: request.query, message: 'scraper.network_evidence', reason, evidence: latestEvidence });
      };
      const task = response.json().then(async (payload) => {
        const parsed = parseGraphQlResponse(payload);
        if (parsed.finalRateLimit) { finalRateLimit = true; return; }
        if (!parsed.batch) {
          discardedResponses++;
          await emitEvidence('unrecognized_response');
          return;
        }
        recognizedResponses++;
        hasNextPage = parsed.batch.hasNextPage;
        for (const ad of parsed.batch.ads) {
          if (sourceIds.size >= maxSourceAds || sourceIds.has(ad.ad_archive_id)) continue;
          sourceIds.add(ad.ad_archive_id); latestIds++;
          records.push(...normalizeAndFingerprintAd(ad));
        }
        logger({ type: 'batch', query: request.query, sourceCount: sourceIds.size, count: records.length });
        if (latestIds > 0 && options.onBatch) return Promise.resolve(options.onBatch(records));
      }).catch(async (error) => {
        discardedResponses++;
        responseReadError = error;
        await emitEvidence('response_read_error', error);
      });
      pending.push(task);
    });
    const url = `https://www.facebook.com/ads/library/?${new URLSearchParams({ q: request.query, country: request.country, ad_type: request.adType, start_date: String(toStartEpoch(request.dateFrom)), end_date: String(toEndEpoch(request.dateTo)) }).toString()}`;
    logger({ type: 'search', query: request.query, message: 'search.started' });
    let retryIndex = 0;
    const action = async (work: () => Promise<unknown>): Promise<void> => {
      while (true) {
        try {
          latestIds = 0;
          nextGraphQlResponse = createDeferred<void>();
          await waitForThrottle(sleep, random);
          await work();
          await Promise.all(pending.splice(0));
          await captureWindow(nextGraphQlResponse.promise);
          await Promise.all(pending.splice(0));
          return;
        }
        catch (error) {
          const delay = await waitForRetry(sleep, retryIndex++);
          if (delay === null) { exhaustedRetries = true; status = 'incompleta'; stopReason = 'retries_exhausted'; throw error; }
          logger({ type: 'retry', query: request.query, retry: retryIndex, delayMs: delay, error: errorMessage(error) });
        }
      }
    };
    await action(() => page!.goto(url));
    if (finalRateLimit) { status = 'bloqueada'; stopReason = 'rate_limit'; logger({ type: 'blocked', query: request.query, reason: stopReason }); }
    while (!finalRateLimit && hasNextPage && sourceIds.size < maxSourceAds && latestIds > 0) {
      const previousCount = sourceIds.size;
      await action(() => page!.evaluate(() => window.scrollTo(0, document.body.scrollHeight)));
      if (finalRateLimit) { status = 'bloqueada'; stopReason = 'rate_limit'; logger({ type: 'blocked', query: request.query, reason: stopReason }); break; }
      if (sourceIds.size >= maxSourceAds) { stopReason = 'ad_limit'; break; }
      if (sourceIds.size === previousCount || latestIds === 0) { stopReason = 'no_new_ads'; break; }
    }
    if (!finalRateLimit && sourceIds.size >= maxSourceAds) stopReason = 'ad_limit';
    if (!finalRateLimit && !hasNextPage) stopReason = 'end_of_results';
    if (!finalRateLimit && (recognizedResponses === 0 || discardedResponses > 0)) {
      status = 'incompleta';
      stopReason = 'unrecognized_response';
      if (discardedResponses === 0) {
        const evidence = buildNetworkEvidence({ responsePresent: false, url: page?.url?.(), bodyLimitBytes: networkEvidenceBodyLimitBytes });
        latestEvidence = evidence;
        logger({ type: 'error', query: request.query, message: 'scraper.network_evidence', reason: 'empty_capture', evidence });
      }
    }
  } catch (error) {
    primaryError = error;
    logger({ type: 'error', query: request.query, message: 'scraper.error', error, stopReason });
    if (!exhaustedRetries) { status = 'incompleta'; stopReason = 'error'; }
  } finally {
    for (const [name, resource] of [['page', page], ['context', context], ['browser', browser]] as const) {
      if (!resource) continue;
      try { await resource.close(); } catch (error) { logger({ type: 'finish', query: request.query, cleanupError: `${name}: ${errorMessage(error)}` }); }
    }
  }
  const diagnostic = primaryError !== undefined
    ? sanitizeExtractionError(primaryError, records.length > 0)
     : stopReason === 'unrecognized_response'
        ? captureDiagnostic(request, records.length > 0, latestEvidence)
      : undefined;
  const result = { records, status, stopReason, sourceCount: sourceIds.size, extractionStatus: extractionStatusFor(primaryError !== undefined || stopReason === 'unrecognized_response', records.length), ...(diagnostic ? { diagnostic } : {}) };
  logger({ type: 'finish', query: request.query, count: records.length, durationMs: clock.now() - started, status, stopReason });
  return result;
}

function captureDiagnostic(request: ScrapeRequest, hasRecords: boolean, evidence?: NetworkEvidence): ExtractionDiagnostic {
  const alternativeSearchUrl = `https://www.facebook.com/ads/library/?${new URLSearchParams({ q: request.query, country: request.country, ad_type: request.adType, start_date: String(toStartEpoch(request.dateFrom)), end_date: String(toEndEpoch(request.dateTo)) }).toString()}`;
  return {
    userMessage: hasRecords
      ? 'La captura quedó inconclusa; se conservaron resultados parciales. Puede continuar con la búsqueda manual.'
      : 'La captura quedó inconclusa y no se recuperaron resultados interpretables. Puede continuar con la búsqueda manual.',
    technicalDetail: 'Meta no devolvió una respuesta GraphQL interpretable durante la ventana de captura.',
    alternativeSearchUrl,
    ...(evidence ? networkEvidenceSummary(evidence) : {}),
  };
}

function toStartEpoch(value: string): number { const [year, month, day] = value.split('-').map(Number); return Date.UTC(year, month - 1, day) / 1000; }
function toEndEpoch(value: string): number { return toStartEpoch(value) + 86_399; }

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
