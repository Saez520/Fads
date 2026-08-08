import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodeNormalizedAd } from '../../src/data/json-codec.js';
import { fixtureAd, graphqlResponse, rateLimitResponse } from '../fixtures/graphql-response-fixture.js';
import { decodeScrapeEnvelope } from '../../src/scraper/scrape-output.js';
import { runScrape } from '../../src/scraper/scrape-runner.js';
import type { Browser, BrowserContext, BrowserLauncher, BrowserPage, BrowserPageRequest, BrowserPageResponse, ResultWriter, ScrapeEnvelope } from '../../src/scraper/scraper-types.js';
import { validateScrapeRequest } from '../../src/scraper/scraper-types.js';
import { ExecutionLogger } from '../../src/mcp/execution-logger.js';

class RunnerPage implements BrowserPage {
  private listener?: (response: BrowserPageResponse) => void | Promise<void>;
  constructor(private readonly payloads: unknown[][], private readonly failGoto = false) {}
  on(event: 'response' | 'requestfailed', listener: ((response: BrowserPageResponse) => void | Promise<void>) | ((request: BrowserPageRequest) => void | Promise<void>)): void { if (event === 'response') this.listener = listener as (response: BrowserPageResponse) => void | Promise<void>; }
  async goto(): Promise<void> { if (this.failGoto) throw new Error('Authorization: Bearer secret-token /Users/local/app.ts'); this.emit(this.payloads.shift() ?? []); }
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
      const envelope = await runScrape({ query: 'diabetes', country: 'CO', dateFrom: '2026-05-07', dateTo: '2026-08-07', adType: 'all' }, { ...options(new RunnerPage([[graphqlResponse([fixtureAd('1')], false)]]), undefined as never), outputPath });
      const published = decodeScrapeEnvelope(await readFile(outputPath, 'utf8'));
      expect(envelope.summary).toMatchObject({ query: 'diabetes', count: 1, status: 'completa', stopReason: 'end_of_results' });
      expect(published.records).toHaveLength(1); expect(decodeNormalizedAd(JSON.stringify(published.records[0])).exactFingerprint).toBeTruthy();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it('logs final persistence after the successful writer call', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runner-log-')); const logger = new ExecutionLogger(root, 'success-task');
    try { const writer = new MemoryWriter(); await runScrape({ query: 'logged', country: 'CO', dateFrom: '2026-05-07', dateTo: '2026-08-07', adType: 'all' }, { ...options(new RunnerPage([[graphqlResponse([fixtureAd('1')], false)]]), writer), logger: logger.scraperLogger() }); expect((await readFile(logger.executionPath, 'utf8')).match(/scraper\.persist/g)).toHaveLength(2); await expect(stat(logger.errorPath)).rejects.toMatchObject({ code: 'ENOENT' }); } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('writes a blocked partial and does not reuse records across runs', async () => {
    const writer = new MemoryWriter();
    const blocked = await runScrape({ query: 'x', country: 'CO', dateFrom: '2026-05-07', dateTo: '2026-08-07', adType: 'all' }, options(new RunnerPage([[graphqlResponse([fixtureAd('1')], true)], [rateLimitResponse]]), writer));
    const isolated = await runScrape({ query: 'x', country: 'CO', dateFrom: '2026-05-07', dateTo: '2026-08-07', adType: 'all' }, options(new RunnerPage([[graphqlResponse([fixtureAd('2')], false)]]), writer));
    expect(blocked.incomplete).toBe(true); expect(blocked.summary.status).toBe('bloqueada'); expect(blocked.records[0]?.provenance.sourceAdId).toBe('1');
    expect(isolated.incomplete).toBe(false); expect(isolated.records).toHaveLength(1); expect(isolated.records[0]?.provenance.sourceAdId).toBe('2');
    expect(writer.envelopes.some((entry) => entry.incomplete && entry.summary.count === 1)).toBe(true);
  });
  it('rejects filters before browser creation', () => expect(() => validateScrapeRequest({ query: 'x', filters: {} })).toThrow());
  it('classifies a capture without an interpretable response as inconclusive', async () => {
    const result = await runScrape({ query: 'empty', country: 'CO', dateFrom: '2026-05-07', dateTo: '2026-08-07', adType: 'all' }, { ...options(new RunnerPage([[]]), undefined as never), captureTimeoutMs: 1 });
     expect(result).toMatchObject({ incomplete: true, extractionStatus: 'fallida', summary: { count: 0, status: 'incompleta', extractionStatus: 'fallida', stopReason: 'empty_capture' } });
    expect(result.diagnostic?.alternativeSearchUrl).toContain('q=empty');
  });
  it('keeps evidence summaries in the persisted envelope without a body', async () => {
    const result = await runScrape({ query: 'empty', country: 'CO', dateFrom: '2026-05-07', dateTo: '2026-08-07', adType: 'all' }, { ...options(new RunnerPage([[]]), undefined as never), captureTimeoutMs: 1 });
    const serialized = JSON.stringify(result);
    expect(result.diagnostic).toMatchObject({ responsePresent: false, evidenceId: expect.any(String), logReference: expect.stringContaining('scraper.network_evidence:') });
    expect(serialized).not.toContain('body');
  });
  it('writes a relative diagnostic reference and metrics to execution logs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runner-diagnostic-log-')); const logger = new ExecutionLogger(root, 'diagnostic-task');
    try {
      await runScrape({ query: 'diagnostic', country: 'CO', dateFrom: '2026-05-07', dateTo: '2026-08-07', adType: 'all' }, { ...options(new RunnerPage([[]]), undefined as never), captureTimeoutMs: 1, logger: logger.scraperLogger() });
      const content = await readFile(logger.executionPath, 'utf8');
      expect(content).toContain('logs/diagnostic.jsonl'); expect(content).toContain('droppedEvents'); expect(content).toContain('diagnosticIncomplete');
      expect(content).not.toContain('authorization');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('decodes legacy envelopes without evidence fields', () => {
    const legacy = JSON.stringify({ query: 'legacy', records: [], summary: { query: 'legacy', count: 0, status: 'completa', stopReason: 'end_of_results', durationMs: 1 }, incomplete: false });
    expect(decodeScrapeEnvelope(legacy)).toMatchObject({ query: 'legacy', incomplete: false });
  });
  it('classifies failure before records and sanitizes the persisted snapshot', async () => {
    const writer = new MemoryWriter();
     const result = await runScrape({ query: 'failed', country: 'CO', dateFrom: '2026-05-07', dateTo: '2026-08-07', adType: 'all' }, options(new RunnerPage([], true), writer));
    expect(result).toMatchObject({ extractionStatus: 'fallida', summary: { count: 0, extractionStatus: 'fallida' } });
    expect(result.diagnostic?.userMessage).toContain('no se recuperaron');
    expect(JSON.stringify(writer.envelopes)).not.toContain('secret-token');
    expect(JSON.stringify(writer.envelopes)).not.toContain('/Users/local');
    const errorRoot = await mkdtemp(join(tmpdir(), 'runner-error-log-')); const logger = new ExecutionLogger(errorRoot, 'failed-task');
     try { await runScrape({ query: 'failed-log', country: 'CO', dateFrom: '2026-05-07', dateTo: '2026-08-07', adType: 'all' }, { ...options(new RunnerPage([], true), writer), logger: logger.scraperLogger() }); } catch { /* expected extraction failure */ }
    expect(await readFile(logger.errorPath, 'utf8')).toContain('stack'); await rm(errorRoot, { recursive: true, force: true });
  });
});
