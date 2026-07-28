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

  it('preserves watermarked media found only in direct snapshot arrays', () => {
    const [record] = normalizeAd({
      ad_archive_id: 'watermarked-only',
      snapshot: {
        videos: [{ watermarked_video_hd_url: 'https://cdn.test/video.mp4?signature=one' }],
        images: [{ watermarked_image_url: 'https://cdn.test/image.jpg?signature=two' }],
      },
    });

    expect(record.media).toEqual([
      {
        type: 'watermarked_video_hd',
        url: 'https://cdn.test/video.mp4',
        mediaId: null,
      },
      {
        type: 'watermarked_image',
        url: 'https://cdn.test/image.jpg',
        mediaId: null,
      },
    ]);
  });

  it('uses the first mediaId found across all media references', () => {
    const [record] = normalizeAd({
      ad_archive_id: 'later-media-id',
      snapshot: {
        cards: [{ video_hd_url: 'https://cdn.test/card.mp4' }],
        videos: [{ media_id: '  Creative-ID-A  ', video_hd_url: 'https://cdn.test/video.mp4' }],
        images: [{ media_id: 'Creative-ID-B', original_image_url: 'https://cdn.test/image.jpg' }],
      },
    });

    expect(record.creativeIdentity.mediaId).toBe('  Creative-ID-A  ');
    expect(record.creativeIdentity.normalizedMediaUrl).toBe('https://cdn.test/card.mp4');
  });

  it('keeps snapshot video and image references in addition to DCO card media', () => {
    const [record] = normalizeAd({
      ad_archive_id: 'dco-with-snapshot-media',
      snapshot: {
        cards: [{ video_hd_url: 'https://cdn.test/card.mp4' }],
        videos: [{ video_sd_url: 'https://cdn.test/snapshot.mp4' }],
        images: [{ original_image_url: 'https://cdn.test/snapshot.jpg' }],
      },
    });

    expect(record.media.map((reference) => reference.url)).toEqual([
      'https://cdn.test/card.mp4',
      'https://cdn.test/snapshot.mp4',
      'https://cdn.test/snapshot.jpg',
    ]);
  });
});
