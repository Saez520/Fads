import type { Random, Sleeper } from './scraper-types.js';
export const THROTTLE_MIN_MS = 8_000;
export const THROTTLE_MAX_MS = 15_000;
export function throttleDelay(random: Random): number {
  const value = Math.min(1, Math.max(0, random()));
  return value >= 0.999 ? THROTTLE_MAX_MS : THROTTLE_MIN_MS + value * (THROTTLE_MAX_MS - THROTTLE_MIN_MS);
}
export async function waitForThrottle(sleep: Sleeper, random: Random): Promise<number> { const delay = throttleDelay(random); await sleep(delay); return delay; }
