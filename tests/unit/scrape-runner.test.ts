import { describe, expect, it } from 'vitest';
import { decodeScrapeEnvelope } from '../../src/scraper/scrape-output.js';
import { validateScrapeRequest } from '../../src/scraper/scraper-types.js';

describe('scrape contracts', () => {
  it('accepts only one non-empty query', () => { expect(validateScrapeRequest({ query: ' diabetes ' })).toEqual({ query: 'diabetes' }); expect(() => validateScrapeRequest({ query: '' })).toThrow(); expect(() => validateScrapeRequest({ query: 'x', country: 'AR' })).toThrow(); });
  it('rejects malformed envelopes', () => expect(() => decodeScrapeEnvelope('{}')).toThrow());
});
