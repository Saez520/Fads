import type { NormalizedAdRecord } from '../domain/ad-model.js';

export type IngestionStatus = 'running' | 'completed' | 'failed' | 'partial';

export interface IngestionIndex {
  searchId: string;
  query: string;
  createdAt: string;
  totalRecords: number;
  status: IngestionStatus;
  source: string;
  durationMs: number;
}

export interface IngestionWarning {
  recordIndex: number;
  message: string;
  logger?: string;
}

export interface IngestionError {
  message: string;
  code?: string;
}

export interface IngestionReference {
  searchId: string;
  ingestionPath: string;
  index: IngestionIndex;
}

export interface IngestionResult {
  success: boolean;
  warnings: IngestionWarning[];
  errors: IngestionError[];
  created: boolean;
  searchId?: string;
  ingestionPath?: string;
  index?: IngestionIndex;
}

export interface IngestionConfig {
  rootDirectory?: string;
  source?: string;
}

export interface Clock {
  now(): number;
}

export type SearchIdGenerator = () => string;
export type IngestionLogger = (warning: IngestionWarning) => void;
export type ConfirmRelaunch = (existing: IngestionReference, message: string) => boolean | Promise<boolean>;

export interface IngestionOperationOptions {
  clock?: Clock;
  searchIdGenerator?: SearchIdGenerator;
  logger?: IngestionLogger;
  confirmRelaunch?: ConfirmRelaunch;
}

export const DEFAULT_INGESTION_ROOT = 'data/ingestions/';
export const DEFAULT_INGESTION_SOURCE = 'scraper-v1';
export const DEFAULT_INGESTION_CONFIG: Required<IngestionConfig> = {
  rootDirectory: DEFAULT_INGESTION_ROOT,
  source: DEFAULT_INGESTION_SOURCE,
};

export interface IngestionStore {
  findByQuery(query: string): Promise<IngestionReference | undefined>;
  exists(searchId: string): Promise<boolean>;
  publish(index: IngestionIndex, records: NormalizedAdRecord[]): Promise<IngestionReference>;
}
