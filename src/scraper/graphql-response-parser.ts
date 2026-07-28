import type { AdInput } from '../domain/ad-input.js';
import type { GraphQlError, GraphQlParseResult, ParsedBatch } from './scraper-types.js';

const endpoint = 'https://www.facebook.com/api/graphql/';
function record(value: unknown): Record<string, unknown> | null { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null; }

export function isGraphQlEndpoint(url: string): boolean { return url === endpoint || url.startsWith(endpoint + '?'); }
export function parseGraphQlResponse(payload: unknown): GraphQlParseResult {
  const root = record(payload);
  const errors = Array.isArray(root?.errors) ? root.errors.map((e) => record(e)).filter((e): e is Record<string, unknown> => e !== null).map((e) => ({ ...e, extensions: record(e.extensions) ?? undefined }) as GraphQlError) : [];
  const topExtensions = record(root?.extensions);
  const finalRateLimit = errors.some((error) => error.message === 'Rate limit exceeded' && error.code === 1675004 && (error.extensions?.is_final === true || topExtensions?.is_final === true));
  const data = record(root?.data);
  const main = record(data?.ad_library_main);
  const connection = record(main?.search_results_connection);
  if (!connection || !Array.isArray(connection.edges)) return { errors, relevant: false, finalRateLimit };
  const ads: AdInput[] = [];
  const ids = new Set<string>();
  for (const edge of connection.edges) {
    const node = record(record(edge)?.node);
    const collated = node && Array.isArray(node.collated_results) ? node.collated_results : [];
    for (const item of collated) {
      const ad = record(item);
      if (typeof ad?.ad_archive_id !== 'string' || ids.has(ad.ad_archive_id)) continue;
      ids.add(ad.ad_archive_id); ads.push(ad as unknown as AdInput);
    }
  }
  const pageInfo = record(connection.page_info);
  const batch: ParsedBatch = { ads, sourceIds: [...ids], hasNextPage: pageInfo?.has_next_page === true, endCursor: typeof pageInfo?.end_cursor === 'string' ? pageInfo.end_cursor : null };
  return { batch, errors, relevant: true, finalRateLimit };
}
