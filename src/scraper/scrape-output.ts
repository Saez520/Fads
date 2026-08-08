import type { NormalizedAdRecord } from '../domain/ad-model.js';
import { decodeNormalizedAd, encodeNormalizedAd } from '../data/json-codec.js';
import { extractionStatusFor, type ExtractionDiagnostic, type ExtractionStatus, type ScrapeEnvelope, type ScrapeSummary } from './scraper-types.js';

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
  const extractionStatus = value.extractionStatus === undefined ? (summary.extractionStatus ?? (summary.status === 'completa' && !value.incomplete ? 'completada' : 'parcial')) : value.extractionStatus;
  if (!isExtractionStatus(extractionStatus)) throw new Error('Invalid extraction status');
  const diagnostic = value.diagnostic === undefined ? summary.diagnostic : value.diagnostic;
  if (diagnostic !== undefined && !isDiagnostic(diagnostic)) throw new Error('Invalid extraction diagnostic');
  return { query: value.query, records: value.records.map((record) => decodeNormalizedAd(JSON.stringify(record))), summary: { ...summary, extractionStatus, ...(diagnostic ? { diagnostic } : {}) }, incomplete: value.incomplete, extractionStatus, ...(diagnostic ? { diagnostic } : {}) };
}

function isExtractionStatus(value: unknown): value is ExtractionStatus { return value === 'completada' || value === 'fallida' || value === 'parcial'; }
function isDiagnostic(value: unknown): value is ExtractionDiagnostic {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const diagnostic = value as Record<string, unknown>;
  return typeof diagnostic.userMessage === 'string' && typeof diagnostic.technicalDetail === 'string'
    && (diagnostic.alternativeSearchUrl === undefined || typeof diagnostic.alternativeSearchUrl === 'string')
    && (diagnostic.evidenceId === undefined || typeof diagnostic.evidenceId === 'string')
    && (diagnostic.logReference === undefined || typeof diagnostic.logReference === 'string')
    && (diagnostic.responsePresent === undefined || typeof diagnostic.responsePresent === 'boolean')
    && (diagnostic.status === undefined || (typeof diagnostic.status === 'number' && Number.isFinite(diagnostic.status)))
    && (diagnostic.contentType === undefined || typeof diagnostic.contentType === 'string')
    && (diagnostic.url === undefined || typeof diagnostic.url === 'string');
}

export function createScrapeEnvelope(query: string, records: NormalizedAdRecord[], summary: ScrapeSummary): ScrapeEnvelope {
  const extractionStatus = summary.extractionStatus ?? (summary.status === 'completa' ? 'completada' : 'parcial');
  const diagnostic = summary.diagnostic;
  return { query, records, summary: { ...summary, extractionStatus, ...(diagnostic ? { diagnostic } : {}) }, incomplete: summary.status !== 'completa', extractionStatus, ...(diagnostic ? { diagnostic } : {}) };
}
