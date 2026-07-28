import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { McpStore } from '../../src/mcp/mcp-store.js';
import type { McpTask } from '../../src/mcp/mcp-types.js';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
describe('McpStore', () => { it('persists atomically and interrupts active tasks', async () => { const root = await mkdtemp(join(tmpdir(), 'mcp-store-')); roots.push(root); const store = new McpStore({ ingestionRoot: join(root, 'ingestions'), taskRoot: join(root, 'tasks') }); const task: McpTask = { taskId: 't1', query: 'q', filtros: { operador: 'AND', filtros: [] }, status: 'ejecutando', createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(), progress: { etapa: 'x', procesados: 0 } }; await store.saveTask(task); await store.interruptActiveTasks(new Date(1).toISOString()); expect((await store.getTask('t1'))?.status).toBe('interrumpida'); expect((await readFile(join(root, 'tasks', 't1.json'), 'utf8'))).not.toContain('.tmp'); }); });
