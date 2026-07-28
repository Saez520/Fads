import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { decodeNormalizedAd } from '../data/json-codec.js';
import type { NormalizedAdRecord } from '../domain/ad-model.js';
import type { ScrapeEnvelope, ScrapeStatus, StopReason } from '../scraper/scraper-types.js';
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

  async ingestFile(inputPath: string): Promise<IngestionResult> {
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
        const confirm = this.options.confirmRelaunch;
        const message = `La query ya existe; relanzarla puede tardar varios minutos. ¿Desea relanzarla?`;
        if (!confirm || !(await confirm(existing, message))) {
          return { success: true, created: false, searchId: existing.searchId, ingestionPath: existing.ingestionPath, warnings: [], errors: [] };
        }
      }

      let searchId: string;
      do { searchId = this.generateSearchId(); } while (await this.store.exists(searchId));
      const status = this.statusFor(envelope.summary.status, envelope.incomplete, warnings.length > 0);
      const index: IngestionIndex = {
        searchId, query: envelope.query, createdAt: new Date(this.clock.now()).toISOString(),
        totalRecords: records.length, status, source: this.source, durationMs: envelope.summary.durationMs,
      };
      const reference = await this.store.publish(index, records);
      return { success: true, created: true, searchId, ingestionPath: reference.ingestionPath, index, warnings, errors: [] };
    } catch (error) {
      return { success: false, created: false, warnings, errors: [this.error(error)] };
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
    return { query: input.query, records: input.records as NormalizedAdRecord[], summary: item as unknown as ScrapeEnvelope['summary'], incomplete: input.incomplete };
  }

  private statusFor(status: ScrapeStatus, incomplete: boolean, discarded: boolean): IngestionStatus {
    return status === 'completa' && !incomplete && !discarded ? 'completed' : 'partial';
  }

  private error(error: unknown): IngestionError { return { message: error instanceof Error ? error.message : String(error) }; }
}

function isScrapeStatus(value: unknown): value is ScrapeStatus { return value === 'completa' || value === 'incompleta' || value === 'bloqueada'; }
function isStopReason(value: unknown): value is StopReason {
  return value === 'ad_limit' || value === 'end_of_results' || value === 'no_new_ads' || value === 'rate_limit' || value === 'retries_exhausted' || value === 'error';
}
