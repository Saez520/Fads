import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileSystemIngestionStore } from '../../src/ingestion/ingestion-store.js';
import { IngestionService } from '../../src/ingestion/ingestion-service.js';
import type { NormalizedAdRecord } from '../../src/domain/ad-model.js';

const record: NormalizedAdRecord = {
  provenance: { sourceAdId: 'ad-1', collationId: null, collationCount: null, cardPosition: 1 },
  advertiser: { advertiserName: null, advertiserId: null, advertiserProfileUrl: null, profilePictureUrl: null, pageLikeCount: null },
  status: { isActive: null, startDate: null, endDate: null, publisherPlatforms: ['facebook'], displayFormat: null },
  copy: { bodyText: null, title: null, ctaText: null, ctaType: null, caption: null, linkDescription: null, destinationUrl: null },
  media: [{ type: 'image_original', url: 'https://example.test/ad.jpg', mediaId: null }],
  creativeIdentity: { mediaId: null, normalizedMediaUrl: null },
  regulatory: { containsDigitalCreatedMedia: null, containsSensitiveContent: null, gatedType: null, isAaaEligible: null, regionalRegulationData: null },
  exactFingerprint: 'exact', creativeFingerprint: 'creative',
};

const envelope = (query: string, records: unknown[] = [record], incomplete = false, stopReason = 'end_of_results') => ({
  query, records, incomplete,
  summary: { query, count: records.length, status: incomplete ? 'incompleta' : 'completa', stopReason, durationMs: 123 },
});

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function setup(input: unknown) {
  const root = await mkdtemp(join(tmpdir(), 'ingestion-'));
  roots.push(root);
  const inputPath = join(root, 'scrape.json');
  await writeFile(inputPath, JSON.stringify(input), 'utf8');
  const store = new FileSystemIngestionStore(join(root, 'data'));
  return { root, inputPath, store, service: new IngestionService(store, {}, { searchIdGenerator: () => 'fixed-id', clock: { now: () => 1_700_000_000_000 } }) };
}

describe('IngestionService', () => {
  it('publishes normalized records and preserves index metadata', async () => {
    const { inputPath, store, service } = await setup(envelope('shoes'));
    const result = await service.ingestFile(inputPath);
    expect(result).toMatchObject({ success: true, created: true, searchId: 'fixed-id', warnings: [], errors: [] });
    expect(result.index).toMatchObject({ query: 'shoes', totalRecords: 1, status: 'completed', source: 'scraper-v1', durationMs: 123 });
    expect(JSON.parse(await readFile(join(result.ingestionPath!, 'records.json'), 'utf8'))).toEqual([record]);
    expect(await store.findByQuery('shoes')).toMatchObject({ searchId: 'fixed-id' });
  });

  it('isolates invalid records and marks the ingestion partial', async () => {
    const { inputPath, service } = await setup(envelope('mixed', [record, null, { bad: true }]));
    const result = await service.ingestFile(inputPath);
    expect(result.success).toBe(true);
    expect(result.index?.status).toBe('partial');
    expect(result.index?.totalRecords).toBe(1);
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings.map((warning) => warning.recordIndex)).toEqual([1, 2]);
  });

  it('rejects a duplicate without reading or publishing a new ingestion', async () => {
    const first = await setup(envelope('duplicate'));
    await first.service.ingestFile(first.inputPath);
    const secondInput = join(first.root, 'second.json');
    await writeFile(secondInput, JSON.stringify(envelope('duplicate', [null])), 'utf8');
    let called = false;
    const service = new IngestionService(first.store, {}, { searchIdGenerator: () => 'new-id', confirmRelaunch: async () => { called = true; return false; } });
    const result = await service.ingestFile(secondInput);
    expect(called).toBe(true);
    expect(result).toMatchObject({ success: true, created: false, searchId: 'fixed-id', warnings: [], errors: [] });
  });

  it('returns a clear error for an unreadable envelope', async () => {
    const { inputPath, service } = await setup({ query: 'bad', records: [] });
    const result = await service.ingestFile(inputPath);
    expect(result.success).toBe(false);
    expect(result.errors[0].message).toBe('Invalid scrape envelope');
  });

  it('validates and sanitizes diagnostic metadata before publishing the index', async () => {
    const input = envelope('diagnostic', [], true) as Record<string, unknown>;
    input.extractionStatus = 'fallida';
    input.diagnostic = { userMessage: 'fallo', technicalDetail: 'Authorization: Bearer secret-token /Users/local/app.ts' };
    const { inputPath, service, store } = await setup(input);
    const result = await service.ingestFile(inputPath);
    expect(result.index).toMatchObject({ status: 'failed', extractionStatus: 'fallida', diagnostic: { userMessage: expect.any(String) } });
    const persisted = JSON.stringify(result.index);
    expect(persisted).not.toContain('secret-token');
    expect(persisted).not.toContain('/Users/local');
    await expect(service.ingestFile(inputPath)).resolves.toMatchObject({ success: true });
    expect(await store.findByQuery('diagnostic')).toBeDefined();
  });
  it('publishes an unrecognized response as failed while preserving its diagnostic', async () => {
    const input = envelope('unrecognized', [], true, 'unrecognized_response') as Record<string, unknown>;
    input.extractionStatus = 'fallida';
    input.diagnostic = { userMessage: 'Captura inconclusa.', technicalDetail: 'Respuesta no interpretable.', alternativeSearchUrl: 'https://www.facebook.com/ads/library/?q=unrecognized' };
    const { inputPath, service } = await setup(input);
    const result = await service.ingestFile(inputPath);
    expect(result).toMatchObject({ success: true, index: { status: 'failed', extractionStatus: 'fallida', diagnostic: { alternativeSearchUrl: expect.stringContaining('q=unrecognized') } } });
  });
  it('persists empty_capture as partial with a search id and sanitized diagnostic', async () => {
    const input = envelope('empty-capture', [], true, 'empty_capture') as Record<string, unknown>;
    input.extractionStatus = 'fallida';
    input.diagnostic = { userMessage: 'Captura inconclusa.', technicalDetail: 'Authorization: Bearer secret-token /Users/local/app.ts' };
    const { inputPath, service } = await setup(input);
    const result = await service.ingestFile(inputPath);
    expect(result).toMatchObject({ success: true, created: true, searchId: 'fixed-id', index: { status: 'partial', extractionStatus: 'fallida', totalRecords: 0, diagnostic: { userMessage: expect.any(String) } } });
    expect(JSON.stringify(result.index)).not.toContain('secret-token');
    expect(JSON.stringify(result.index)).not.toContain('/Users/local');
  });
  it('rejects an invalid extraction status instead of persisting it', async () => {
    const input = envelope('invalid-status', [], true) as Record<string, unknown>;
    input.extractionStatus = 'unknown';
    const { inputPath, service } = await setup(input);
    await expect(service.ingestFile(inputPath)).resolves.toMatchObject({ success: false, errors: [{ message: 'Invalid extraction status' }] });
  });
});

describe('FileSystemIngestionStore', () => {
  it('does not replace an existing destination', async () => {
    const root = await mkdtemp(join(tmpdir(), 'store-'));
    roots.push(root);
    const store = new FileSystemIngestionStore(root);
    const index = { searchId: 'same', query: 'q', createdAt: new Date(0).toISOString(), totalRecords: 0, status: 'completed' as const, source: 'test', durationMs: 0 };
    await store.publish(index, []);
    await expect(store.publish({ ...index, query: 'changed' }, [])).rejects.toBeTruthy();
    expect(JSON.parse(await readFile(join(root, 'same', 'index.json'), 'utf8')).query).toBe('q');
  });
});
