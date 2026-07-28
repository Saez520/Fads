import type { NormalizedAdRecord } from '../domain/ad-model.js';
import { decodeNormalizedAd, encodeNormalizedAd } from '../data/json-codec.js';
import type { ScrapeEnvelope, ScrapeSummary } from './scraper-types.js';

export function encodeScrapeEnvelope(envelope: ScrapeEnvelope): string {
  return JSON.stringify({ ...envelope, records: envelope.records.map((record) => JSON.parse(encodeNormalizedAd(record))) });
}
export function decodeScrapeEnvelope(json: string): ScrapeEnvelope {
  const parsed: unknown = JSON.parse(json);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid scrape envelope');
  const value = parsed as Record<string, unknown>;
  if (typeof value.query !== 'string' || !Array.isArray(value.records) || typeof value.incomplete !== 'boolean') throw new Error('Invalid scrape envelope');
  const summary = value.summary as ScrapeSummary;
  if (!summary || summary.query !== value.query || typeof summary.count !== 'number' || typeof summary.durationMs !== 'number') throw new Error('Invalid scrape summary');
  return { query: value.query, records: value.records.map((record) => decodeNormalizedAd(JSON.stringify(record))), summary, incomplete: value.incomplete };
}

export function createScrapeEnvelope(query: string, records: NormalizedAdRecord[], summary: ScrapeSummary): ScrapeEnvelope {
  return { query, records, summary, incomplete: summary.status !== 'completa' };
}
