import type { AdInput } from '../domain/ad-input.js';
import type { NormalizedAdRecord } from '../domain/ad-model.js';

export type ScrapeStatus = 'completa' | 'incompleta' | 'bloqueada';
export type ExtractionStatus = 'completada' | 'fallida' | 'parcial';
export type StopReason = 'ad_limit' | 'end_of_results' | 'no_new_ads' | 'rate_limit' | 'retries_exhausted' | 'unrecognized_response' | 'empty_capture' | 'error';
export type DiagnosticPrimaryClassification = 'network_failure' | 'challenge_or_http_block' | 'captcha' | 'ssr_results' | 'explicit_empty' | 'login_required' | 'shell_without_results' | 'unknown';
export type DiagnosticTrigger = 'empty_capture' | 'unrecognized_response' | 'error' | 'retries_exhausted' | 'rate_limit' | 'challenge' | 'captcha' | 'login_required' | 'unknown';
export type DiagnosticEventFamily = 'navigation' | 'graphql' | 'runtime' | 'dom' | 'summary' | 'truncation';
export type DiagnosticPriority = 'high' | 'normal' | 'low';
export interface DiagnosticNavigationEvent { family: 'navigation'; type: 'diagnostic.navigation'; url?: string; status?: number; contentType?: string; resourceType?: string; durationMs?: number; redirectCount?: number; host?: string; }
export interface DiagnosticGraphQlEvent { family: 'graphql'; type: 'diagnostic.graphql'; friendlyName?: string; docId?: string; status?: number; responseBytes?: number; durationMs?: number; classification?: string; }
export interface DiagnosticRuntimeEvent { family: 'runtime'; type: 'diagnostic.runtime'; kind: 'console' | 'pageerror' | 'requestfailed' | 'browser'; message?: string; name?: string; metadata?: Record<string, unknown>; }
export interface DiagnosticDomEvent { family: 'dom'; type: 'diagnostic.dom'; signals: DiagnosticDomSignals; }
export interface DiagnosticDomSignals { challenge: boolean; captcha: boolean; login: boolean; ssrResults: boolean; explicitEmpty: boolean; shellWithoutResults: boolean; resultCount: number; connectionCount: number; }
export interface DiagnosticSummary { family: 'summary'; type: 'diagnostic.summary'; primary: DiagnosticPrimaryClassification; secondary: string[]; signals: DiagnosticDomSignals; durationMs: number; eventCount: number; droppedEvents: number; diagnosticIncomplete: boolean; }
export interface DiagnosticTruncatedEvent { family: 'truncation'; type: 'diagnostic.truncated'; droppedEvents: number; diagnosticIncomplete: true; }
export type DiagnosticEvent = (DiagnosticNavigationEvent | DiagnosticGraphQlEvent | DiagnosticRuntimeEvent | DiagnosticDomEvent | DiagnosticSummary | DiagnosticTruncatedEvent) & { timestamp?: string; priority?: DiagnosticPriority; [key: string]: unknown };
export interface NetworkEvidenceClassification { label: 'possible_redirect' | 'possible_login' | 'possible_http_block' | 'possible_network_failure' | 'unknown'; signals: string[] }
export interface NetworkEvidenceHop { url: string; status?: number; destination?: string }
export interface NetworkEvidenceSummary { evidenceId: string; logReference: string; responsePresent: boolean; status?: number; contentType?: string; url?: string; kind?: 'document' | 'network_failure'; failureText?: string; hops?: NetworkEvidenceHop[]; classification?: NetworkEvidenceClassification }
export interface ExtractionDiagnostic { userMessage: string; technicalDetail: string; alternativeSearchUrl?: string; evidenceId?: string; logReference?: string; responsePresent?: boolean; status?: number; contentType?: string; url?: string; networkEvidence?: NetworkEvidenceSummary[]; classifications?: NetworkEvidenceClassification[]; diagnosticIncomplete?: boolean }

export interface ScrapeRequest { query: string; country: string; dateFrom: string; dateTo: string; adType: 'all' }
export interface ScrapeSummary { query: string; count: number; status: ScrapeStatus; stopReason: StopReason; durationMs: number; extractionStatus?: ExtractionStatus; diagnostic?: ExtractionDiagnostic }
export interface ScrapeEnvelope { query: string; records: NormalizedAdRecord[]; summary: ScrapeSummary; incomplete: boolean; extractionStatus?: ExtractionStatus; diagnostic?: ExtractionDiagnostic }

export type LoggerEvent =
  | { type: 'start' | 'finish' | 'batch' | 'persist' | 'blocked' | 'retry' | 'browser' | 'search'; query: string; [key: string]: unknown }
  | { type: 'diagnostic'; query: string; event: DiagnosticEvent; reinforced?: boolean; [key: string]: unknown }
  | { type: 'error'; query: string; message: string; error?: unknown; [key: string]: unknown };
export type Logger = ((event: LoggerEvent) => void) & { diagnosticState?: DiagnosticState };
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

export interface BrowserPageRequest { url(): string; redirectedFrom?(): BrowserPageRequest | null; resourceType?(): string; failure?(): { errorText?: string } | null; response?(): Promise<BrowserPageResponse | null> }
export interface BrowserPageResponse { url(): string; json(): Promise<unknown>; request?(): BrowserPageRequest; status?(): number; headers?(): Record<string, string>; text?(): Promise<string>; allHeaders?(): Promise<Record<string, string>> }
export interface BrowserConsoleMessage { type?(): string; text?(): string; }
export interface BrowserPageMetadata { browserName?: string; browserVersion?: string; locale?: string; timezone?: string; viewport?: { width: number; height: number }; webdriver?: boolean; cookieNames?: string[]; }
export interface BrowserPage {
  on(event: 'response', listener: (response: BrowserPageResponse) => void | Promise<void>): void;
  on(event: 'requestfailed', listener: (request: BrowserPageRequest) => void | Promise<void>): void;
  onConsole?(listener: (message: BrowserConsoleMessage) => void | Promise<void>): void;
  onPageError?(listener: (error: Error) => void | Promise<void>): void;
  goto(url: string): Promise<unknown>;
  evaluate(script: () => void): Promise<unknown>;
  close(): Promise<void>;
  url?(): string;
  diagnosticSignals?(): Promise<DiagnosticDomSignals>;
  browserMetadata?(): Promise<BrowserPageMetadata>;
}
export interface BrowserContext { newPage(): Promise<BrowserPage>; close(): Promise<void>; diagnosticMetadata?(): Promise<BrowserPageMetadata> }
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
  networkEvidenceBodyLimitBytes?: number;
  diagnosticState?: DiagnosticState;
}

export interface DiagnosticState {
  readonly diagnosticPath?: string;
  readonly diagnosticReference?: string;
  readonly droppedDiagnosticEvents?: number;
  readonly diagnosticIncomplete?: boolean;
  readonly diagnosticSummaryEvent?: DiagnosticSummary;
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
