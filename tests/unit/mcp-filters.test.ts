import { describe, expect, it } from 'vitest';
import { decodeCursor, encodeCursor, normalizeText, validateFilters, validatePage } from '../../src/mcp/mcp-filters.js';
describe('MCP filters', () => {
  it('normalizes accents and cursors', () => { expect(normalizeText('Árbol')).toBe('arbol'); expect(decodeCursor(encodeCursor(20))).toBe(20); });
  it('validates flat filters and pages', () => { expect(validateFilters({ filtros: [{ campo: 'texto', valor: 'árbol' }] }).operador).toBe('AND'); expect(validatePage(undefined, 20).limit).toBe(20); expect(() => validateFilters({ filtros: [{ campo: 'texto', valor: { nested: true } }] })).toThrow('INVALID_FILTERS'); expect(() => validatePage({ limit: 101 }, 20)).toThrow('INVALID_FILTERS'); });
});
