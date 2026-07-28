import { randomUUID } from 'node:crypto';
import { rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { encodeScrapeEnvelope } from './scrape-output.js';
import type { ResultWriter, ScrapeEnvelope } from './scraper-types.js';

export class AtomicJsonResultWriter implements ResultWriter {
  constructor(private readonly outputPath: string) {}
  async write(envelope: ScrapeEnvelope): Promise<void> {
    await mkdir(dirname(this.outputPath), { recursive: true });
    const temporaryPath = join(dirname(this.outputPath), `.${this.outputPath.split('/').pop()}.${randomUUID()}.tmp`);
    try { await writeFile(temporaryPath, `${encodeScrapeEnvelope(envelope)}\n`, 'utf8'); await rename(temporaryPath, this.outputPath); }
    finally { try { await import('node:fs/promises').then(({ unlink }) => unlink(temporaryPath)); } catch { /* published or absent */ } }
  }
}
