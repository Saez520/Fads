import { describe, expect, it } from 'vitest';
import { fixtureAd, graphqlResponse, rateLimitResponse } from '../fixtures/graphql-response-fixture.js';
import { scrapeMetaAds } from '../../src/scraper/meta-ad-scraper.js';
import type { Browser, BrowserContext, BrowserLauncher, BrowserPage, BrowserPageResponse } from '../../src/scraper/scraper-types.js';

class FakePage implements BrowserPage {
  private listener?: (response: BrowserPageResponse) => void | Promise<void>;
  constructor(private readonly responses: unknown[][], private readonly urls: string[] = []) {}
  on(_event: 'response', listener: (response: BrowserPageResponse) => void | Promise<void>): void { this.listener = listener; }
  async goto(): Promise<void> { this.emit(this.responses.shift() ?? []); }
  async evaluate(): Promise<void> { this.emit(this.responses.shift() ?? []); }
  async close(): Promise<void> {}
  private emit(payloads: unknown[]): void { for (const payload of payloads) this.listener?.({ url: () => this.urls[0] ?? 'https://www.facebook.com/api/graphql/?q=x', json: async () => payload }); }
}
function fakeLauncher(page: BrowserPage): BrowserLauncher {
  const context: BrowserContext = { newPage: async () => page, close: async () => {} };
  const browser: Browser = { newContext: async () => context, close: async () => {} };
  return { launch: async () => browser };
}

describe('Meta Ad scraper', () => {
  it('captures GraphQL batches and closes resources', async () => {
    const page = new FakePage([[graphqlResponse([fixtureAd('1')], true, 'a')], [graphqlResponse([fixtureAd('2')], false, null)]]);
    const result = await scrapeMetaAds({ query: 'diabetes' }, { launcher: fakeLauncher(page), sleep: async () => {}, random: () => 0 });
    expect(result.sourceCount).toBe(2); expect(result.status).toBe('completa'); expect(result.stopReason).toBe('end_of_results');
  });
  it('stops immediately on final rate limit and retains partial records', async () => {
    const page = new FakePage([[graphqlResponse([fixtureAd('1')], true)], [rateLimitResponse]]);
    const result = await scrapeMetaAds({ query: 'diabetes' }, { launcher: fakeLauncher(page), sleep: async () => {}, random: () => 0 });
    expect(result.status).toBe('bloqueada'); expect(result.records).toHaveLength(1);
  });
});
