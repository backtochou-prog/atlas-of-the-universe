/**
 * Page-side proxy for the engine Worker (Prompt 07, R2a): implements EngineApi by posting calls to worker.ts and matching the replies.
 * Kept separate from atlas.ts so tests (node) never touch `Worker`.
 */
import type { EngineApi, EngineEvent } from './engineApi';

export interface EngineClient extends EngineApi {
  onEvent(cb: (e: EngineEvent) => void): () => void;
  terminate(): void;
}

interface Pending { resolve(v: unknown): void; reject(e: Error): void }

export class WorkerEngineClient implements EngineClient {
  private readonly worker: Worker;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Set<(e: EngineEvent) => void>();
  private dead: Error | null = null;

  constructor(base: string, opts: { readonly indexTwoMrs?: boolean } = {}) {
    this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module', name: 'atlas-discovery-engine' });
    this.worker.onmessage = (e: MessageEvent) => {
      const m = e.data as { kind: string; id?: number; ok?: boolean; value?: unknown; error?: string; event?: EngineEvent };
      if (m.kind === 'event' && m.event) { for (const l of [...this.listeners]) { try { l(m.event); } catch { /* listener errors stay in the listener */ } } return; }
      if (m.kind === 'result' && typeof m.id === 'number') {
        const p = this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id);
        if (m.ok) p.resolve(m.value); else p.reject(new Error(m.error ?? 'engine call failed'));
      }
    };
    const fail = (why: string): void => {
      this.dead = new Error(why);
      for (const p of this.pending.values()) p.reject(this.dead);
      this.pending.clear();
    };
    this.worker.onerror = (e) => { e.preventDefault?.(); fail(`the discovery worker failed: ${e.message || 'unknown error'}`); };
    this.worker.onmessageerror = () => fail('the discovery worker sent a message that could not be read');
    this.worker.postMessage({ kind: 'init', base, indexTwoMrs: opts.indexTwoMrs ?? true });
  }

  onEvent(cb: (e: EngineEvent) => void): () => void { this.listeners.add(cb); return () => { this.listeners.delete(cb); }; }
  terminate(): void { this.worker.terminate(); this.dead = new Error('terminated'); for (const p of this.pending.values()) p.reject(this.dead); this.pending.clear(); }

  private call<T>(op: keyof EngineApi, ...args: unknown[]): Promise<T> {
    if (this.dead) return Promise.reject(this.dead);
    return new Promise<T>((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.worker.postMessage({ kind: 'call', id, op, args });
    });
  }

  start(): ReturnType<EngineApi['start']> { return this.call('start'); }
  status(): ReturnType<EngineApi['status']> { return this.call('status'); }
  search(...a: Parameters<EngineApi['search']>): ReturnType<EngineApi['search']> { return this.call('search', ...a); }
  resolve(...a: Parameters<EngineApi['resolve']>): ReturnType<EngineApi['resolve']> { return this.call('resolve', ...a); }
  getRecord(...a: Parameters<EngineApi['getRecord']>): ReturnType<EngineApi['getRecord']> { return this.call('getRecord', ...a); }
  getRecords(...a: Parameters<EngineApi['getRecords']>): ReturnType<EngineApi['getRecords']> { return this.call('getRecords', ...a); }
  relationsOf(...a: Parameters<EngineApi['relationsOf']>): ReturnType<EngineApi['relationsOf']> { return this.call('relationsOf', ...a); }
  parentsOf(...a: Parameters<EngineApi['parentsOf']>): ReturnType<EngineApi['parentsOf']> { return this.call('parentsOf', ...a); }
  facets(): ReturnType<EngineApi['facets']> { return this.call('facets'); }
  filter(...a: Parameters<EngineApi['filter']>): ReturnType<EngineApi['filter']> { return this.call('filter', ...a); }
  lists(): ReturnType<EngineApi['lists']> { return this.call('lists'); }
  nearby(...a: Parameters<EngineApi['nearby']>): ReturnType<EngineApi['nearby']> { return this.call('nearby', ...a); }
  visible(...a: Parameters<EngineApi['visible']>): ReturnType<EngineApi['visible']> { return this.call('visible', ...a); }
  stats(): ReturnType<EngineApi['stats']> { return this.call('stats'); }
}
