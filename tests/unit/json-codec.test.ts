import { describe, expect, it } from 'vitest';
import { decodeNormalizedAd, encodeNormalizedAd } from '../../src/data/json-codec.js';
import { normalizeAndFingerprintAd } from '../../src/domain/fingerprints.js';
import { loadHarAds } from '../fixtures/har-ad-fixture.js';

describe('normalized ad JSON codec', () => {
  it('round-trips nulls, fingerprints and ordered multiple media references', () => {
    const ad = loadHarAds().find((candidate) => (candidate.snapshot?.cards?.length ?? 0) > 0)!;
    const record = normalizeAndFingerprintAd(ad)[0];
    const decoded = decodeNormalizedAd(encodeNormalizedAd(record));
    expect(decoded).toEqual(record);
    expect(decoded.media.map((media) => media.type)).toEqual(record.media.map((media) => media.type));
    expect(decoded.regulatory.containsSensitiveContent).toBe(record.regulatory.containsSensitiveContent);
  });

  it('rejects arrays and scalar JSON roots', () => {
    expect(() => decodeNormalizedAd('[]')).toThrow(/root must be an object/);
    expect(() => decodeNormalizedAd('42')).toThrow(/root must be an object/);
  });
});
