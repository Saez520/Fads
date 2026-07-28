import { describe, expect, it } from 'vitest';
import type { AdInput } from '../../src/domain/ad-input.js';
import { normalizeAd, normalizeDestinationUrl, normalizeMediaUrl, normalizeText } from '../../src/domain/normalizers.js';
import { loadHarAds } from '../fixtures/har-ad-fixture.js';

describe('text and URL normalization', () => {
  it('normalizes text without removing accents or emoji', () => {
    expect(normalizeText('  HéLLo   😊  ')).toBe('héllo 😊');
    expect(normalizeText('á')).toBe('á');
  });

  it('removes only recognized destination tracking and fragments', () => {
    expect(normalizeDestinationUrl('https://EXAMPLE.test/p?a=1&utm_source=x#frag')).toBe(
      'https://example.test/p?a=1',
    );
    expect(normalizeDestinationUrl('https://example.test/p?custom=x#frag')).toBe(
      'https://example.test/p?custom=x',
    );
  });

  it('removes query and fragment from media URLs', () => {
    expect(normalizeMediaUrl('HTTPS://EXAMPLE.test/video.mp4?signature=abc#x')).toBe(
      'https://example.test/video.mp4',
    );
  });
});

describe('ad normalization', () => {
  it('creates one record per DCO card and preserves provenance/media', () => {
    const ad = loadHarAds().find((candidate) => (candidate.snapshot?.cards?.length ?? 0) > 1);
    expect(ad).toBeDefined();
    const records = normalizeAd(ad!);
    expect(records).toHaveLength(ad!.snapshot!.cards!.length);
    expect(records.map((record) => record.provenance.cardPosition)).toEqual(
      records.map((_, index) => index),
    );
    expect(new Set(records.map((record) => record.provenance.sourceAdId)).size).toBe(1);
    expect(records[0].media.length).toBeGreaterThan(0);
  });

  it('creates one direct record and keeps missing values as null', () => {
    const ad = loadHarAds().find((candidate) => !(candidate.snapshot?.cards?.length ?? 0));
    expect(ad).toBeDefined();
    const [record] = normalizeAd({ ...ad, snapshot: { ...ad!.snapshot, link_url: 'https://example.test/p?a=1&utm_source=x#frag' } });
    expect(record.provenance.cardPosition).toBeNull();
    expect(record.copy.destinationUrl).toBe('https://example.test/p?a=1');
    expect(normalizeAd({ ad_archive_id: 'missing', snapshot: {} })[0].regulatory.containsSensitiveContent).toBeNull();
    expect(record.copy.bodyText).not.toBeNull();
  });

  it('does not discard an ad without media or copy', () => {
    const input: AdInput = { ad_archive_id: 'missing-data', snapshot: {} };
    const [record] = normalizeAd(input);
    expect(record.media).toEqual([]);
    expect(record.copy.bodyText).toBeNull();
    expect(record.creativeIdentity.normalizedMediaUrl).toBeNull();
  });
});
