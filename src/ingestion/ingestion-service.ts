import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { decodeNormalizedAd } from '../data/json-codec.js';
import type { NormalizedAdRecord } from '../domain/ad-model.js';
import { sanitizeExtractionError, type ExtractionDiagnostic, type ExtractionStatus, type ScrapeEnvelope, type ScrapeStatus, type StopReason } from '../scraper/scraper-types.js';
import {
  DEFAULT_INGESTION_SOURCE,
  type ConfirmRelaunch,
  type IngestionConfig,
  type IngestionError,
  type IngestionIndex,
  type IngestionOperationOptions,
  type IngestionResult,
  type IngestionStatus,
  type IngestionStore,
  type IngestionWarning,
} from './ingestion-types.js';

const defaultClock = { now: () => Date.now() };

export class IngestionService {
  private readonly source: string;
  private readonly clock: { now(): number };
  private readonly generateSearchId: () => string;

  constructor(private readonly store: IngestionStore, config: IngestionConfig = {}, options: IngestionOperationOptions = {}) {
    this.source = config.source ?? DEFAULT_INGESTION_SOURCE;
    this.clock = options.clock ?? defaultClock;
    this.generateSearchId = options.searchIdGenerator ?? randomUUID;
    this.options = options;
  }

  private readonly options: IngestionOperationOptions;

  async ingestFile(inputPath: string, options: { confirmRelaunch?: ConfirmRelaunch } = {}): Promise<IngestionResult> {
    let envelope: ScrapeEnvelope;
    try {
      envelope = this.parseEnvelope(await readFile(inputPath, 'utf8'));
    } catch (error) {
      return { success: false, created: false, warnings: [], errors: [this.error(error)] };
    }

    const warnings: IngestionWarning[] = [];
    const records: NormalizedAdRecord[] = [];
    for (const [recordIndex, rawRecord] of envelope.records.entries()) {
      try {
        records.push(decodeNormalizedAd(JSON.stringify(rawRecord)));
      } catch (error) {
        const warning = { recordIndex, message: error instanceof Error ? error.message : String(error) };
        warnings.push(warning);
        this.options.logger?.(warning);
      }
    }

    try {
      const existing = await this.store.findByQuery(envelope.query);
      if (existing) {
        const confirm = options.confirmRelaunch ?? this.options.confirmRelaunch;
        const message = `La query ya existe; relanzarla puede tardar varios minutos. ¿Desea relanzarla?`;
        if (!confirm || !(await confirm(existing, message))) {
          return { success: true, created: false, searchId: existing.searchId, ingestionPath: existing.ingestionPath, warnings: [], errors: [] };
        }
      }

      let searchId: string;
      do { searchId = this.generateSearchId(); } while (await this.store.exists(searchId));
      const status = this.statusFor(envelope.summary.extractionStatus, envelope.summary.status, envelope.summary.stopReason, envelope.incomplete, warnings.length > 0, records.length);
      const index: IngestionIndex = {
        searchId, query: envelope.query, createdAt: new Date(this.clock.now()).toISOString(),
        totalRecords: records.length, status, source: this.source, durationMs: envelope.summary.durationMs,
        extractionStatus: envelope.extractionStatus ?? envelope.summary.extractionStatus ?? (status === 'failed' ? 'fallida' : status === 'partial' ? 'parcial' : 'completada'),
        ...(envelope.diagnostic ?? envelope.summary.diagnostic ? { diagnostic: envelope.diagnostic ?? envelope.summary.diagnostic } : {}),
      };
      const reference = await this.store.publish(index, records);
      return { success: true, created: true, searchId, ingestionPath: reference.ingestionPath, index, warnings, errors: [] };
    } catch (error) {
      return { success: false, created: false, warnings, errors: [this.error(error)], diagnostic: sanitizeExtractionError(error, records.length > 0) };
    }
  }

