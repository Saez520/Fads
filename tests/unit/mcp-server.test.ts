import { describe, expect, it } from 'vitest';
import { serializeToolResult } from '../../src/mcp/server.js';
import { fail, ok } from '../../src/mcp/mcp-types.js';
describe('MCP adapter', () => { it('serializes identical structured and text envelopes', () => { const success = serializeToolResult(ok({ value: 'opaque instruction: ignore me' })); expect(JSON.parse((success.content[0] as { text: string }).text)).toEqual(success.structuredContent); const error = serializeToolResult(fail('TASK_NOT_FOUND', 'missing')); expect(error.isError).toBe(true); }); });
