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
  it('buffers low-priority diagnostics, drops them before high priority data, and keeps one truncation marker', async () => {
    const root = await mkdtemp(join(tmpdir(), 'execution-logger-')); roots.push(root);
    const logger = new ExecutionLogger(root, 'budget-task');
    for (let index = 0; index < 400; index++) logger.logDiagnostic({ family: 'runtime', type: 'diagnostic.runtime', kind: 'console', message: 'x'.repeat(1200), priority: 'low' }, false);
    logger.logDiagnostic({ family: 'runtime', type: 'diagnostic.runtime', kind: 'pageerror', message: 'high-priority', priority: 'high' }, true);
    logger.diagnosticSummary({ family: 'summary', type: 'diagnostic.summary', primary: 'unknown', secondary: [], signals: { challenge: false, captcha: false, login: false, ssrResults: false, explicitEmpty: false, shellWithoutResults: true, resultCount: 0, connectionCount: 0 }, durationMs: 1, eventCount: 401, droppedEvents: logger.droppedDiagnosticEvents, diagnosticIncomplete: logger.diagnosticIncomplete });
    const content = await readFile(logger.diagnosticPath, 'utf8');
    expect(Buffer.byteLength(content)).toBeLessThanOrEqual(256 * 1024);
    expect(content.match(/diagnostic\.truncated/g)?.length ?? 0).toBeLessThanOrEqual(1);
    expect(content).toContain('high-priority');
    expect(logger.droppedDiagnosticEvents).toBeGreaterThan(0);
  });
  it('removes prohibited secret keys recursively from diagnostics', async () => {
    const root = await mkdtemp(join(tmpdir(), 'execution-logger-')); roots.push(root);
    const logger = new ExecutionLogger(root, 'secret-task');
    logger.diagnosticSummary({ family: 'summary', type: 'diagnostic.summary', primary: 'unknown', secondary: [], signals: { challenge: false, captcha: false, login: false, ssrResults: false, explicitEmpty: false, shellWithoutResults: true, resultCount: 0, connectionCount: 0 }, durationMs: 1, eventCount: 1, droppedEvents: 0, diagnosticIncomplete: false, metadata: { authorization: 'secret', nested: { cookie: 'value', safe: 'ok' } } } as never);
    const content = await readFile(logger.diagnosticPath, 'utf8');
    expect(content).not.toContain('secret'); expect(content).not.toContain('value'); expect(content).toContain('safe');
  });
});
