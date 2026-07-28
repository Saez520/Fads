export const DEFAULT_TRACKING_PARAMS = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'gclid',
  'fbclid',
  'dclid',
  'msclkid',
  'ttclid',
  'twclid',
]);

export interface NormalizerOptions {
  trackingParams?: ReadonlySet<string>;
}
