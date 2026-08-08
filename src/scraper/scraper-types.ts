import type { AdInput } from '../domain/ad-input.js';
import type { NormalizedAdRecord } from '../domain/ad-model.js';

export type ScrapeStatus = 'completa' | 'incompleta' | 'bloqueada';
export type ExtractionStatus = 'completada' | 'fallida' | 'parcial';
export type StopReason = 'ad_limit' | 'end_of_results' | 'no_new_ads' | 'rate_limit' | 'retries_exhausted' | 'unrecognized_response' | 'error';
export interface ExtractionDiagnostic { userMessage: string; technicalDetail: string; alternativeSearchUrl?: string }

export interface ScrapeRequest { query: string; country: string; dateFrom: string; dateTo: string; adType: 'all' }
export interface ScrapeSummary { query: string; count: number; status: ScrapeStatus; stopReason: StopReason; durationMs: number; extractionStatus?: ExtractionStatus; diagnostic?: ExtractionDiagnostic }
export interface ScrapeEnvelope { query: string; records: NormalizedAdRecord[]; summary: ScrapeSummary; incomplete: boolean; extractionStatus?: ExtractionStatus; diagnostic?: ExtractionDiagnostic }

export type LoggerEvent =
  | { type: 'start' | 'finish' | 'batch' | 'persist' | 'blocked' | 'retry' | 'browser' | 'search'; query: string; [key: string]: unknown }
  | { type: 'error'; query: string; message: string; error?: unknown; [key: string]: unknown };
export type Logger = (event: LoggerEvent) => void;
export interface Clock { now(): number }
export type Sleeper = (milliseconds: number) => Promise<void>;
export type Random = () => number;
export type CaptureWindow = (nextGraphQlResponse: Promise<void>) => Promise<void>;
export interface ResultWriter { write(envelope: ScrapeEnvelope): Promise<void> }

export function extractionStatusFor(hasError: boolean, recordCount: number): ExtractionStatus {
  if (!hasError) return 'completada';
  return recordCount === 0 ? 'fallida' : 'parcial';
}

export function sanitizeExtractionError(error: unknown, hasRecords: boolean): ExtractionDiagnostic {
  const userMessage = hasRecords
    ? 'La extracción no pudo completarse; se conservaron resultados parciales.'
    : 'La extracción no pudo completarse y no se recuperaron resultados.';
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : 'Error de extracción';
  const scrubbed = raw
    .replace(/https?:\/\/[^\s)]+/gi, '[url]')
    .replace(/(?:[A-Za-z]:[\\/]|\/tmp\/|\/Users\/|\/home\/|\/var\/)[^\s)]+/g, '[ruta]')
    .replace(/(?:api[_-]?key|token|secret|password|authorization|cookie)\s*[:=]\s*(?:bearer\s+)?[^\s,;]+/gi, '$1=[redactado]')
    .replace(/\b(?:sk|pk|ghp|xox[baprs])_[A-Za-z0-9_-]{8,}\b/gi, '[secreto]')
    .replace(/\s+at\s+[^\n]+/gi, '')
    .replace(/[\r\n]+/g, ' ')
    .trim();
  const technicalDetail = scrubbed && scrubbed.length <= 240 && !/\b(?:config|env|process\.env)\b/i.test(scrubbed)
    ? scrubbed
    : 'Error técnico durante la extracción.';
  return { userMessage, technicalDetail };
}

export interface BrowserPageResponse { url(): string; json(): Promise<unknown> }
export interface BrowserPage {
  on(event: 'response', listener: (response: BrowserPageResponse) => void | Promise<void>): void;
  goto(url: string): Promise<unknown>;
  evaluate(script: () => void): Promise<unknown>;
  close(): Promise<void>;
}
export interface BrowserContext { newPage(): Promise<BrowserPage>; close(): Promise<void> }
export interface Browser { newContext(options?: Record<string, unknown>): Promise<BrowserContext>; close(): Promise<void> }
export interface BrowserLauncher { launch(options: { headless: true }): Promise<Browser> }
export interface MetaAdScraperOptions {
  launcher?: BrowserLauncher;
  sleep?: Sleeper;
  random?: Random;
  clock?: Clock;
  logger?: Logger;
  captureWindow?: CaptureWindow;
  captureTimeoutMs?: number;
  onBatch?: (records: NormalizedAdRecord[]) => Promise<void> | void;
  maxSourceAds?: number;
  diagnosticsEnabled?: boolean;
}

export interface ParsedBatch { ads: AdInput[]; hasNextPage: boolean; endCursor: string | null; sourceIds: string[] }
export interface GraphQlError { message?: string; code?: number; severity?: string; extensions?: { is_final?: boolean; [key: string]: unknown } }
export type GraphQlClassification = 'recognized' | 'empty' | 'unrecognized' | 'finalRateLimit';
export interface GraphQlParseResult { batch?: ParsedBatch; errors: GraphQlError[]; relevant: boolean; finalRateLimit: boolean; classification: GraphQlClassification; rawResponse: unknown }

export function validateScrapeRequest(value: unknown): ScrapeRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Invalid scrape request');
  const input = value as Record<string, unknown>;
  return validateStructuredRequest(input, 'scrape request');
}

export function validateStructuredRequest(value: unknown, context = 'solicitud'): ScrapeRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${context} inválida: debe ser un objeto.`);
  const input = value as Record<string, unknown>;
  const expected = ['query', 'country', 'dateFrom', 'dateTo', 'adType'];
  if (Object.keys(input).some((key) => !expected.includes(key))) throw new Error(`${context} inválida: no se permiten campos desconocidos.`);
  if (typeof input.query !== 'string' || input.query.trim() === '') throw new Error('query debe ser un texto no vacío.');
  if (typeof input.country !== 'string' || !/^[A-Z]{2}$/.test(input.country)) throw new Error('country debe tener exactamente dos letras ASCII mayúsculas.');
  validateCalendarDate(input.dateFrom, 'dateFrom');
  validateCalendarDate(input.dateTo, 'dateTo');
  if ((input.dateFrom as string) > (input.dateTo as string)) throw new Error('dateFrom no puede ser posterior a dateTo.');
  if (input.adType !== 'all') throw new Error("adType debe ser 'all'.");
  return { query: input.query.trim(), country: input.country, dateFrom: input.dateFrom as string, dateTo: input.dateTo as string, adType: 'all' };
}

function validateCalendarDate(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`${field} debe tener formato YYYY-MM-DD y ser una fecha real.`);
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) throw new Error(`${field} debe ser una fecha real.`);
}
