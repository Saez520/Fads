import type { AdInput } from '../../src/domain/ad-input.js';

export function graphqlResponse(ads: AdInput[], hasNextPage = false, endCursor: string | null = null): unknown {
  return { data: { ad_library_main: { search_results_connection: { edges: [{ node: { collated_results: ads } }], page_info: { has_next_page: hasNextPage, end_cursor: endCursor } } } } };
}
export const fixtureAd = (id: string): AdInput => ({ ad_archive_id: id, page_name: 'Example', snapshot: { body: 'body', title: 'title', link_url: 'https://example.test' } });
export const rateLimitResponse = { errors: [{ message: 'Rate limit exceeded', severity: 'CRITICAL', code: 1675004 }], extensions: { is_final: true } };
