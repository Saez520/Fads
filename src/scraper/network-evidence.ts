import { randomUUID } from 'node:crypto';

export interface NetworkEvidenceInput {
  responsePresent: boolean;
  status?: number;
  contentType?: string;
  url?: string;
  body?: string;
  bodyLimitBytes?: number;
}

export interface NetworkEvidence {
  evidenceId: string;
  logReference: string;
  responsePresent: boolean;
  status?: number;
  contentType?: string;
  url?: string;
  body?: string;
  bodyTruncated: boolean;
}

export type NetworkEvidenceSummary = Omit<NetworkEvidence, 'body' | 'bodyTruncated'>;

// Match complete credential field names, including the common snake/kebab/camel
// case variants, rather than any field that merely contains a sensitive word.
// This keeps diagnostic fields such as `session_title` or `tokenCount` intact.
const SENSITIVE_KEY = /^(?:cookie(?:[_-]?value)?|authorization|token|secret|password|session(?:[_-]?id)?|sid|csrf(?:[_-]?token)?|xsrf(?:[_-]?token)?|api[_-]?key|access[_-]?(?:key|token)|refresh[_-]?(?:key|token)|id[_-]?token)$/i;
const SENSITIVE_KEY_SOURCE = SENSITIVE_KEY.source.slice(1, -1);
const BEARER = /(Bearer\s+)[^\s,;]+/gi;
const JWT = /\b(?:eyJ[a-zA-Z0-9_-]{8,}\.){2}[a-zA-Z0-9_-]+\b/g;
const SECRET = /\b(?:sk|pk|ghp|xox[baprs])_[a-zA-Z0-9_-]{8,}\b/gi;

export function redactNetworkText(value: string): string {
  return value
    .replace(BEARER, '$1[redacted]')
    .replace(JWT, '[redacted]')
    .replace(SECRET, '[redacted]')
    .replace(new RegExp(`([?&](?:${SENSITIVE_KEY_SOURCE})=)[^&#\\s]*`, 'gi'), '$1[redacted]')
    .replace(new RegExp(`((?:"|\\b)(?:${SENSITIVE_KEY_SOURCE})(?:"|)\\s*:\\s*)(?:"[^"]*"|[^\\s,;&}]+)`, 'gi'), '$1[redacted]')
    .replace(new RegExp(`((?:${SENSITIVE_KEY_SOURCE})\\s*[:=]\\s*)(?:Bearer\\s+)?[^\\s,;&}]+`, 'gi'), '$1[redacted]');
}

export function sanitizeNetworkUrl(url: string): string {
  try {
    const parsed = new URL(url);
    for (const key of [...parsed.searchParams.keys()]) if (SENSITIVE_KEY.test(key)) parsed.searchParams.set(key, '[redacted]');
    return redactNetworkText(parsed.toString());
  } catch {
    return redactNetworkText(url);
  }
}

function truncateUtf8(value: string, limit: number): { value: string; truncated: boolean } {
  const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 32 * 1024;
  if (Buffer.byteLength(value, 'utf8') <= safeLimit) return { value, truncated: false };
  let end = Math.min(value.length, safeLimit);
  while (end > 0 && Buffer.byteLength(value.slice(0, end), 'utf8') > safeLimit) end--;
  return { value: value.slice(0, end), truncated: true };
}

export function buildNetworkEvidence(input: NetworkEvidenceInput): NetworkEvidence {
  const evidenceId = randomUUID();
  const evidence: NetworkEvidence = {
    evidenceId,
    logReference: `scraper.network_evidence:${evidenceId}`,
    responsePresent: input.responsePresent,
    bodyTruncated: false,
    ...(input.status !== undefined ? { status: input.status } : {}),
    ...(input.contentType ? { contentType: redactNetworkText(input.contentType) } : {}),
    ...(input.url ? { url: sanitizeNetworkUrl(input.url) } : {}),
  };
  if (input.responsePresent && input.body !== undefined) {
    const limited = truncateUtf8(redactNetworkText(input.body), input.bodyLimitBytes ?? 32 * 1024);
    evidence.body = limited.value;
    evidence.bodyTruncated = limited.truncated;
  }
  return evidence;
}

export function networkEvidenceSummary(evidence: NetworkEvidence): NetworkEvidenceSummary {
  const { body: _body, bodyTruncated: _bodyTruncated, ...summary } = evidence;
  return summary;
}
