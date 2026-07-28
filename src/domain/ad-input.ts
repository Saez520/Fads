export interface AdMediaInput {
  media_id?: string | null;
  id?: string | null;
  video_hd_url?: string | null;
  video_sd_url?: string | null;
  video_preview_image_url?: string | null;
  watermarked_video_hd_url?: string | null;
  watermarked_video_sd_url?: string | null;
  original_image_url?: string | null;
  resized_image_url?: string | null;
  watermarked_resized_image_url?: string | null;
  [key: string]: unknown;
}

export interface AdCardInput extends AdMediaInput {
  body?: string | null;
  title?: string | null;
  caption?: string | null;
  link_description?: string | null;
  link_url?: string | null;
  cta_text?: string | null;
  cta_type?: string | null;
}

export interface AdSnapshotInput extends AdMediaInput {
  page_name?: string | null;
  page_id?: string | null;
  page_profile_uri?: string | null;
  page_profile_picture_url?: string | null;
  page_like_count?: number | null;
  body?: string | { text?: string | null } | null;
  title?: string | null;
  cta_text?: string | null;
  cta_type?: string | null;
  caption?: string | null;
  link_description?: string | null;
  link_url?: string | null;
  display_format?: string | null;
  cards?: AdCardInput[] | null;
  videos?: AdMediaInput[] | null;
  images?: AdMediaInput[] | null;
  [key: string]: unknown;
}

export interface AdInput {
  ad_archive_id: string;
  collation_id?: string | null;
  collation_count?: number | null;
  page_name?: string | null;
  page_id?: string | null;
  is_active?: boolean | null;
  start_date?: number | null;
  end_date?: number | null;
  publisher_platform?: string[] | null;
  contains_digital_created_media?: boolean | null;
  contains_sensitive_content?: boolean | null;
  gated_type?: string | null;
  is_aaa_eligible?: boolean | null;
  regional_regulation_data?: Record<string, unknown> | null;
  snapshot?: AdSnapshotInput | null;
  [key: string]: unknown;
}
