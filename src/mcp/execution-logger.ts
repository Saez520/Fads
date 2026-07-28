import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Logger, LoggerEvent } from '../scraper/scraper-types.js';

export type ExecutionLogLevel = 'info' | 'warn' | 'error';
export type ExecutionLogSource = 'mcp' | 'scraper';
export interface ExecutionLogEvent { timestamp: string; level: ExecutionLogLevel; source: ExecutionLogSource; message: string; context: Record<string, unknown> }

function jsonSafe(value: unknown): unknown {
  const seen = new WeakSet<object>();
  return JSON.parse(JSON.stringify(value, (_key, item: unknown) => {
    if (item instanceof Error) return { name: item.name, message: item.message, stack: item.stack };
    if (typeof item === 'bigint') return item.toString();
    if (item && typeof item === 'object') { if (seen.has(item)) return '[circular]'; seen.add(item); }
    return item;
  }) || 'null');
}

export class ExecutionLogger {
  readonly directory: string;
  readonly executionPath: string;
  readonly errorPath: string;
  constructor(taskRoot: string, taskId: string, private readonly clock: () => string = () => new Date().toISOString()) {
    try {
      this.directory = resolve(taskRoot, taskId, 'logs');
      this.executionPath = join(this.directory, 'execution.jsonl');
      this.errorPath = join(this.directory, 'error.jsonl');
      mkdirSync(this.directory, { recursive: true });
      writeFileSync(this.executionPath, '', { flag: 'a' });
    } catch {
      this.directory = join(taskRoot, taskId, 'logs');
      this.executionPath = join(this.directory, 'execution.jsonl');
      this.errorPath = join(this.directory, 'error.jsonl');
    }
  }
  log(level: ExecutionLogLevel, source: ExecutionLogSource, message: string, context: Record<string, unknown> = {}): void {
    try {
      const event: ExecutionLogEvent = { timestamp: this.clock(), level, source, message, context: jsonSafe(context) as Record<string, unknown> };
      this.append(this.executionPath, event);
    } catch { /* logging is best effort and never affects task execution */ }
  }
  info(source: ExecutionLogSource, message: string, context?: Record<string, unknown>): void { this.log('info', source, message, context); }
  warn(source: ExecutionLogSource, message: string, context?: Record<string, unknown>): void { this.log('warn', source, message, context); }
  error(source: ExecutionLogSource, message: string, error?: unknown, context: Record<string, unknown> = {}): void {
    const detail = error instanceof Error ? { name: error.name, message: error.message, stack: error.stack ?? '' } : { name: 'Error', message: String(error ?? message), stack: '' };
    this.log('error', source, message, { ...context, error: detail });
    try { this.append(this.errorPath, { timestamp: this.clock(), level: 'error', source, message, context: jsonSafe({ ...context, ...detail }) as Record<string, unknown> }); } catch { /* best effort */ }
  }
  scraperLogger(): Logger {
    return (event: LoggerEvent) => {
      const { type, ...context } = event;
      if (type === 'error') this.error('scraper', event.message ?? 'Error de extracción', event.error, context);
      else this.info('scraper', `scraper.${type}`, context);
    };
  }
  private append(path: string, event: ExecutionLogEvent): void { try { appendFileSync(path, `${JSON.stringify(event)}\n`, 'utf8'); } catch { /* best effort */ } }
}
