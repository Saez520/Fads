import { describe, expect, it } from 'vitest';
import { fixtureAd, graphqlResponse, rateLimitResponse } from '../fixtures/graphql-response-fixture.js';
import { parseGraphQlResponse } from '../../src/scraper/graphql-response-parser.js';

describe('GraphQL response parser', () => {
  it('extracts and deduplicates collated ads', () => {
    const result = parseGraphQlResponse(graphqlResponse([fixtureAd('1'), fixtureAd('1'), fixtureAd('2')], true, 'cursor'));
    expect(result.batch?.sourceIds).toEqual(['1', '2']);
    expect(result.batch?.hasNextPage).toBe(true);
    expect(result.batch?.endCursor).toBe('cursor');
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
});
