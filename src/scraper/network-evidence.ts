import { randomUUID } from 'node:crypto';
import type { BrowserPageRequest, DiagnosticDomSignals, DiagnosticPrimaryClassification, NetworkEvidenceClassification, NetworkEvidenceHop } from './scraper-types.js';

export interface NetworkEvidenceInput {
  responsePresent: boolean;
  status?: number;
  contentType?: string;
  url?: string;
  body?: string;
  bodyLimitBytes?: number;
  kind?: 'document' | 'network_failure';
  failureText?: string;
  hops?: NetworkEvidenceHop[];
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
  kind?: 'document' | 'network_failure';
  failureText?: string;
  hops?: NetworkEvidenceHop[];
  classification?: NetworkEvidenceClassification;
}

export type NetworkEvidenceSummary = Omit<NetworkEvidence, 'body' | 'bodyTruncated'>;

const MAX_BODY_BYTES = 32 * 1024;
const DOCUMENT_ERROR_STATUS = new Set([403, 429, 451]);

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

export function sanitizeDiagnosticText(value: string, limit = 500): string {
  const scrubbed = redactNetworkText(value).replace(/<[^>]*>/g, '[html]').replace(/[\r\n]+/g, ' ').trim();
  return scrubbed.length > limit ? `${scrubbed.slice(0, limit)}…` : scrubbed;
}

export function classifyDiagnostic(signals: DiagnosticDomSignals, networkFailure = false, httpBlock = false): DiagnosticPrimaryClassification {
  if (networkFailure) return 'network_failure';
  if (httpBlock || signals.challenge) return 'challenge_or_http_block';
  if (signals.captcha) return 'captcha';
  if (signals.ssrResults) return 'ssr_results';
  if (signals.explicitEmpty) return 'explicit_empty';
  if (signals.login) return 'login_required';
  if (signals.shellWithoutResults) return 'shell_without_results';
  return 'unknown';
}

function truncateUtf8(value: string, limit: number): { value: string; truncated: boolean } {
  const safeLimit = effectiveBodyLimit(limit);
  if (Buffer.byteLength(value, 'utf8') <= safeLimit) return { value, truncated: false };
  let end = Math.min(value.length, safeLimit);
  while (end > 0 && Buffer.byteLength(value.slice(0, end), 'utf8') > safeLimit) end--;
  return { value: value.slice(0, end), truncated: true };
}

export function effectiveBodyLimit(limit?: number): number {
  if (limit === undefined || !Number.isFinite(limit)) return MAX_BODY_BYTES;
  return Math.min(Math.max(Math.floor(limit), 1), MAX_BODY_BYTES);
}

export function buildNetworkEvidence(input: NetworkEvidenceInput): NetworkEvidence {
  const evidenceId = randomUUID();
  const evidence: NetworkEvidence = {
    evidenceId,
    logReference: `scraper.network_evidence:${evidenceId}`,
    responsePresent: input.responsePresent,
    bodyTruncated: false,
    ...(input.kind ? { kind: input.kind } : {}),
    ...(input.failureText ? { failureText: redactNetworkText(input.failureText) } : {}),
    ...(input.hops ? { hops: input.hops } : {}),
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

export function isEligibleDocument(request: BrowserPageRequest | undefined): boolean {
  if (!request) return false;
  const resourceType = request.resourceType?.();
  return resourceType === 'document' && !isGraphQlUrl(request.url());
}

export function isGraphQlUrl(url: string): boolean { return /(?:\/|\?|&)graphql(?:\/|\?|&|$)/i.test(url) || /graphql/i.test(url); }

export async function redirectHops(request: BrowserPageRequest): Promise<NetworkEvidenceHop[]> {
  const chain: BrowserPageRequest[] = [];
  let current: BrowserPageRequest | null | undefined = request;
  while (current) {
    chain.unshift(current);
    current = current.redirectedFrom?.() ?? null;
  }
  const hops: NetworkEvidenceHop[] = [];
  for (let index = 0; index < chain.length; index++) {
    const item = chain[index];
    let status: number | undefined;
    try { status = (await item.response?.())?.status?.(); } catch { status = undefined; }
    const destination = chain[index + 1]?.url();
    const hop = { url: sanitizeNetworkUrl(item.url()), ...(status !== undefined ? { status } : {}), ...(destination ? { destination: sanitizeNetworkUrl(destination) } : {}) };
    if (!hops.some((existing) => JSON.stringify(existing) === JSON.stringify(hop))) hops.push(hop);
  }
  return hops;
}

export function classifyNetworkEvidence(evidence: Pick<NetworkEvidence, 'status' | 'url' | 'body' | 'failureText' | 'hops' | 'kind'>): NetworkEvidenceClassification {
  const signals: string[] = [];
  if ((evidence.hops?.length ?? 0) > 1 || evidence.hops?.some((hop) => hop.destination && hop.destination !== hop.url)) signals.push('redirect hop or changed destination');
  const text = `${evidence.url ?? ''} ${evidence.body ?? ''}`;
  if (/login|log-in|signin|sign-in|checkpoint|auth/i.test(text)) signals.push('login-related URL or body text');
  if ((evidence.status !== undefined && (DOCUMENT_ERROR_STATUS.has(evidence.status) || evidence.status >= 500)) || /blocked|forbidden|rate.?limit|challenge|denied/i.test(text)) signals.push('HTTP block status or block-related text');
  if (evidence.kind === 'network_failure' || evidence.failureText) signals.push(evidence.failureText ? `request failure: ${evidence.failureText}` : 'request failed without a response');
  if (signals.some((signal) => signal.startsWith('redirect'))) return { label: 'possible_redirect', signals };
  if (signals.some((signal) => signal.startsWith('login'))) return { label: 'possible_login', signals };
  if (signals.some((signal) => signal.startsWith('HTTP'))) return { label: 'possible_http_block', signals };
  if (signals.some((signal) => signal.startsWith('request'))) return { label: 'possible_network_failure', signals };
  return { label: 'unknown', signals: ['no explicit diagnostic signal'] };
}

export function networkEvidenceSummary(evidence: NetworkEvidence): NetworkEvidenceSummary {
  const { body: _body, bodyTruncated: _bodyTruncated, ...summary } = evidence;
  return summary;
}
