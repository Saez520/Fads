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
  it('ignores malformed payloads', () => expect(parseGraphQlResponse({ data: {} }).batch).toBeUndefined());
});
