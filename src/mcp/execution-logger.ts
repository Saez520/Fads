import { appendFileSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { DiagnosticEvent, DiagnosticSummary, Logger, LoggerEvent } from '../scraper/scraper-types.js';

export type ExecutionLogLevel = 'info' | 'warn' | 'error';
export type ExecutionLogSource = 'mcp' | 'scraper';
export interface ExecutionLogEvent { timestamp: string; level: ExecutionLogLevel; source: ExecutionLogSource; message: string; context: Record<string, unknown> }
export const EXECUTION_LOG_BUDGET = 512 * 1024;
export const ERROR_LOG_BUDGET = 256 * 1024;
export const DIAGNOSTIC_LOG_BUDGET = 256 * 1024;
export const TOTAL_LOG_BUDGET = 1024 * 1024;

function jsonSafe(value: unknown): unknown {
  const seen = new WeakSet<object>();
  return JSON.parse(JSON.stringify(value, (_key, item: unknown) => {
    if (item instanceof Error) return { name: item.name, message: item.message, stack: item.stack };
    if (typeof item === 'bigint') return item.toString();
    if (item && typeof item === 'object') { if (seen.has(item)) return '[circular]'; seen.add(item); }
    return item;
  }) || 'null');
}
export const SECRET_KEYS = /^(?:cookie|authorization|token|secret|password|postdata|headers?|html|dom|body|har|trace|screenshot|fb_dtsg|lsd)$/i;
export function diagnosticSafe(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(diagnosticSafe);
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) if (!SECRET_KEYS.test(key)) result[key] = diagnosticSafe(item);
    return result;
  }
  return typeof value === 'string' ? value.replace(/(?:bearer\s+|authorization\s*[:=]\s*|cookie\s*[:=]\s*)[^\s,;]+/gi, '[redacted]') : value;
}

