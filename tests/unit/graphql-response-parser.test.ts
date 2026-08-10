import { describe, expect, it } from 'vitest';
import { fixtureAd, graphqlResponse, rateLimitResponse } from '../fixtures/graphql-response-fixture.js';
import { parseGraphQlResponse, parseSsrSearchResultsConnection } from '../../src/scraper/graphql-response-parser.js';

describe('GraphQL response parser', () => {
  it('extracts and deduplicates collated ads', () => {
    const result = parseGraphQlResponse(graphqlResponse([fixtureAd('1'), fixtureAd('1'), fixtureAd('2')], true, 'cursor'));
    expect(result.batch?.sourceIds).toEqual(['1', '2']);
    expect(result.batch?.hasNextPage).toBe(true);
    expect(result.batch?.endCursor).toBe('cursor');
  });
  it('ignores invalid GraphQL ads while retaining valid ads in the batch', () => {
    const result = parseGraphQlResponse(graphqlResponse([{ page_name: 'invalid' } as never, fixtureAd('valid')], false));
    expect(result.classification).toBe('recognized');
    expect(result.batch?.sourceIds).toEqual(['valid']);
  });
  it('prioritizes final rate limit', () => expect(parseGraphQlResponse(rateLimitResponse).finalRateLimit).toBe(true));
  it('classifies empty recognized connections', () => {
    const result = parseGraphQlResponse({ data: { ad_library_main: { search_results_connection: { edges: [] } } } });
    expect(result.classification).toBe('empty');
    expect(result.batch?.ads).toEqual([]);
  });
  it.each([null, { data: {} }, { data: { ad_library_main: { search_results_connection: { edges: {} } } } }])('classifies malformed payloads as unrecognized', (payload) => {
    expect(parseGraphQlResponse(payload).classification).toBe('unrecognized');
  });
  it('does not classify final rate limits as empty', () => expect(parseGraphQlResponse(rateLimitResponse).classification).toBe('finalRateLimit'));
  it.each([
    '<script>{"bootstrap":{"search_results_connection":{"edges":[{"node":{"collated_results":[{"ad_archive_id":"ssr-1"}]}}],"page_info":{"has_next_page":true}}}}</script>',
    '<script>"ignored"</script><script>{"data":{"nested":{"search_results_connection":{"edges":[],"page_info":{"has_next_page":false}}}}}</script>',
    '<div><script type="application/json">{"x":[{"search_results_connection":{"edges":[{"node":{"collated_results":[{"ad_archive_id":"ssr-2"}]}}],"page_info":{"has_next_page":false}}}]}</script></div>',
  ])('extracts SSR connections from arbitrary nested positions', (html) => expect(parseSsrSearchResultsConnection(html).classification).not.toBe('absent'));
  it('does not turn incomplete SSR into an empty batch', () => {
    expect(parseSsrSearchResultsConnection('<script>{"search_results_connection":{"edges":[]}}</script>')).toMatchObject({ classification: 'incomplete' });
  });
  it('rejects SSR connections containing an ad without an archive id', () => {
    const html = '<script>{"search_results_connection":{"edges":[{"node":{"collated_results":[{"page_name":"invalid"}]}}],"page_info":{"has_next_page":false}}}</script>';
    expect(parseSsrSearchResultsConnection(html)).toMatchObject({ classification: 'incomplete' });
  });
  it('continues past an incomplete SSR sibling to find a valid connection', () => {
    const html = '<script>{"first":{"search_results_connection":{"edges":[{"node":{"collated_results":[{"invalid":true}]}}],"page_info":{"has_next_page":false}}},"second":{"search_results_connection":{"edges":[{"node":{"collated_results":[{"ad_archive_id":"later-valid"}]}}],"page_info":{"has_next_page":false}}}}</script>';
    expect(parseSsrSearchResultsConnection(html)).toMatchObject({ classification: 'recognized', batch: { sourceIds: ['later-valid'] } });
  });
  it('returns incomplete when all SSR connections are incomplete', () => {
    const html = '<script>{"first":{"search_results_connection":{"edges":[],"page_info":{}}},"second":{"search_results_connection":{"edges":[{"node":{"collated_results":[{"invalid":true}]}}],"page_info":{"has_next_page":false}}}}</script>';
    expect(parseSsrSearchResultsConnection(html)).toMatchObject({ classification: 'incomplete' });
  });
});
