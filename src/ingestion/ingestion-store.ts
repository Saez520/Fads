import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { NormalizedAdRecord } from '../domain/ad-model.js';
import {
  DEFAULT_INGESTION_ROOT,
  type IngestionIndex,
  type IngestionReference,
  type IngestionStore,
} from './ingestion-types.js';

export class FileSystemIngestionStore implements IngestionStore {
  private readonly rootDirectory: string;

  constructor(rootDirectory = DEFAULT_INGESTION_ROOT) {
    this.rootDirectory = resolve(rootDirectory);
  }

  async exists(searchId: string): Promise<boolean> {
    try {
      const entry = await stat(join(this.rootDirectory, searchId));
      return entry.isDirectory() || entry.isFile();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }

  async findByQuery(query: string): Promise<IngestionReference | undefined> {
    let entries;
    try {
      entries = await readdir(this.rootDirectory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      try {
        const index = JSON.parse(await readFile(join(this.rootDirectory, entry.name, 'index.json'), 'utf8')) as IngestionIndex;
        if (index.query === query) return this.reference(index);
      } catch {
        // An unrelated or incomplete directory is not a published ingestion.
      }
    }
    return undefined;
  }

  async publish(index: IngestionIndex, records: NormalizedAdRecord[]): Promise<IngestionReference> {
    await mkdir(this.rootDirectory, { recursive: true });
    const finalPath = join(this.rootDirectory, index.searchId);
    const temporaryPath = join(this.rootDirectory, `.${index.searchId}.${randomUUID()}.tmp`);
    try {
      await mkdir(temporaryPath);
      await writeFile(join(temporaryPath, 'records.json'), `${JSON.stringify(records)}\n`, 'utf8');
      await writeFile(join(temporaryPath, 'index.json'), `${JSON.stringify(index)}\n`, 'utf8');
      await rename(temporaryPath, finalPath);
      return this.reference(index);
    } finally {
      await rm(temporaryPath, { recursive: true, force: true });
    }
  }

  private reference(index: IngestionIndex): IngestionReference {
    return { searchId: index.searchId, ingestionPath: join(this.rootDirectory, index.searchId), index };
  }
}
