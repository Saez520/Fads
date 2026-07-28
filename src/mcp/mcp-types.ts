import type { NormalizedAdRecord } from '../domain/ad-model.js';

export const MCP_DEFAULTS = { ingestionRoot: 'data/ingestions/', taskRoot: 'data/mcp-tasks/', extractionsPageDefault: 20, adsPageDefault: 50, pageMax: 100 } as const;
export type FilterOperator = 'AND' | 'OR';
export type FilterField = 'texto' | 'anunciante' | 'plataforma' | 'activo' | 'fechaInicioDesde' | 'fechaInicioHasta' | 'formato' | 'cta' | 'searchId';
export interface McpSimpleFilter { campo: FilterField; valor: string | boolean | number }
export interface McpFilters { operador?: FilterOperator; filtros: McpSimpleFilter[] }
export interface PageRequest { cursor?: string; limit?: number }
export interface PageInfo { limit: number; nextCursor: string | null; total: number }
export type TaskStatus = 'pendiente' | 'ejecutando' | 'esperando_confirmacion' | 'completada' | 'parcial' | 'fallida' | 'interrumpida';
export interface TaskProgress { etapa: string; procesados: number; total?: number }
export interface TaskError { codigo: McpErrorCode; mensaje: string; detalle?: unknown }
export interface McpTask { taskId: string; query: string; filtros: McpFilters; status: TaskStatus; createdAt: string; updatedAt: string; progress: TaskProgress; searchId?: string; result?: SearchResult; error?: TaskError }
export interface StartSearchInput { query: string; filtros?: McpFilters; forceRelaunch?: boolean }
export interface SearchResult { searchId: string; query: string; createdAt: string; status: 'completada' | 'parcial' | 'fallida'; count: number; durationMs: number; warnings: string[]; errors: string[] }
export interface ExtractionSummary { searchId: string; query: string; createdAt: string; status: string; totalRecords: number; durationMs: number }
export interface FingerprintGroup { fingerprint: string; count: number; ejemplo?: NormalizedAdRecord; variantes?: Array<NormalizedAdRecord['copy']> }
export interface GroupSummary { exactos: FingerprintGroup[]; creativos: FingerprintGroup[]; sinFingerprint: number; sinCreativeFingerprint: number; duplicadosLiterales: FingerprintGroup[]; mismosCreativos: FingerprintGroup[]; }
export interface AdSearchResult { anuncios: NormalizedAdRecord[]; pagina: PageInfo }
export type McpErrorCode = 'TASK_NOT_FOUND' | 'INGESTION_NOT_FOUND' | 'GROUP_NOT_FOUND' | 'INVALID_FILTERS' | 'RELAUNCH_CONFIRMATION_REQUIRED' | 'INVALID_ARGUMENT' | 'INTERNAL_ERROR';
export interface SuccessEnvelope<T> { resultado: T }
export interface ErrorEnvelope { error: TaskError }
export type McpEnvelope<T> = SuccessEnvelope<T> | ErrorEnvelope;
export function ok<T>(resultado: T): SuccessEnvelope<T> { return { resultado }; }
export function fail(codigo: McpErrorCode, mensaje: string, detalle?: unknown): ErrorEnvelope { return { error: { codigo, mensaje, ...(detalle === undefined ? {} : { detalle }) } }; }
