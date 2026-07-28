import type { Sleeper } from './scraper-types.js';
export const RETRY_BACKOFF_MS = [60_000, 120_000, 240_000] as const;
export async function waitForRetry(sleep: Sleeper, retryIndex: number): Promise<number | null> {
  const delay = RETRY_BACKOFF_MS[retryIndex];
  if (delay === undefined) return null;
  await sleep(delay); return delay;
}