export class ExecutionLogger {
  readonly directory: string;
  readonly executionPath: string;
  readonly errorPath: string;
  readonly diagnosticPath: string;
  private diagnosticDropped = 0;
  private diagnosticTruncatedWritten = false;
  private diagnosticActivated = false;
  private pendingDiagnostics: DiagnosticEvent[] = [];
  private _diagnosticSummary?: DiagnosticSummary;
  private diagnosticEvents = 0;
  constructor(taskRoot: string, taskId: string, private readonly clock: () => string = () => new Date().toISOString()) {
    try {
      this.directory = resolve(taskRoot, taskId, 'logs');
      this.executionPath = join(this.directory, 'execution.jsonl');
      this.errorPath = join(this.directory, 'error.jsonl');
      this.diagnosticPath = join(this.directory, 'diagnostic.jsonl');
      mkdirSync(this.directory, { recursive: true });
      writeFileSync(this.executionPath, '', { flag: 'a' });
    } catch {
      this.directory = join(taskRoot, taskId, 'logs');
      this.executionPath = join(this.directory, 'execution.jsonl');
      this.errorPath = join(this.directory, 'error.jsonl');
      this.diagnosticPath = join(this.directory, 'diagnostic.jsonl');
    }
  }
  log(level: ExecutionLogLevel, source: ExecutionLogSource, message: string, context: Record<string, unknown> = {}): void {
    const event: ExecutionLogEvent = { timestamp: this.clock(), level, source, message, context: jsonSafe(context) as Record<string, unknown> };
    this.appendBounded(this.executionPath, event, EXECUTION_LOG_BUDGET);
  }
  info(source: ExecutionLogSource, message: string, context?: Record<string, unknown>): void { this.log('info', source, message, context); }
  warn(source: ExecutionLogSource, message: string, context?: Record<string, unknown>): void { this.log('warn', source, message, context); }
  error(source: ExecutionLogSource, message: string, error?: unknown, context: Record<string, unknown> = {}): void {
    const detail = error instanceof Error ? { name: error.name, message: error.message, stack: error.stack ?? '' } : { name: 'Error', message: String(error ?? message), stack: '' };
    this.log('error', source, message, { ...context, error: detail });
    this.appendBounded(this.errorPath, { timestamp: this.clock(), level: 'error', source, message, context: jsonSafe({ ...context, ...detail }) as Record<string, unknown> }, ERROR_LOG_BUDGET);
  }
  logDiagnostic(event: DiagnosticEvent, reinforced = true): void {
    try {
      const safe = diagnosticSafe({ ...event, timestamp: event.timestamp ?? this.clock() });
      this.diagnosticEvents++;
      if (event.family === 'summary') this._diagnosticSummary = safe as DiagnosticSummary;
      if (reinforced) this.diagnosticActivated = true;
      if (event.family === 'summary' || reinforced) {
        if (this.diagnosticActivated && this.pendingDiagnostics.length) this.flushDiagnostics();
        this.appendDiagnostic(safe);
      } else this.pendingDiagnostics.push(safe as DiagnosticEvent);
    } catch { this.diagnosticDropped++; }
  }
  diagnosticSummary(event: DiagnosticEvent): void { this.logDiagnostic({ ...event, priority: 'high' }, true); }
  get droppedDiagnosticEvents(): number { return this.diagnosticDropped; }
  get diagnosticIncomplete(): boolean { return this.diagnosticDropped > 0 || this.diagnosticTruncatedWritten; }
  get diagnosticSummaryEvent(): DiagnosticSummary | undefined { return this._diagnosticSummary; }
  get diagnosticEventCount(): number { return this.diagnosticEvents; }
  get diagnosticReference(): string { return 'logs/diagnostic.jsonl'; }
  scraperLogger(): Logger {
    const logger = ((event: LoggerEvent) => {
      const { type, ...context } = event;
      if (type === 'diagnostic') this.logDiagnostic(event.event, event.reinforced ?? true);
      else if (type === 'error') this.error('scraper', event.message ?? 'Error de extracción', event.error, context);
      else this.info('scraper', `scraper.${type}`, context);
    }) as Logger;
    logger.diagnosticState = this;
    return logger;
  }
  private appendBounded(path: string, event: unknown, budget: number): boolean {
    try {
      mkdirSync(this.directory, { recursive: true });
      const line = `${JSON.stringify(event)}\n`;
      const bytes = Buffer.byteLength(line);
      const current = this.fileBytes(path);
      const total = this.fileBytes(this.executionPath) + this.fileBytes(this.errorPath) + this.fileBytes(this.diagnosticPath);
      if (current + bytes > budget || total + bytes > TOTAL_LOG_BUDGET) return false;
      appendFileSync(path, line, 'utf8');
      return true;
    } catch { return false; }
  }
  private appendDiagnostic(event: unknown): void {
    const eventBudget = event && typeof event === 'object' && 'family' in event && ((event as { family?: string }).family === 'summary' || (event as { family?: string }).family === 'truncation') ? DIAGNOSTIC_LOG_BUDGET : DIAGNOSTIC_LOG_BUDGET - 2048;
    if (this.appendBounded(this.diagnosticPath, event, eventBudget)) return;
    this.diagnosticDropped++;
    this.writeDiagnosticTruncation();
  }
  private flushDiagnostics(): void {
    const ordered = [...this.pendingDiagnostics].sort((a, b) => priorityWeight(b.priority) - priorityWeight(a.priority));
    this.pendingDiagnostics = [];
    for (const event of ordered) this.appendDiagnostic(event);
  }
  private writeDiagnosticTruncation(): void {
    if (this.diagnosticTruncatedWritten) return;
    this.diagnosticTruncatedWritten = true;
    this.appendBounded(this.diagnosticPath, { timestamp: this.clock(), family: 'truncation', type: 'diagnostic.truncated', droppedEvents: this.diagnosticDropped, diagnosticIncomplete: true }, DIAGNOSTIC_LOG_BUDGET);
  }
  private fileBytes(path: string): number { try { return statSync(path).size; } catch { return 0; } }
}
function priorityWeight(priority: DiagnosticEvent['priority']): number { return priority === 'high' ? 3 : priority === 'normal' ? 2 : 1; }
