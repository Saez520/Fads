import { chromium } from 'playwright';
import { normalizeAndFingerprintAd } from '../domain/fingerprints.js';
import type { NormalizedAdRecord } from '../domain/ad-model.js';
import { isGraphQlEndpoint, parseGraphQlResponse } from './graphql-response-parser.js';
import { waitForRetry } from './retry-policy.js';
import { waitForThrottle } from './timing-policy.js';
import type { AdInput } from '../domain/ad-input.js';
import type { Browser, BrowserLauncher, BrowserPage, Clock, Logger, Random, ScrapeRequest, ScrapeStatus, Sleeper, StopReason } from './scraper-types.js';

const defaultLauncher: BrowserLauncher = { launch: (options) => chromium.launch(options) as unknown as Promise<Browser> };
const defaultSleep: Sleeper = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const defaultClock: Clock = { now: () => performance.now() };
const defaultRandom: Random = () => Math.random();

export interface ScraperResult { records: NormalizedAdRecord[]; status: ScrapeStatus; stopReason: StopReason; sourceCount: number }
export interface MetaAdScraperOptions {
  launcher?: BrowserLauncher; sleep?: Sleeper; random?: Random; clock?: Clock; logger?: Logger;
  captureWindow?: () => Promise<void>;
  onBatch?: (records: NormalizedAdRecord[]) => Promise<void> | void; maxSourceAds?: number;
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }

export async function scrapeMetaAds(request: ScrapeRequest, options: MetaAdScraperOptions = {}): Promise<ScraperResult> {
  const launcher = options.launcher ?? defaultLauncher;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? defaultRandom;
  const clock = options.clock ?? defaultClock;
  const logger = options.logger ?? (() => undefined);
  const captureWindow = options.captureWindow ?? (() => new Promise<void>((resolve) => setImmediate(resolve)));
  const maxSourceAds = options.maxSourceAds ?? 1500;
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
    const pending: Promise<void>[] = [];
    let finalRateLimit = false;
    let hasNextPage = true;
    let latestIds = 0;
    page.on('response', (response) => {
      if (!isGraphQlEndpoint(response.url())) return;
      const task = response.json().then((payload) => {
        const parsed = parseGraphQlResponse(payload);
        if (parsed.finalRateLimit) { finalRateLimit = true; return; }
        if (!parsed.batch) return;
        hasNextPage = parsed.batch.hasNextPage;
        for (const ad of parsed.batch.ads) {
          if (sourceIds.size >= maxSourceAds || sourceIds.has(ad.ad_archive_id)) continue;
          sourceIds.add(ad.ad_archive_id); latestIds++;
          records.push(...normalizeAndFingerprintAd(ad));
        }
        logger({ type: 'batch', query: request.query, sourceCount: sourceIds.size, count: records.length });
        if (latestIds > 0 && options.onBatch) return Promise.resolve(options.onBatch(records));
      }).catch((error) => { throw error; });
      pending.push(task);
    });
    const url = `https://www.facebook.com/ads/library/?${new URLSearchParams({ q: request.query }).toString()}`;
    let retryIndex = 0;
    const action = async (work: () => Promise<unknown>): Promise<void> => {
      while (true) {
        try {
          latestIds = 0;
          await waitForThrottle(sleep, random);
          await work();
          await Promise.all(pending.splice(0));
          await captureWindow();
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
    if (finalRateLimit) { status = 'bloqueada'; stopReason = 'rate_limit'; }
    while (!finalRateLimit && hasNextPage && sourceIds.size < maxSourceAds && latestIds > 0) {
      const previousCount = sourceIds.size;
      await action(() => page!.evaluate(() => window.scrollTo(0, document.body.scrollHeight)));
      if (finalRateLimit) { status = 'bloqueada'; stopReason = 'rate_limit'; break; }
      if (sourceIds.size >= maxSourceAds) { stopReason = 'ad_limit'; break; }
      if (sourceIds.size === previousCount || latestIds === 0) { stopReason = 'no_new_ads'; break; }
    }
    if (!finalRateLimit && sourceIds.size >= maxSourceAds) stopReason = 'ad_limit';
    if (!finalRateLimit && !hasNextPage) stopReason = 'end_of_results';
  } catch (error) {
    primaryError = error;
    if (!exhaustedRetries) { status = 'incompleta'; stopReason = 'error'; }
  } finally {
    for (const [name, resource] of [['page', page], ['context', context], ['browser', browser]] as const) {
      if (!resource) continue;
      try { await resource.close(); } catch (error) { logger({ type: 'finish', query: request.query, cleanupError: `${name}: ${errorMessage(error)}` }); }
    }
  }
  const result = { records, status, stopReason, sourceCount: sourceIds.size };
  logger({ type: 'finish', query: request.query, count: records.length, durationMs: clock.now() - started, status, stopReason });
  return result;
}
