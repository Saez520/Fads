import { chromium } from 'playwright';
import { normalizeAndFingerprintAd } from '../domain/fingerprints.js';
import type { NormalizedAdRecord } from '../domain/ad-model.js';
import { isGraphQlEndpoint, parseGraphQlResponse } from './graphql-response-parser.js';
import { waitForRetry } from './retry-policy.js';
import { waitForThrottle } from './timing-policy.js';
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
      const task = response.json().then((payload) => {
        const parsed = parseGraphQlResponse(payload);
        if (parsed.finalRateLimit) { finalRateLimit = true; return; }
        if (!parsed.batch) {
          if (diagnosticsEnabled) {
            discardedResponses++;
            logger({ type: 'error', query: request.query, message: 'scraper.unrecognized_response', reason: 'unrecognized_response', rawResponse: parsed.rawResponse });
          }
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
      }).catch((error) => {
        if (!diagnosticsEnabled) throw error;
        discardedResponses++;
        responseReadError = error;
        logger({ type: 'error', query: request.query, message: 'scraper.unrecognized_response', reason: 'unrecognized_response', rawResponse: { responseReadError: errorMessage(error), rawResponse: null } });
      });
      pending.push(task);
    });
    const url = `https://www.facebook.com/ads/library/?${new URLSearchParams({ q: request.query }).toString()}`;
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
    if (diagnosticsEnabled && !finalRateLimit && (recognizedResponses === 0 || discardedResponses > 0)) {
      status = 'incompleta';
      stopReason = 'unrecognized_response';
      if (discardedResponses === 0) logger({ type: 'error', query: request.query, message: 'scraper.empty_capture', reason: 'empty_capture', rawResponse: responseReadError ? { responseReadError: errorMessage(responseReadError), rawResponse: null } : null });
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
    : diagnosticsEnabled && stopReason === 'unrecognized_response'
      ? captureDiagnostic(request.query, records.length > 0)
      : undefined;
  const result = { records, status, stopReason, sourceCount: sourceIds.size, extractionStatus: extractionStatusFor(primaryError !== undefined || stopReason === 'unrecognized_response', records.length), ...(diagnostic ? { diagnostic } : {}) };
  logger({ type: 'finish', query: request.query, count: records.length, durationMs: clock.now() - started, status, stopReason });
  return result;
}

function captureDiagnostic(query: string, hasRecords: boolean): ExtractionDiagnostic {
  const alternativeSearchUrl = `https://www.facebook.com/ads/library/?${new URLSearchParams({ q: query }).toString()}`;
  return {
    userMessage: hasRecords
      ? 'La captura quedó inconclusa; se conservaron resultados parciales. Puede continuar con la búsqueda manual.'
      : 'La captura quedó inconclusa y no se recuperaron resultados interpretables. Puede continuar con la búsqueda manual.',
    technicalDetail: 'Meta no devolvió una respuesta GraphQL interpretable durante la ventana de captura.',
    alternativeSearchUrl,
  };
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
