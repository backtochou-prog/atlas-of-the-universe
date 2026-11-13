/**
 * Web Worker entry of the discovery engine (Prompt 07, R2a). Loaded by workerClient.ts with
 *   new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }).
 *
 * Protocol (structured clone, all messages are plain objects):
 *   page -> worker   { kind: 'init', base: string, indexTwoMrs?: boolean }               once, first
 *                    { kind: 'call', id: number, op: keyof EngineApi, args: unknown[] }
 *   worker -> page   { kind: 'ready' }                                                   after init
 *                    { kind: 'event', event: EngineEvent }                               status / aliases pushes
 *                    { kind: 'result', id, ok: true, value } | { kind: 'result', id, ok: false, error: string }
 * Calls are answered in the order the worker gets to them; while a non-sliceable step runs (see workerEngine.ts) they wait.
 */
import { HttpDataSource } from './loader';
import { AtlasEngine } from './workerEngine';
import type { EngineApi } from './engineApi';

interface Scope { postMessage(m: unknown): void; onmessage: ((e: { data: unknown }) => void) | null }
const scope = self as unknown as Scope;

let engine: AtlasEngine | null = null;
const OPS: ReadonlySet<string> = new Set(['start', 'status', 'search', 'resolve', 'getRecord', 'getRecords', 'relationsOf', 'parentsOf', 'facets', 'filter', 'lists', 'nearby', 'visible', 'stats']);

scope.onmessage = (e) => {
  const m = e.data as { kind?: string; base?: string; indexTwoMrs?: boolean; id?: number; op?: string; args?: unknown[] };
  if (m.kind === 'init') {
    engine = new AtlasEngine(new HttpDataSource(m.base ?? '/'), { indexTwoMrs: m.indexTwoMrs ?? true, emit: (event) => scope.postMessage({ kind: 'event', event }) });
    scope.postMessage({ kind: 'ready' });
    return;
  }
  if (m.kind !== 'call' || typeof m.id !== 'number' || typeof m.op !== 'string') return;
  const id = m.id;
  if (!engine || !OPS.has(m.op)) { scope.postMessage({ kind: 'result', id, ok: false, error: engine ? `unknown op ${m.op}` : 'engine not initialised' }); return; }
  const fn = (engine as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[m.op]!;
  fn.apply(engine, m.args ?? []).then(
    (value) => scope.postMessage({ kind: 'result', id, ok: true, value }),
    (err: unknown) => scope.postMessage({ kind: 'result', id, ok: false, error: err instanceof Error ? err.message : String(err) }),
  );
};

export type { EngineApi };
