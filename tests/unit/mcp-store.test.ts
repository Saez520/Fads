import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { McpStore } from '../../src/mcp/mcp-store.js';
import type { McpTask } from '../../src/mcp/mcp-types.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const task = (taskId: string): McpTask => ({ taskId, query: 'q', filtros: { operador: 'AND', filtros: [] }, status: 'ejecutando', createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(), progress: { etapa: 'x', procesados: 0 } });

describe('McpStore', () => {
  it('persists atomically and interrupts active tasks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mcp-store-')); roots.push(root);
    const store = new McpStore({ ingestionRoot: join(root, 'ingestions'), taskRoot: join(root, 'tasks') });
    await store.saveTask(task('t1')); await store.interruptActiveTasks(new Date(1).toISOString());
    expect((await store.getTask('t1'))?.status).toBe('interrumpida');
    expect(await readFile(join(root, 'tasks', 't1.json'), 'utf8')).not.toContain('.tmp');
    expect(await readFile(join(root, 'tasks', 't1', 'logs', 'execution.jsonl'), 'utf8')).toContain('');
  });
  it('initializes logs idempotently and preserves existing events', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mcp-store-')); roots.push(root);
    const store = new McpStore({ taskRoot: join(root, 'tasks') });
    await store.saveTask(task('t2')); store.getExecutionLogger('t2').info('mcp', 'kept'); await store.saveTask(task('t2'));
    const lines = (await readFile(join(root, 'tasks', 't2', 'logs', 'execution.jsonl'), 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(1); expect(JSON.parse(lines[0]).message).toBe('kept');
  });
});
