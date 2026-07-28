import type { AdCardInput, AdInput, AdMediaInput, AdSnapshotInput } from './ad-input.js';
import type { MediaReference, NormalizedAdRecord } from './ad-model.js';
import { DEFAULT_TRACKING_PARAMS, type NormalizerOptions } from './normalization-config.js';

export function normalizeText(value: string | null | undefined): string | null {
  if (value == null) return null;
  return value.normalize('NFC').toLowerCase().trim().replace(/\s+/gu, ' ');
}

export function normalizeDestinationUrl(
  value: string | null | undefined,
  options: NormalizerOptions = {},
): string | null {
  return normalizeUrl(value, options.trackingParams ?? DEFAULT_TRACKING_PARAMS, true);
}

export function normalizeMediaUrl(value: string | null | undefined): string | null {
  return normalizeUrl(value, new Set(), false);
}

function normalizeUrl(
  value: string | null | undefined,
  trackingParams: ReadonlySet<string>,
  keepQuery: boolean,
): string | null {
  if (value == null || value.trim() === '') return null;
  try {
    const url = new URL(value);
    url.protocol = url.protocol.toLowerCase();
    url.hostname = url.hostname.toLowerCase();
    url.hash = '';
    if (keepQuery) {
      for (const key of [...url.searchParams.keys()]) {
        if (trackingParams.has(key.toLowerCase())) url.searchParams.delete(key);
      }
    } else {
      url.search = '';
    }
    return url.toString();
  } catch {
    return null;
  }
}

function bodyText(value: AdSnapshotInput['body'] | AdCardInput['body']): string | null {
  if (typeof value === 'object' && value !== null) return normalizeText(value.text);
  return normalizeText(value);
}

function nullableString(value: string | null | undefined): string | null {
  return normalizeText(value);
}

function preserveMediaId(value: string | null | undefined): string | null {
  return value ?? null;
}

function addMedia(
  media: MediaReference[],
  input: AdMediaInput | null | undefined,
  options: { type: MediaReference['type']; field: keyof AdMediaInput }[],
): void {
  if (!input) return;
  const mediaId = preserveMediaId(input.media_id ?? input.id);
  for (const { type, field } of options) {
    const url = normalizeMediaUrl(input[field] as string | null | undefined);
    if (url) media.push({ type, url, mediaId });
  }
}

function collectMedia(input: AdSnapshotInput, card?: AdCardInput): MediaReference[] {
  const media: MediaReference[] = [];
  const source = card ?? input;
  addMedia(media, source, [
    { type: 'video_hd', field: 'video_hd_url' },
    { type: 'video_sd', field: 'video_sd_url' },
    { type: 'video_thumbnail', field: 'video_preview_image_url' },
    { type: 'watermarked_video_hd', field: 'watermarked_video_hd_url' },
    { type: 'watermarked_video_sd', field: 'watermarked_video_sd_url' },
    { type: 'image_original', field: 'original_image_url' },
    { type: 'image_resized', field: 'resized_image_url' },
    { type: 'watermarked_image', field: 'watermarked_image_url' },
    { type: 'watermarked_image_resized', field: 'watermarked_resized_image_url' },
  ]);
  for (const video of input.videos ?? []) collectMediaFromList(media, video, 'video_hd');
  for (const image of input.images ?? []) collectMediaFromList(media, image, 'image_original');
  return media;
}

function collectMediaFromList(
  media: MediaReference[],
  input: AdMediaInput,
  fallbackType: MediaReference['type'],
): void {
  const before = media.length;
  addMedia(media, input, [
    { type: 'video_hd', field: 'video_hd_url' },
    { type: 'video_sd', field: 'video_sd_url' },
    { type: 'video_thumbnail', field: 'video_preview_image_url' },
    { type: 'watermarked_video_hd', field: 'watermarked_video_hd_url' },
    { type: 'watermarked_video_sd', field: 'watermarked_video_sd_url' },
    { type: 'image_original', field: 'original_image_url' },
    { type: 'image_resized', field: 'resized_image_url' },
    { type: 'watermarked_image', field: 'watermarked_image_url' },
    { type: 'watermarked_image_resized', field: 'watermarked_resized_image_url' },
  ]);
  if (media.length === before) {
    const candidate = normalizeMediaUrl(input.url as string | null | undefined);
    if (candidate) media.push({ type: fallbackType, url: candidate, mediaId: preserveMediaId(input.media_id ?? input.id) });
  }
}

function normalizeRecord(
  input: AdInput,
  snapshot: AdSnapshotInput,
  card: AdCardInput | undefined,
  cardPosition: number | null,
  options: NormalizerOptions,
  collationCount: number | null,
): NormalizedAdRecord {
  const source = card ?? snapshot;
  const media = collectMedia(snapshot, card);
  const firstMedia = media[0];
  const firstMediaWithId = media.find((reference) => reference.mediaId !== null);
  return {
    provenance: {
      sourceAdId: input.ad_archive_id,
      collationId: input.collation_id ?? null,
      collationCount,
      cardPosition,
    },
    advertiser: {
      advertiserName: nullableString(input.page_name ?? snapshot.page_name),
      advertiserId: nullableString(input.page_id ?? snapshot.page_id),
      advertiserProfileUrl: normalizeDestinationUrl(snapshot.page_profile_uri, options),
      profilePictureUrl: normalizeMediaUrl(snapshot.page_profile_picture_url),
      pageLikeCount: snapshot.page_like_count ?? null,
    },
    status: {
      isActive: input.is_active ?? null,
      startDate: input.start_date ?? null,
      endDate: input.end_date ?? null,
      publisherPlatforms: (input.publisher_platform ?? []).map((platform) => normalizeText(platform) ?? ''),
      displayFormat: nullableString(snapshot.display_format),
    },
    copy: {
      bodyText: bodyText(source.body),
      title: nullableString(source.title),
      ctaText: nullableString(source.cta_text),
      ctaType: nullableString(source.cta_type),
      caption: nullableString(source.caption),
      linkDescription: nullableString(source.link_description),
      destinationUrl: normalizeDestinationUrl(source.link_url, options),
    },
    media,
    creativeIdentity: {
      mediaId: firstMediaWithId?.mediaId ?? null,
      normalizedMediaUrl: firstMedia?.url ?? null,
    },
    regulatory: {
      containsDigitalCreatedMedia: input.contains_digital_created_media ?? null,
      containsSensitiveContent: input.contains_sensitive_content ?? null,
      gatedType: nullableString(input.gated_type),
      isAaaEligible: input.is_aaa_eligible ?? null,
      regionalRegulationData: input.regional_regulation_data ?? null,
    },
    exactFingerprint: null,
    creativeFingerprint: null,
  };
}

export function normalizeAd(input: AdInput, options: NormalizerOptions = {}): NormalizedAdRecord[] {
  if (!input || typeof input.ad_archive_id !== 'string') {
    throw new Error('Invalid ad input: ad_archive_id is required');
  }
  const snapshot = input.snapshot ?? {};
  const cards = snapshot.cards ?? [];
  if (cards.length > 0) {
    return cards.map((card, index) => normalizeRecord(input, snapshot, card, index, options, input.collation_count ?? null));
  }
  return [normalizeRecord(input, snapshot, undefined, null, options, input.collation_count ?? null)];
}

export function normalizeAds(inputs: AdInput[], options: NormalizerOptions = {}): NormalizedAdRecord[] {
  return inputs.flatMap((input) => normalizeAd(input, options));
}
