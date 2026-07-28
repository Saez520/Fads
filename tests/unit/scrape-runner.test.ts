import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodeNormalizedAd } from '../../src/data/json-codec.js';
import { fixtureAd, graphqlResponse, rateLimitResponse } from '../fixtures/graphql-response-fixture.js';
import { decodeScrapeEnvelope } from '../../src/scraper/scrape-output.js';
import { runScrape } from '../../src/scraper/scrape-runner.js';
import type { Browser, BrowserContext, BrowserLauncher, BrowserPage, BrowserPageResponse, ResultWriter, ScrapeEnvelope } from '../../src/scraper/scraper-types.js';
import { validateScrapeRequest } from '../../src/scraper/scraper-types.js';

class RunnerPage implements BrowserPage {
  private listener?: (response: BrowserPageResponse) => void | Promise<void>;
  constructor(private readonly payloads: unknown[][]) {}
  on(_event: 'response', listener: (response: BrowserPageResponse) => void | Promise<void>): void { this.listener = listener; }
  async goto(): Promise<void> { this.emit(this.payloads.shift() ?? []); }
  async evaluate(): Promise<void> { this.emit(this.payloads.shift() ?? []); }
  async close(): Promise<void> {}
  private emit(payloads: unknown[]): void { for (const payload of payloads) this.listener?.({ url: () => 'https://www.facebook.com/api/graphql/?q=x', json: async () => payload }); }
}
function launcher(page: RunnerPage): BrowserLauncher {
  const context: BrowserContext = { newPage: async () => page, close: async () => {} };
  const browser: Browser = { newContext: async () => context, close: async () => {} };
  return { launch: async () => browser };
}
class MemoryWriter implements ResultWriter { envelopes: ScrapeEnvelope[] = []; async write(envelope: ScrapeEnvelope): Promise<void> { this.envelopes.push(envelope); } }
const options = (page: RunnerPage, writer: ResultWriter) => ({ launcher: launcher(page), writer, sleep: async () => {}, random: () => 0 });

describe('scrape runner and persisted output', () => {
  it('publishes snapshots, summary and records compatible with the U1 codec', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'meta-ad-agent-')); const outputPath = join(directory, 'result.json');
    try {
      const envelope = await runScrape({ query: 'diabetes' }, { ...options(new RunnerPage([[graphqlResponse([fixtureAd('1')], false)]]), undefined as never), outputPath });
      const published = decodeScrapeEnvelope(await readFile(outputPath, 'utf8'));
      expect(envelope.summary).toMatchObject({ query: 'diabetes', count: 1, status: 'completa', stopReason: 'end_of_results' });
      expect(published.records).toHaveLength(1); expect(decodeNormalizedAd(JSON.stringify(published.records[0])).exactFingerprint).toBeTruthy();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it('writes a blocked partial and does not reuse records across runs', async () => {
    const writer = new MemoryWriter();
    const blocked = await runScrape({ query: 'x' }, options(new RunnerPage([[graphqlResponse([fixtureAd('1')], true)], [rateLimitResponse]]), writer));
    const isolated = await runScrape({ query: 'x' }, options(new RunnerPage([[graphqlResponse([fixtureAd('2')], false)]]), writer));
    expect(blocked.incomplete).toBe(true); expect(blocked.summary.status).toBe('bloqueada'); expect(blocked.records[0]?.provenance.sourceAdId).toBe('1');
    expect(isolated.incomplete).toBe(false); expect(isolated.records).toHaveLength(1); expect(isolated.records[0]?.provenance.sourceAdId).toBe('2');
    expect(writer.envelopes.some((entry) => entry.incomplete && entry.summary.count === 1)).toBe(true);
  });
  it('rejects filters before browser creation', () => expect(() => validateScrapeRequest({ query: 'x', filters: {} })).toThrow());
});
