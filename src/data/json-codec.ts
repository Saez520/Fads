import type { NormalizedAdRecord } from '../domain/ad-model.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`Invalid normalized ad JSON: ${path} must be an object`);
  return value;
}

function requireArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`Invalid normalized ad JSON: ${path} must be an array`);
  return value;
}

export function encodeNormalizedAd(record: NormalizedAdRecord): string {
  return JSON.stringify(record);
}

export function decodeNormalizedAd(json: string): NormalizedAdRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json) as unknown;
  } catch (error) {
    throw new Error('Invalid normalized ad JSON', { cause: error });
  }

  const root = requireRecord(parsed, 'root');
  const provenance = requireRecord(root.provenance, 'provenance');
  const advertiser = requireRecord(root.advertiser, 'advertiser');
  const status = requireRecord(root.status, 'status');
  const copy = requireRecord(root.copy, 'copy');
  const identity = requireRecord(root.creativeIdentity, 'creativeIdentity');
  const regulatory = requireRecord(root.regulatory, 'regulatory');
  const media = requireArray(root.media, 'media').map((entry, index) => {
    const item = requireRecord(entry, `media[${index}]`);
    if (typeof item.type !== 'string' || typeof item.url !== 'string') {
      throw new Error(`Invalid normalized ad JSON: media[${index}] requires type and url`);
    }
    return item;
  });
  const platforms = requireArray(status.publisherPlatforms, 'status.publisherPlatforms');
  if (!platforms.every((platform) => typeof platform === 'string')) {
    throw new Error('Invalid normalized ad JSON: status.publisherPlatforms must contain strings');
  }

  if (typeof provenance.sourceAdId !== 'string') {
    throw new Error('Invalid normalized ad JSON: provenance.sourceAdId must be a string');
  }

  return {
    provenance: provenance as unknown as NormalizedAdRecord['provenance'],
    advertiser: advertiser as unknown as NormalizedAdRecord['advertiser'],
    status: { ...status, publisherPlatforms: platforms as string[] } as unknown as NormalizedAdRecord['status'],
    copy: copy as unknown as NormalizedAdRecord['copy'],
    media: media as unknown as NormalizedAdRecord['media'],
    creativeIdentity: identity as unknown as NormalizedAdRecord['creativeIdentity'],
    regulatory: regulatory as unknown as NormalizedAdRecord['regulatory'],
    exactFingerprint: (root.exactFingerprint ?? null) as string | null,
    creativeFingerprint: (root.creativeFingerprint ?? null) as string | null,
  };
}
