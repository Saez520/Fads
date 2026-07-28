import { describe, expect, it } from 'vitest';
import { normalizeAndFingerprintAd, canonicalJson, fingerprintNormalizedAd } from '../../src/domain/fingerprints.js';
import { normalizeAd } from '../../src/domain/normalizers.js';
import { loadHarAds } from '../fixtures/har-ad-fixture.js';

describe('server fingerprints', () => {
  it('recalculates deterministic 64-character SHA-256 fingerprints', () => {
    const ad = loadHarAds()[0];
    const first = normalizeAndFingerprintAd(ad)[0];
    const second = normalizeAndFingerprintAd(ad)[0];
    expect(first.exactFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(first.creativeFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(first.exactFingerprint).toBe(second.exactFingerprint);
    expect(first.creativeFingerprint).toBe(second.creativeFingerprint);
  });

  it('does not depend on object key insertion order', () => {
    const record = normalizeAd(loadHarAds()[0])[0];
    const reordered = {
      ...record,
      copy: { ...record.copy },
      advertiser: { ...record.advertiser },
      provenance: { ...record.provenance },
    };
    expect(fingerprintNormalizedAd(record).exactFingerprint).toBe(fingerprintNormalizedAd(reordered).exactFingerprint);
    expect(canonicalJson({ z: 1, a: { y: 2, x: 3 } })).toBe('{"a":{"x":3,"y":2},"z":1}');
  });

  it('uses mediaId first, then normalized media URL, and null without identity', () => {
    const [withMedia] = normalizeAndFingerprintAd({
      ad_archive_id: 'id',
      snapshot: { cards: [{ media_id: 'creative-1', video_hd_url: 'https://cdn.test/a.mp4?sig=one' }] },
    });
    const [sameId] = normalizeAndFingerprintAd({
      ad_archive_id: 'other-id',
      snapshot: { cards: [{ media_id: 'creative-1', video_hd_url: 'https://cdn.test/other.mp4?sig=two' }] },
    });
    const [withoutMedia] = normalizeAndFingerprintAd({ ad_archive_id: 'empty', snapshot: {} });
    expect(withMedia.creativeFingerprint).toBe(sameId.creativeFingerprint);
    expect(withoutMedia.creativeFingerprint).toBeNull();
  });

  it('ignores externally supplied fingerprints at the server boundary', () => {
    const [record] = normalizeAndFingerprintAd({
      ad_archive_id: 'external',
      exactFingerprint: 'attacker-value',
      creativeFingerprint: 'attacker-value',
      snapshot: {},
    });
    expect(record.exactFingerprint).not.toBe('attacker-value');
    expect(record.creativeFingerprint).toBeNull();
  });
});
