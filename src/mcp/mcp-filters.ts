import type { NormalizedAdRecord } from '../domain/ad-model.js';
import { MCP_DEFAULTS, type AdSearchResult, type FilterField, type McpFilters, type McpSimpleFilter, type PageInfo } from './mcp-types.js';

export function normalizeText(value: string): string { return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase(); }
export function encodeCursor(offset: number): string { if (!Number.isInteger(offset) || offset < 0) throw new Error('INVALID_FILTERS'); return Buffer.from(String(offset), 'utf8').toString('base64url'); }
export function decodeCursor(cursor: string | undefined): number { if (cursor === undefined) return 0; try { const value = Buffer.from(cursor, 'base64url').toString('utf8'); if (!/^\d+$/.test(value)) throw new Error(); const offset = Number(value); if (!Number.isSafeInteger(offset)) throw new Error(); return offset; } catch { throw new Error('INVALID_FILTERS'); } }
export function validatePage(input: { cursor?: unknown; limit?: unknown } | undefined, defaultLimit: number): { offset: number; limit: number } {
  if (input?.cursor !== undefined && typeof input.cursor !== 'string') throw new Error('INVALID_FILTERS');
  const limit = input?.limit === undefined ? defaultLimit : input.limit;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > MCP_DEFAULTS.pageMax) throw new Error('INVALID_FILTERS');
  return { offset: decodeCursor(input?.cursor as string | undefined), limit };
}
const fields = new Set<FilterField>(['texto', 'anunciante', 'plataforma', 'activo', 'fechaInicioDesde', 'fechaInicioHasta', 'formato', 'cta', 'searchId']);
export function validateFilters(input: unknown): McpFilters {
  if (input === undefined) return { operador: 'AND', filtros: [] };
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('INVALID_FILTERS');
  const root = input as Record<string, unknown>;
  if (Object.keys(root).some((key) => !['operador', 'filtros'].includes(key)) || !Array.isArray(root.filtros)) throw new Error('INVALID_FILTERS');
  const operador = root.operador === undefined ? 'AND' : root.operador;
  if (operador !== 'AND' && operador !== 'OR') throw new Error('INVALID_FILTERS');
  const filtros = root.filtros.map((item): McpSimpleFilter => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('INVALID_FILTERS');
    const value = item as Record<string, unknown>;
    if (Object.keys(value).length !== 2 || typeof value.campo !== 'string' || !fields.has(value.campo as FilterField) || (typeof value.valor !== 'string' && typeof value.valor !== 'boolean' && typeof value.valor !== 'number')) throw new Error('INVALID_FILTERS');
    return { campo: value.campo as FilterField, valor: value.valor as string | boolean | number };
  });
  return { operador, filtros };
}
function json(record: NormalizedAdRecord): string { return normalizeText(JSON.stringify(record)); }
export function matchesFilter(record: NormalizedAdRecord, filter: McpSimpleFilter, searchId?: string): boolean {
  const value = filter.valor;
  switch (filter.campo) {
    case 'texto': return json(record).includes(normalizeText(String(value)));
    case 'anunciante': return normalizeText(record.advertiser.advertiserName ?? '').includes(normalizeText(String(value)));
    case 'plataforma': return record.status.publisherPlatforms.some((p) => normalizeText(p).includes(normalizeText(String(value))));
    case 'activo': return record.status.isActive === value;
    case 'fechaInicioDesde': return (record.status.startDate ?? -Infinity) >= Number(value);
    case 'fechaInicioHasta': return (record.status.startDate ?? Infinity) <= Number(value);
    case 'formato': return normalizeText(record.status.displayFormat ?? '').includes(normalizeText(String(value)));
    case 'cta': return normalizeText(`${record.copy.ctaText ?? ''} ${record.copy.ctaType ?? ''}`).includes(normalizeText(String(value)));
    case 'searchId': return searchId === String(value);
  }
  return false;
}
export function matchesFilters(record: NormalizedAdRecord, filters: McpFilters, searchId?: string): boolean { const results = filters.filtros.map((f) => matchesFilter(record, f, searchId)); return filters.operador === 'OR' ? results.some(Boolean) : results.every(Boolean); }
export function paginate<T>(items: T[], input: { cursor?: unknown; limit?: unknown } | undefined, defaultLimit: number): { items: T[]; page: PageInfo } {
  const { offset, limit } = validatePage(input, defaultLimit); const itemsPage = items.slice(offset, offset + limit);
  return { items: itemsPage, page: { limit, nextCursor: offset + itemsPage.length < items.length ? encodeCursor(offset + itemsPage.length) : null, total: items.length } };
}
export function searchRecords(records: NormalizedAdRecord[], filters: McpFilters, searchId?: string, page?: { cursor?: unknown; limit?: unknown }): AdSearchResult { const found = records.filter((r) => matchesFilters(r, filters, searchId)); const result = paginate(found, page, MCP_DEFAULTS.adsPageDefault); return { anuncios: result.items, pagina: result.page }; }
