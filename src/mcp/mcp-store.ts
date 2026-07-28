import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import type { NormalizedAdRecord } from '../domain/ad-model.js';
import type { IngestionIndex } from '../ingestion/ingestion-types.js';
import { MCP_DEFAULTS, type ExtractionSummary, type McpTask } from './mcp-types.js';
import type { ExtractionStatus } from '../scraper/scraper-types.js';
import { ExecutionLogger } from './execution-logger.js';

export interface MpcStoreOptions { ingestionRoot?: string; taskRoot?: string }
export class McpStore {
  readonly ingestionRoot: string;
  readonly taskRoot: string;
  constructor(options: MpcStoreOptions = {}) { this.ingestionRoot = resolve(options.ingestionRoot ?? MCP_DEFAULTS.ingestionRoot); this.taskRoot = resolve(options.taskRoot ?? MCP_DEFAULTS.taskRoot); }
  async listExtractions(): Promise<ExtractionSummary[]> {
    let entries; try { entries = await readdir(this.ingestionRoot, { withFileTypes: true }); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e; }
    const result: ExtractionSummary[] = [];
    for (const entry of entries) { if (!entry.isDirectory() || entry.name.startsWith('.')) continue; try { const index = await this.readIndex(entry.name); result.push({ searchId: index.searchId, query: index.query, createdAt: index.createdAt, status: index.status, extractionStatus: index.extractionStatus ?? legacyExtractionStatus(index.status), totalRecords: index.totalRecords, durationMs: index.durationMs, ...(index.diagnostic ? { diagnostic: index.diagnostic } : {}) }); } catch { /* incomplete directories are not published */ } }
    return result.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async getExtraction(searchId: string): Promise<{ index: IngestionIndex; records: NormalizedAdRecord[] }> {
    const index = await this.readIndex(searchId); const raw = JSON.parse(await readFile(join(this.ingestionRoot, searchId, 'records.json'), 'utf8')) as unknown;
    if (!Array.isArray(raw)) throw new Error('INGESTION_NOT_FOUND');
    return { index: { ...index, extractionStatus: index.extractionStatus ?? legacyExtractionStatus(index.status) }, records: raw as NormalizedAdRecord[] };
  }
  async saveTask(task: McpTask): Promise<void> { await mkdir(this.taskRoot, { recursive: true }); new ExecutionLogger(this.taskRoot, task.taskId); const finalPath = join(this.taskRoot, `${task.taskId}.json`); const temporaryPath = join(this.taskRoot, `.${task.taskId}.${randomUUID()}.tmp`); try { await writeFile(temporaryPath, `${JSON.stringify(task)}\n`, 'utf8'); await rename(temporaryPath, finalPath); } finally { await rm(temporaryPath, { force: true }); } }
  getExecutionLogger(taskId: string): ExecutionLogger { return new ExecutionLogger(this.taskRoot, taskId); }
  async getTask(taskId: string): Promise<McpTask | undefined> { try { return JSON.parse(await readFile(join(this.taskRoot, `${taskId}.json`), 'utf8')) as McpTask; } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw e; } }
  async listTasks(): Promise<McpTask[]> { let entries; try { entries = await readdir(this.taskRoot); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e; } const tasks: McpTask[] = []; for (const name of entries) { if (!name.endsWith('.json')) continue; try { tasks.push(JSON.parse(await readFile(join(this.taskRoot, name), 'utf8')) as McpTask); } catch { /* ignore malformed state */ } } return tasks; }
  async interruptActiveTasks(now = new Date().toISOString()): Promise<McpTask[]> { const tasks = await this.listTasks(); const active = new Set(['pendiente', 'ejecutando', 'esperando_confirmacion']); const changed: McpTask[] = []; for (const task of tasks) { if (active.has(task.status)) { const next = { ...task, status: 'interrumpida' as const, updatedAt: now, progress: { ...task.progress, etapa: 'interrumpida' } }; await this.saveTask(next); changed.push(next); } } return changed; }
  private async readIndex(searchId: string): Promise<IngestionIndex> { try { const value = JSON.parse(await readFile(join(this.ingestionRoot, searchId, 'index.json'), 'utf8')) as IngestionIndex; if (!value || value.searchId !== searchId || typeof value.query !== 'string' || typeof value.createdAt !== 'string') throw new Error(); return value; } catch { throw new Error('INGESTION_NOT_FOUND'); } }
}
function legacyExtractionStatus(status: IngestionIndex['status']): ExtractionStatus { return status === 'failed' ? 'fallida' : status === 'partial' ? 'parcial' : 'completada'; }
export { McpStore as FileSystemMcpStore };
