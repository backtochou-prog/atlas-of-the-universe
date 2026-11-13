import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Build-time only (uses node:fs). Never imported by browser code. */
export interface CacheMeta {
  readonly key: string;
  readonly endpoint: string;
  readonly query: string;
  readonly retrievedAt: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly rows: number;
}

export const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

export class FileCache {
  constructor(private readonly dir: string) {}

  static key(endpoint: string, query: string): string {
    return sha256(`${endpoint}\n${query}`).slice(0, 20);
  }

  async get(key: string): Promise<{ text: string; meta: CacheMeta } | null> {
    try {
      const [text, meta] = await Promise.all([
        readFile(join(this.dir, `${key}.csv`), 'utf8'),
        readFile(join(this.dir, `${key}.meta.json`), 'utf8'),
      ]);
      const parsed = JSON.parse(meta) as CacheMeta;
      if (sha256(text) !== parsed.sha256) throw new Error(`Cache entry ${key} is corrupt (checksum mismatch)`);
      return { text, meta: parsed };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
  }

  async put(key: string, text: string, meta: Omit<CacheMeta, 'key' | 'sha256' | 'bytes'>): Promise<CacheMeta> {
    await mkdir(this.dir, { recursive: true });
    const full: CacheMeta = { ...meta, key, sha256: sha256(text), bytes: Buffer.byteLength(text) };
    await writeFile(join(this.dir, `${key}.csv`), text);
    await writeFile(join(this.dir, `${key}.meta.json`), JSON.stringify(full, null, 2));
    return full;
  }
}
