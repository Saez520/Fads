import type { AdInput } from '../domain/ad-input.js';
import type { NormalizedAdRecord } from '../domain/ad-model.js';

export type ScrapeStatus = 'completa' | 'incompleta' | 'bloqueada';
export type StopReason = 'ad_limit' | 'end_of_results' | 'no_new_ads' | 'rate_limit' | 'retries_exhausted' | 'error';

export interface ScrapeRequest { query: string }
export interface ScrapeSummary { query: string; count: number; status: ScrapeStatus; stopReason: StopReason; durationMs: number }
export interface ScrapeEnvelope { query: string; records: NormalizedAdRecord[]; summary: ScrapeSummary; incomplete: boolean }

export type LoggerEvent =
  | { type: 'start' | 'finish' | 'batch' | 'persist' | 'blocked' | 'retry'; query: string; [key: string]: unknown };
export type Logger = (event: LoggerEvent) => void;
export interface Clock { now(): number }
export type Sleeper = (milliseconds: number) => Promise<void>;
export type Random = () => number;
export type CaptureWindow = (nextGraphQlResponse: Promise<void>) => Promise<void>;
export interface ResultWriter { write(envelope: ScrapeEnvelope): Promise<void> }

export interface BrowserPageResponse { url(): string; json(): Promise<unknown> }
export interface BrowserPage {
  on(event: 'response', listener: (response: BrowserPageResponse) => void | Promise<void>): void;
  goto(url: string): Promise<unknown>;
  evaluate(script: () => void): Promise<unknown>;
  close(): Promise<void>;
}
export interface BrowserContext { newPage(): Promise<BrowserPage>; close(): Promise<void> }
export interface Browser { newContext(options?: Record<string, unknown>): Promise<BrowserContext>; close(): Promise<void> }
export interface BrowserLauncher { launch(options: { headless: true }): Promise<Browser> }
export interface MetaAdScraperOptions {
  launcher?: BrowserLauncher;
  sleep?: Sleeper;
  random?: Random;
  clock?: Clock;
  logger?: Logger;
  captureWindow?: CaptureWindow;
  captureTimeoutMs?: number;
  onBatch?: (records: NormalizedAdRecord[]) => Promise<void> | void;
  maxSourceAds?: number;
}

export interface ParsedBatch { ads: AdInput[]; hasNextPage: boolean; endCursor: string | null; sourceIds: string[] }
export interface GraphQlError { message?: string; code?: number; severity?: string; extensions?: { is_final?: boolean; [key: string]: unknown } }
export interface GraphQlParseResult { batch?: ParsedBatch; errors: GraphQlError[]; relevant: boolean; finalRateLimit: boolean }

export function validateScrapeRequest(value: unknown): ScrapeRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Invalid scrape request');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).length !== 1 || !Object.hasOwn(input, 'query') || typeof input.query !== 'string' || input.query.trim() === '') {
    throw new Error('Invalid scrape request: query must be a non-empty string and no extra properties are allowed');
  }
  return { query: input.query.trim() };
}
