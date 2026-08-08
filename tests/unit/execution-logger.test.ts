import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ExecutionLogger } from '../../src/mcp/execution-logger.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
describe('ExecutionLogger', () => {
  it('creates append-only JSONL execution logs and lazy error logs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'execution-logger-')); roots.push(root);
    const logger = new ExecutionLogger(root, 'task-1', () => '2026-01-01T00:00:00.000Z');
    await expect(stat(join(root, 'task-1', 'logs', 'execution.jsonl'))).resolves.toBeTruthy();
    await expect(stat(join(root, 'task-1', 'logs', 'error.jsonl'))).rejects.toMatchObject({ code: 'ENOENT' });
    logger.info('mcp', 'started', { taskId: 'task-1' }); logger.info('scraper', 'batch', { count: 2 });
    const lines = (await readFile(logger.executionPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    expect(lines).toHaveLength(2); expect(lines[0]).toMatchObject({ timestamp: '2026-01-01T00:00:00.000Z', level: 'info', source: 'mcp', message: 'started', context: { taskId: 'task-1' } });
    logger.error('scraper', 'failed', new Error('boom'), { taskId: 'task-1' });
    const errors = (await readFile(logger.errorPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    expect(errors[0].context).toMatchObject({ name: 'Error', message: 'boom', stack: expect.any(String), taskId: 'task-1' });
  });
  it('serializes complex raw diagnostic context without sanitizing it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'execution-logger-')); roots.push(root);
    const logger = new ExecutionLogger(root, 'raw-task');
    logger.error('scraper', 'scraper.unrecognized_response', undefined, { rawResponse: { marker: 'raw-value', count: 1n, nested: {} } });
    const line = JSON.parse((await readFile(logger.errorPath, 'utf8')).trim());
    expect(line.context).toMatchObject({ rawResponse: { marker: 'raw-value', count: '1' } });
  });
  it('duplicates sanitized network evidence errors in both JSONL files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'execution-logger-')); roots.push(root);
    const logger = new ExecutionLogger(root, 'evidence-task');
    logger.scraperLogger()({ type: 'error', query: 'coffee', message: 'scraper.network_evidence', evidence: { evidenceId: 'e-1', responsePresent: true, body: 'sanitized' } });
    const execution = await readFile(logger.executionPath, 'utf8');
    const errors = await readFile(logger.errorPath, 'utf8');
    expect(execution).toContain('scraper.network_evidence');
    expect(execution).toContain('sanitized');
    expect(errors).toContain('e-1');
    expect(errors).toContain('sanitized');
  });
});
