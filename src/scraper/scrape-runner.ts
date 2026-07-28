import type { NormalizedAdRecord } from '../domain/ad-model.js';
import { validateScrapeRequest } from './scraper-types.js';
import { createScrapeEnvelope } from './scrape-output.js';
import { AtomicJsonResultWriter } from './json-result-writer.js';
import { scrapeMetaAds, type MetaAdScraperOptions } from './meta-ad-scraper.js';
import { sanitizeExtractionError, type Clock, type Logger, type ResultWriter, type ScrapeEnvelope, type ScrapeRequest, type ScrapeSummary } from './scraper-types.js';

export interface ScrapeRunnerOptions extends MetaAdScraperOptions { outputPath?: string; writer?: ResultWriter }
export async function runScrape(input: unknown, options: ScrapeRunnerOptions = {}): Promise<ScrapeEnvelope> {
  const request: ScrapeRequest = validateScrapeRequest(input);
  const writer = options.writer ?? (options.outputPath ? new AtomicJsonResultWriter(options.outputPath) : undefined);
  const clock: Clock = options.clock ?? { now: () => performance.now() };
  const started = clock.now();
  let latestRecords: NormalizedAdRecord[] = [];
  const persist = async (status: 'incompleta', stopReason: 'error', diagnostic = sanitizeExtractionError('Error durante la extracción.', latestRecords.length > 0)): Promise<void> => {
    if (!writer) return;
    const summary: ScrapeSummary = { query: request.query, count: latestRecords.length, status, stopReason, durationMs: clock.now() - started, extractionStatus: latestRecords.length ? 'parcial' : 'fallida', diagnostic };
    await writer.write(createScrapeEnvelope(request.query, latestRecords, summary));
    options.logger?.({ type: 'persist', query: request.query, count: latestRecords.length });
  };
  try {
    const result = await scrapeMetaAds(request, { ...options, onBatch: async (records) => { latestRecords = records; await persist('incompleta', 'error'); await options.onBatch?.(records); } });
    latestRecords = result.records;
    const summary: ScrapeSummary = { query: request.query, count: result.records.length, status: result.status, stopReason: result.stopReason, durationMs: clock.now() - started, extractionStatus: result.extractionStatus, ...(result.diagnostic ? { diagnostic: result.diagnostic } : {}) };
    const envelope = createScrapeEnvelope(request.query, result.records, summary);
    if (writer) await writer.write(envelope);
    return envelope;
  } catch (error) {
    await persist('incompleta', 'error', sanitizeExtractionError(error, latestRecords.length > 0));
    throw error;
  }
}
