export type Nullable<T> = T | null;

export type MediaType =
  | 'video_hd'
  | 'video_sd'
  | 'video_thumbnail'
  | 'image_original'
  | 'image_resized'
  | 'watermarked_video_hd'
  | 'watermarked_video_sd'
  | 'watermarked_image'
  | 'watermarked_image_resized';

export interface MediaReference {
  type: MediaType;
  url: string;
  mediaId: Nullable<string>;
}

export interface CreativeIdentity {
  mediaId: Nullable<string>;
  normalizedMediaUrl: Nullable<string>;
}

export interface AdProvenance {
  sourceAdId: string;
  collationId: Nullable<string>;
  collationCount: Nullable<number>;
  cardPosition: Nullable<number>;
}

export interface Advertiser {
  advertiserName: Nullable<string>;
  advertiserId: Nullable<string>;
  advertiserProfileUrl: Nullable<string>;
  profilePictureUrl: Nullable<string>;
  pageLikeCount: Nullable<number>;
}

export interface AdStatus {
  isActive: Nullable<boolean>;
  startDate: Nullable<number>;
  endDate: Nullable<number>;
  publisherPlatforms: string[];
  displayFormat: Nullable<string>;
}

export interface RegulatoryIndicators {
  containsDigitalCreatedMedia: Nullable<boolean>;
  containsSensitiveContent: Nullable<boolean>;
  gatedType: Nullable<string>;
  isAaaEligible: Nullable<boolean>;
  regionalRegulationData: Nullable<Record<string, unknown>>;
}

export interface AdCopy {
  bodyText: Nullable<string>;
  title: Nullable<string>;
  ctaText: Nullable<string>;
  ctaType: Nullable<string>;
  caption: Nullable<string>;
  linkDescription: Nullable<string>;
  destinationUrl: Nullable<string>;
}

export interface NormalizedAdRecord {
  provenance: AdProvenance;
  advertiser: Advertiser;
  status: AdStatus;
  copy: AdCopy;
  media: MediaReference[];
  creativeIdentity: CreativeIdentity;
  regulatory: RegulatoryIndicators;
  exactFingerprint: Nullable<string>;
  creativeFingerprint: Nullable<string>;
}
