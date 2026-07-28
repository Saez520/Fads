import { createHash } from 'node:crypto';
import type { AdInput } from './ad-input.js';
import type { NormalizedAdRecord } from './ad-model.js';
import { normalizeAd } from './normalizers.js';
import type { NormalizerOptions } from './normalization-config.js';

export const CANONICAL_SCHEMA_VERSION = 1;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function canonicalPayload(record: NormalizedAdRecord): Record<string, unknown> {
  return {
    schemaVersion: CANONICAL_SCHEMA_VERSION,
    provenance: record.provenance,
    advertiser: record.advertiser,
    status: record.status,
    copy: record.copy,
    media: record.media,
    creativeIdentity: record.creativeIdentity,
    regulatory: record.regulatory,
  };
}

export function creativeFingerprint(record: NormalizedAdRecord): string | null {
  const identity = record.creativeIdentity.mediaId ?? record.creativeIdentity.normalizedMediaUrl;
  return identity ? sha256(`creative:v${CANONICAL_SCHEMA_VERSION}:${identity}`) : null;
}

export function exactFingerprint(record: NormalizedAdRecord): string {
  return sha256(canonicalJson(canonicalPayload(record)));
}

export function fingerprintNormalizedAd(record: NormalizedAdRecord): NormalizedAdRecord {
  return {
    ...record,
    exactFingerprint: exactFingerprint(record),
    creativeFingerprint: creativeFingerprint(record),
  };
}

/** Server boundary: discard input fingerprints, normalize, then recalculate both hashes. */
export function normalizeAndFingerprintAd(
  input: AdInput,
  options: NormalizerOptions = {},
): NormalizedAdRecord[] {
  return normalizeAd(input, options).map(fingerprintNormalizedAd);
}