  private parseEnvelope(json: string): ScrapeEnvelope {
    const value: unknown = JSON.parse(json);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid scrape envelope');
    const input = value as Record<string, unknown>;
    const summary = input.summary;
    if (typeof input.query !== 'string' || !Array.isArray(input.records) || typeof input.incomplete !== 'boolean') throw new Error('Invalid scrape envelope');
    if (!summary || typeof summary !== 'object' || Array.isArray(summary)) throw new Error('Invalid scrape summary');
    const item = summary as Record<string, unknown>;
    if (item.query !== input.query || typeof item.count !== 'number' || !Number.isFinite(item.count) || item.count < 0 || typeof item.durationMs !== 'number' || !Number.isFinite(item.durationMs) || item.durationMs < 0 || !isScrapeStatus(item.status) || !isStopReason(item.stopReason)) throw new Error('Invalid scrape summary');
    const extractionStatus = input.extractionStatus === undefined ? item.extractionStatus : input.extractionStatus;
    if (extractionStatus !== undefined && !isExtractionStatus(extractionStatus)) throw new Error('Invalid extraction status');
    const diagnostic = input.diagnostic === undefined ? item.diagnostic : input.diagnostic;
    if (diagnostic !== undefined && !isDiagnostic(diagnostic)) throw new Error('Invalid extraction diagnostic');
    const sanitizedDiagnostic = diagnostic === undefined ? undefined : sanitizeDiagnostic(diagnostic, input.records.length > 0);
    return { query: input.query, records: input.records as NormalizedAdRecord[], summary: { ...item, ...(extractionStatus !== undefined ? { extractionStatus } : {}), ...(sanitizedDiagnostic ? { diagnostic: sanitizedDiagnostic } : {}) } as unknown as ScrapeEnvelope['summary'], incomplete: input.incomplete, ...(extractionStatus ? { extractionStatus } : {}), ...(sanitizedDiagnostic ? { diagnostic: sanitizedDiagnostic } : {}) };
  }

  private statusFor(extractionStatus: ScrapeEnvelope['summary']['extractionStatus'], status: ScrapeStatus, stopReason: StopReason, incomplete: boolean, discarded: boolean, recordCount: number): IngestionStatus {
    if (stopReason === 'empty_capture') return 'partial';
    if (extractionStatus === 'fallida' || (status !== 'completa' && recordCount === 0)) return 'failed';
    return extractionStatus === 'parcial' || incomplete || discarded ? 'partial' : 'completed';
  }

  private error(error: unknown): IngestionError { return { message: sanitizeExtractionError(error, false).technicalDetail }; }
}
function isScrapeStatus(value: unknown): value is ScrapeStatus { return value === 'completa' || value === 'incompleta' || value === 'bloqueada'; }
function isStopReason(value: unknown): value is StopReason { return value === 'ad_limit' || value === 'end_of_results' || value === 'no_new_ads' || value === 'rate_limit' || value === 'retries_exhausted' || value === 'unrecognized_response' || value === 'empty_capture' || value === 'error'; }
function isExtractionStatus(value: unknown): value is ExtractionStatus { return value === 'completada' || value === 'fallida' || value === 'parcial'; }
function isDiagnostic(value: unknown): value is ExtractionDiagnostic {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const diagnostic = value as Record<string, unknown>;
    return typeof diagnostic.userMessage === 'string' && diagnostic.userMessage.length <= 240 && typeof diagnostic.technicalDetail === 'string' && diagnostic.technicalDetail.length <= 1000 && (diagnostic.alternativeSearchUrl === undefined || typeof diagnostic.alternativeSearchUrl === 'string')
      && (diagnostic.evidenceId === undefined || typeof diagnostic.evidenceId === 'string')
      && (diagnostic.logReference === undefined || typeof diagnostic.logReference === 'string')
      && (diagnostic.responsePresent === undefined || typeof diagnostic.responsePresent === 'boolean')
      && (diagnostic.status === undefined || (typeof diagnostic.status === 'number' && Number.isFinite(diagnostic.status)))
      && (diagnostic.contentType === undefined || typeof diagnostic.contentType === 'string')
      && (diagnostic.url === undefined || typeof diagnostic.url === 'string');
}
function sanitizeDiagnostic(diagnostic: ExtractionDiagnostic, hasRecords: boolean): ExtractionDiagnostic {
  const fallback = sanitizeExtractionError(diagnostic.technicalDetail, hasRecords);
  const safeUserMessage = sanitizeExtractionError(diagnostic.userMessage, hasRecords).userMessage;
  const userMessage = diagnostic.alternativeSearchUrl && !safeUserMessage.includes('búsqueda manual')
    ? `${safeUserMessage} Puede continuar con la búsqueda manual.`
    : safeUserMessage;
  return {
    userMessage,
    technicalDetail: fallback.technicalDetail,
    ...(diagnostic.alternativeSearchUrl ? { alternativeSearchUrl: diagnostic.alternativeSearchUrl } : {}),
    ...(diagnostic.evidenceId ? { evidenceId: diagnostic.evidenceId } : {}),
    ...(diagnostic.logReference ? { logReference: diagnostic.logReference } : {}),
    ...(diagnostic.responsePresent !== undefined ? { responsePresent: diagnostic.responsePresent } : {}),
    ...(diagnostic.status !== undefined ? { status: diagnostic.status } : {}),
    ...(diagnostic.contentType ? { contentType: diagnostic.contentType } : {}),
    ...(diagnostic.url ? { url: diagnostic.url } : {}),
  };
}
