import { afterEach, describe, expect, it, vi } from 'vitest';
import { fixtureAd, graphqlResponse, rateLimitResponse } from '../fixtures/graphql-response-fixture.js';
import { scrapeMetaAds } from '../../src/scraper/meta-ad-scraper.js';
import { sanitizeExtractionError, type Browser, type BrowserContext, type BrowserLauncher, type BrowserPage, type BrowserPageResponse } from '../../src/scraper/scraper-types.js';

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
  emit(payloads: unknown[]): void { for (const payload of payloads) this.listener?.({ url: () => 'https://www.facebook.com/api/graphql/?q=x', json: async () => payload }); }
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

describe('Meta Ad scraper', () => {
  it('captures late GraphQL responses inside the injected window', async () => {
    vi.useFakeTimers();
    const page = new InstrumentedPage([[graphqlResponse([fixtureAd('1')], false)]], 0, 25);
    const counters = { contextClose: 0, browserClose: 0 };
    const scraping = scrapeMetaAds({ query: 'diabetes' }, { launcher: fakeLauncher(page, counters), sleep: noWait, random: () => 0 });
    await vi.advanceTimersByTimeAsync(25);
    const result = await scraping;
    expect(result.sourceCount).toBe(1); expect(result.stopReason).toBe('end_of_results');
    expect(page.gotoUrls).toHaveLength(1); expect(page.gotoUrls[0]).toContain('q=diabetes'); expect(page.evaluateCount).toBe(0);
    expect(page.closeCount).toBe(1); expect(counters.contextClose).toBe(1); expect(counters.browserClose).toBe(1);
  });
  it('times out an action without GraphQL and still cleans up', async () => {
    vi.useFakeTimers();
    const page = new InstrumentedPage([[]]); const counters = { contextClose: 0, browserClose: 0 };
    const scraping = scrapeMetaAds({ query: 'x' }, { launcher: fakeLauncher(page, counters), sleep: noWait, random: () => 0, captureTimeoutMs: 10 });
    await vi.advanceTimersByTimeAsync(10);
    const result = await scraping;
    expect(result.sourceCount).toBe(0); expect(page.closeCount).toBe(1); expect(counters.contextClose).toBe(1); expect(counters.browserClose).toBe(1);
  });
  it('stops on no-new, without an extra scroll', async () => {
    const page = new InstrumentedPage([[graphqlResponse([fixtureAd('1')], true)], [graphqlResponse([fixtureAd('1')], true)]]);
    const result = await scrapeMetaAds({ query: 'x' }, { launcher: fakeLauncher(page, { contextClose: 0, browserClose: 0 }), sleep: noWait, random: () => 0 });
    expect(result.stopReason).toBe('no_new_ads'); expect(page.evaluateCount).toBe(1);
  });
  it('cuts at 1,500 source ads and does not scroll', async () => {
    const ads = Array.from({ length: 1501 }, (_, index) => fixtureAd(String(index)));
    const page = new InstrumentedPage([[graphqlResponse(ads, true)]]);
    const result = await scrapeMetaAds({ query: 'x' }, { launcher: fakeLauncher(page, { contextClose: 0, browserClose: 0 }), sleep: noWait, random: () => 0 });
    expect(result.sourceCount).toBe(1500); expect(result.stopReason).toBe('ad_limit'); expect(page.evaluateCount).toBe(0);
  });
  it('retains partial records and stops on final rate limit', async () => {
    const page = new InstrumentedPage([[graphqlResponse([fixtureAd('1')], true)], [rateLimitResponse]]);
    const result = await scrapeMetaAds({ query: 'x' }, { launcher: fakeLauncher(page, { contextClose: 0, browserClose: 0 }), sleep: noWait, random: () => 0 });
    expect(result.status).toBe('bloqueada'); expect(result.stopReason).toBe('rate_limit'); expect(result.records).toHaveLength(1); expect(page.evaluateCount).toBe(1);
  });
  it('uses all three backoffs and no fourth attempt', async () => {
    const page = new InstrumentedPage([[], [], [], []], 4); const waits: number[] = [];
    const result = await scrapeMetaAds({ query: 'x' }, { launcher: fakeLauncher(page, { contextClose: 0, browserClose: 0 }), sleep: async (ms) => { waits.push(ms); }, random: () => 0 });
    expect(result.status).toBe('incompleta'); expect(result.stopReason).toBe('retries_exhausted'); expect(page.gotoUrls).toHaveLength(4);
    expect(waits.filter((ms) => [60000, 120000, 240000].includes(ms))).toEqual([60000, 120000, 240000]);
  });
});
