/** DataSource over the real files in public/data (node), with optional injected failures / replacements, for the atlas tests and tools. */
import { DATASET_PATHS, type DataSource, type DatasetKey, type DatasetPayloads } from '../../../src/discovery/loader';
import { DATA, readGz, readJson } from './real';

export class FileDataSource implements DataSource {
  readonly calls: DatasetKey[] = [];
  constructor(private readonly opts: { readonly fail?: readonly DatasetKey[]; readonly replace?: Partial<Record<DatasetKey, unknown>>; readonly delayMs?: Partial<Record<DatasetKey, number>> } = {}) {}
  async load<K extends DatasetKey>(key: K): Promise<DatasetPayloads[K]> {
    this.calls.push(key);
    const d = this.opts.delayMs?.[key];
    if (d) await new Promise((r) => setTimeout(r, d));
    if (this.opts.fail?.includes(key)) throw new Error(`injected failure: ${key} could not be loaded`);
    if (this.opts.replace && key in this.opts.replace) return this.opts.replace[key] as DatasetPayloads[K];
    const rel = DATASET_PATHS[key].replace(/^data\//, '');
    return (rel.endsWith('.gz') ? readGz(rel) : readJson(rel)) as DatasetPayloads[K];
  }
}
export { DATA };
