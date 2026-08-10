import type { AdInput } from '../domain/ad-input.js';
import type { GraphQlError, GraphQlParseResult, SsrParseResult } from './scraper-types.js';

const endpoint = 'https://www.facebook.com/api/graphql/';
function record(value: unknown): Record<string, unknown> | null { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null; }
type ConnectionMode = 'SSR' | 'GraphQL';

function batchFromConnection(connection: Record<string, unknown>, mode: ConnectionMode): SsrParseResult {
  if (!Array.isArray(connection.edges)) return { classification: 'incomplete' };
  const pageInfo = record(connection.page_info);
  if (mode === 'SSR' && typeof pageInfo?.has_next_page !== 'boolean') return { classification: 'incomplete' };
  const ads: AdInput[] = [];
  const ids = new Set<string>();
  for (const edge of connection.edges) {
    const node = record(record(edge)?.node);
    const collated = node && Array.isArray(node.collated_results) ? node.collated_results : [];
    for (const item of collated) {
      const ad = record(item);
      if (typeof ad?.ad_archive_id !== 'string') {
        if (mode === 'SSR') return { classification: 'incomplete' };
        continue;
      }
      if (ids.has(ad.ad_archive_id)) continue;
      ids.add(ad.ad_archive_id);
      ads.push(ad as unknown as AdInput);
    }
  }
  return {
    classification: ads.length === 0 ? 'empty' : 'recognized',
    batch: { ads, sourceIds: [...ids], hasNextPage: pageInfo?.has_next_page === true, endCursor: typeof pageInfo?.end_cursor === 'string' ? pageInfo.end_cursor : null },
  };
}

function walk(value: unknown, visit: (value: Record<string, unknown>) => SsrParseResult | undefined): SsrParseResult | undefined {
  const object = record(value);
  if (object) {
    const result = visit(object);
    if (result) return result;
    for (const child of Object.values(object)) {
      const nested = walk(child, visit);
      if (nested) return nested;
    }
  } else if (Array.isArray(value)) {
    for (const child of value) {
      const nested = walk(child, visit);
      if (nested) return nested;
    }
  } else if (typeof value === 'string' && /^[\[{]/.test(value.trim())) {
    try { return walk(JSON.parse(value), visit); } catch { /* serialized framework metadata */ }
  }
  return undefined;
}

function jsonCandidates(html: string): unknown[] {
  const candidates: unknown[] = [];
  const add = (text: string): void => {
    try { candidates.push(JSON.parse(text)); } catch {
      try { candidates.push(JSON.parse(text.replace(/&quot;/g, '"').replace(/\\u003C/g, '<').replace(/\\u003E/g, '>').replace(/\\u0026/g, '&'))); } catch { /* incidental script */ }
    }
  };
  for (const match of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)) add(match[1].trim());
  for (const match of html.matchAll(/\{[\s\S]{0,200000}?search_results_connection[\s\S]{0,200000}?\}/gi)) add(match[0]);
  return candidates;
}

/** Finds a valid SSR connection anywhere in serialized HTML, independent of script order. */
export function parseSsrSearchResultsConnection(html: string): SsrParseResult {
  let found = false;
  for (const candidate of jsonCandidates(html)) {
    const result = walk(candidate, (object) => {
      if (!Object.prototype.hasOwnProperty.call(object, 'search_results_connection')) return undefined;
      found = true;
      const connection = record(object.search_results_connection);
      const parsed = connection ? batchFromConnection(connection, 'SSR') : { classification: 'incomplete' as const };
      return parsed.classification === 'incomplete' ? undefined : parsed;
    });
    if (result && result.classification !== 'incomplete') return result;
  }
  return { classification: found ? 'incomplete' : 'absent' };
}

export function isGraphQlEndpoint(url: string): boolean { return url === endpoint || url.startsWith(endpoint + '?'); }
export function parseGraphQlResponse(payload: unknown): GraphQlParseResult {
  const root = record(payload);
  const errors = Array.isArray(root?.errors) ? root.errors.map((e) => record(e)).filter((e): e is Record<string, unknown> => e !== null).map((e) => ({ ...e, extensions: record(e.extensions) ?? undefined }) as GraphQlError) : [];
  const topExtensions = record(root?.extensions);
  const finalRateLimit = errors.some((error) => error.message === 'Rate limit exceeded' && error.code === 1675004 && (error.extensions?.is_final === true || topExtensions?.is_final === true));
  const data = record(root?.data);
  const main = record(data?.ad_library_main);
  const connection = record(main?.search_results_connection);
  if (finalRateLimit) return { errors, relevant: false, finalRateLimit, classification: 'finalRateLimit', rawResponse: payload };
  if (!connection || !Array.isArray(connection.edges)) return { errors, relevant: false, finalRateLimit, classification: 'unrecognized', rawResponse: payload };
  const parsed = batchFromConnection(connection, 'GraphQL');
  if (!parsed.batch) return { errors, relevant: false, finalRateLimit, classification: 'unrecognized', rawResponse: payload };
  const batch = parsed.batch;
  return { batch, errors, relevant: true, finalRateLimit, classification: batch.ads.length === 0 ? 'empty' : 'recognized', rawResponse: payload };
}
