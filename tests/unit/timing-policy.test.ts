import { describe, expect, it } from 'vitest';
import { RETRY_BACKOFF_MS, waitForRetry } from '../../src/scraper/retry-policy.js';
import { throttleDelay } from '../../src/scraper/timing-policy.js';

describe('scraper timing policies', () => {
  it('uses inclusive throttle boundaries', () => { expect(throttleDelay(() => 0)).toBe(8000); expect(throttleDelay(() => 0.999999)).toBeCloseTo(15000); });
  it('has exactly three fixed backoffs', async () => { const waits: number[] = []; for (let i = 0; i < 4; i++) await waitForRetry(async (ms) => { waits.push(ms); }, i); expect(waits).toEqual([...RETRY_BACKOFF_MS]); });
});
