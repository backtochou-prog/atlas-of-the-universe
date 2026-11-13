/**
 * Typed relationships between objects (Prompt 07). Nothing is invented to populate a tree: every edge comes from a dataset field or a
 * cited curated file, carries the BASIS of the relation, and names its source.
 *
 *  physical-gravitational  orbits and bound membership with a published basis
 *  structural              containment that is not an orbit (a nebula is in the Milky Way)
 *  spatial-association     near each other / listed together by OUR selection; never presented as physical
 *  identity                the same object in two datasets
 * The UI shows physical and association relations separately (RelationGraph.relatedBy / parentsOf with a basis filter).
 *
 * Membership rule (classifyMembershipBasis): a published group membership is 'physical-gravitational' only if the group's own basis text
 * says so (a "physical group" definition, "gravitationally bound", ...). A distance cut ("within 3 Mpc of the Sun"), "all rows of a
 * catalogue" or "our cut, not a published membership" is a spatial association, whatever the real astronomy of the system is: the
 * atlas claims only what its data source states.
 */
import type { Relation, RelationBasis, RelationKind, RelationsFile, UniversalId } from './types';

export const HIERARCHY_KINDS: ReadonlySet<RelationKind> = new Set<RelationKind>(['orbits', 'member-of', 'component-of', 'part-of']);
/** Preference when choosing "the" parent of an object. */
export const BASIS_PREFERENCE: readonly RelationBasis[] = ['physical-gravitational', 'structural', 'spatial-association'];

const ALLOWED_BASIS: Readonly<Record<RelationKind, readonly RelationBasis[]>> = {
  orbits: ['physical-gravitational'],
  'component-of': ['physical-gravitational'],
  'member-of': ['physical-gravitational', 'structural', 'spatial-association'],
  'part-of': ['structural'],
  near: ['spatial-association'],
  'same-object-as': ['identity'],
};

export interface RelationLink {
  /** The object at the other end. */
  readonly id: UniversalId;
  readonly relation: Relation;
  /** 'out': the queried object is `relation.from`; 'in': it is `relation.to`. */
  readonly direction: 'out' | 'in';
}

export type GraphIssueCode =
  | 'missing-source' | 'physical-without-source' | 'empty-statement' | 'kind-basis-mismatch' | 'self-relation' | 'dangling-id' | 'cycle' | 'duplicate-conflict' | 'invalid-shape';
export interface GraphIssue { readonly code: GraphIssueCode; readonly message: string; readonly relation?: Relation; readonly ids?: readonly UniversalId[] }

const basisRank = (b: RelationBasis): number => { const i = BASIS_PREFERENCE.indexOf(b); return i < 0 ? BASIS_PREFERENCE.length : i; };
const relKey = (r: Relation): string => `${r.from}\u0000${r.kind}\u0000${r.to}`;

export class RelationGraph {
  private readonly rels: Relation[] = [];
  private readonly out = new Map<UniversalId, Relation[]>();
  private readonly inc = new Map<UniversalId, Relation[]>();
  private readonly conflicts: GraphIssue[] = [];
  /** Relations dropped at construction because aliasing made both ends the same object. */
  readonly droppedSelfAfterAlias: readonly Relation[];

  /**
   * @param aliases  id -> canonical id (from mergeRecords): edges written against a merged-away id (host:..., hip:...) are attached to the
   *                 canonical record. Edges that become self-relations are dropped and listed in droppedSelfAfterAlias.
   */
  constructor(relations: readonly Relation[], readonly aliases: ReadonlyMap<UniversalId, UniversalId> = new Map()) {
    const dropped: Relation[] = [];
    const seen = new Map<string, Relation>();
    for (const r0 of relations) {
      const from = this.canonical(r0.from), to = this.canonical(r0.to);
      const r: Relation = from === r0.from && to === r0.to ? r0 : { ...r0, from, to };
      if (from === to && r0.from !== r0.to) { dropped.push(r0); continue; }
      const k = relKey(r);
      const prior = seen.get(k);
      if (prior) {
        if (prior.basis !== r.basis) this.conflicts.push({ code: 'duplicate-conflict', message: `${r.from} ${r.kind} ${r.to} is stated with two bases: ${prior.basis} and ${r.basis}`, relation: r });
        continue;
      }
      seen.set(k, r);
      this.rels.push(r);
      let o = this.out.get(from); if (!o) { o = []; this.out.set(from, o); } o.push(r);
      let i = this.inc.get(to); if (!i) { i = []; this.inc.set(to, i); } i.push(r);
    }
    this.droppedSelfAfterAlias = dropped;
  }

  canonical(id: UniversalId): UniversalId { return this.aliases.get(id) ?? id; }
  all(): readonly Relation[] { return this.rels; }
  get size(): number { return this.rels.length; }
  outgoing(id: UniversalId): readonly Relation[] { return this.out.get(this.canonical(id)) ?? []; }
  incoming(id: UniversalId): readonly Relation[] { return this.inc.get(this.canonical(id)) ?? []; }

  private links(id: UniversalId, dir: 'out' | 'in', filter: (r: Relation) => boolean): RelationLink[] {
    const list = dir === 'out' ? this.outgoing(id) : this.incoming(id);
    return list.filter(filter).map((relation) => ({ id: dir === 'out' ? relation.to : relation.from, relation, direction: dir }));
  }
  private static order(a: RelationLink, b: RelationLink): number {
    return basisRank(a.relation.basis) - basisRank(b.relation.basis) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  }

  /** What this object orbits / is a member of / is part of. Physical first, then structural, then association; the basis is on every link. */
  parentsOf(id: UniversalId, opts: { readonly basis?: readonly RelationBasis[] } = {}): RelationLink[] {
    return this.links(id, 'out', (r) => HIERARCHY_KINDS.has(r.kind) && (!opts.basis || opts.basis.includes(r.basis))).sort(RelationGraph.order);
  }
  childrenOf(id: UniversalId, opts: { readonly basis?: readonly RelationBasis[] } = {}): RelationLink[] {
    return this.links(id, 'in', (r) => HIERARCHY_KINDS.has(r.kind) && (!opts.basis || opts.basis.includes(r.basis))).sort(RelationGraph.order);
  }
  /** Objects sharing a parent with this one (same parent, any basis); each link names the shared parent in `via`. */
  siblings(id: UniversalId, opts: { readonly basis?: readonly RelationBasis[] } = {}): (RelationLink & { readonly via: UniversalId })[] {
    const me = this.canonical(id);
    const out: (RelationLink & { readonly via: UniversalId })[] = [];
    const seen = new Set<string>();
    for (const p of this.parentsOf(me, opts)) {
      for (const c of this.childrenOf(p.id, opts)) {
        if (c.id === me || seen.has(`${p.id}\u0000${c.id}`)) continue;
        seen.add(`${p.id}\u0000${c.id}`);
        out.push({ ...c, via: p.id });
      }
    }
    return out.sort((a, b) => RelationGraph.order(a, b) || (a.via < b.via ? -1 : 1));
  }
  /** Every relation of this object (either direction, any kind) with this basis. */
  relatedBy(id: UniversalId, basis: RelationBasis): RelationLink[] {
    return [...this.links(id, 'out', (r) => r.basis === basis), ...this.links(id, 'in', (r) => r.basis === basis)].sort(RelationGraph.order);
  }

  /** Follow the preferred parent upward. `complete` is false if a cycle was met (never expected after validate()). */
  pathToRoot(id: UniversalId, opts: { readonly prefer?: readonly RelationBasis[] } = {}): { readonly path: readonly RelationLink[]; readonly complete: boolean } {
    const prefer = opts.prefer ?? BASIS_PREFERENCE;
    const path: RelationLink[] = [];
    const seen = new Set<UniversalId>([this.canonical(id)]);
    let cur = this.canonical(id);
    for (;;) {
      const parents = this.parentsOf(cur).sort((a, b) => prefer.indexOf(a.relation.basis) - prefer.indexOf(b.relation.basis) || (a.id < b.id ? -1 : 1));
      const next = parents.find((p) => prefer.includes(p.relation.basis));
      if (!next) return { path, complete: true };
      if (seen.has(next.id)) return { path, complete: false };
      seen.add(next.id);
      path.push(next);
      cur = next.id;
    }
  }

  /** Everything that physically orbits / is a component of this host, transitively (a star's planets and their moons). */
  systemMembers(host: UniversalId): readonly (RelationLink & { readonly depth: number })[] {
    const out: (RelationLink & { readonly depth: number })[] = [];
    const seen = new Set<UniversalId>([this.canonical(host)]);
    let frontier = [this.canonical(host)];
    for (let depth = 1; frontier.length > 0; depth++) {
      const next: UniversalId[] = [];
      for (const h of frontier) {
        for (const l of this.childrenOf(h, { basis: ['physical-gravitational'] })) {
          if (seen.has(l.id)) continue;
          seen.add(l.id);
          out.push({ ...l, depth });
          next.push(l.id);
        }
      }
      frontier = next;
    }
    return out;
  }

  /**
   * Structural checks: every edge has a source (a physical edge without one is its own error), kinds and bases agree, no self relations, no
   * 'orbits' / 'part-of' / 'component-of' cycles, no dangling ids (when `known` is given), no conflicting duplicates.
   */
  validate(known?: ReadonlySet<UniversalId> | ((id: UniversalId) => boolean)): GraphIssue[] {
    const issues: GraphIssue[] = [...this.conflicts];
    const isKnown = known === undefined ? null : typeof known === 'function' ? known : (id: UniversalId) => known.has(id);
    for (const r of this.rels) {
      if (!r.source || typeof r.source.label !== 'string' || r.source.label.trim().length === 0) {
        issues.push({ code: r.basis === 'physical-gravitational' ? 'physical-without-source' : 'missing-source', message: `${r.from} ${r.kind} ${r.to} has no source`, relation: r });
      }
      if (typeof r.statement !== 'string' || r.statement.trim().length === 0) issues.push({ code: 'empty-statement', message: `${r.from} ${r.kind} ${r.to} has no statement`, relation: r });
      if (!ALLOWED_BASIS[r.kind]?.includes(r.basis)) issues.push({ code: 'kind-basis-mismatch', message: `'${r.kind}' cannot have basis '${r.basis}'`, relation: r });
      if (r.from === r.to) issues.push({ code: 'self-relation', message: `${r.from} is related to itself`, relation: r });
      if (isKnown) for (const id of [r.from, r.to]) if (!isKnown(id)) issues.push({ code: 'dangling-id', message: `${id} (in ${r.from} ${r.kind} ${r.to}) is not a known object`, relation: r, ids: [id] });
    }
    // cycles in orbits / part-of / component-of
    const strict = new Map<UniversalId, UniversalId[]>();
    for (const r of this.rels) if (r.kind === 'orbits' || r.kind === 'part-of' || r.kind === 'component-of') { const l = strict.get(r.from) ?? []; l.push(r.to); strict.set(r.from, l); }
    const state = new Map<UniversalId, 0 | 1 | 2>();
    const reported = new Set<string>();
    const dfs = (start: UniversalId): void => {
      const stack: { id: UniversalId; i: number }[] = [{ id: start, i: 0 }];
      const path: UniversalId[] = [start];
      state.set(start, 1);
      while (stack.length > 0) {
        const top = stack[stack.length - 1]!;
        const nexts = strict.get(top.id) ?? [];
        if (top.i >= nexts.length) { state.set(top.id, 2); stack.pop(); path.pop(); continue; }
        const n = nexts[top.i++]!;
        const s = state.get(n) ?? 0;
        if (s === 1) {
          const cyc = path.slice(path.indexOf(n));
          const key = [...cyc].sort().join('|');
          if (!reported.has(key)) { reported.add(key); issues.push({ code: 'cycle', message: `cycle in orbits/part-of: ${[...cyc, n].join(' -> ')}`, ids: cyc }); }
        } else if (s === 0) { state.set(n, 1); stack.push({ id: n, i: 0 }); path.push(n); }
      }
    };
    for (const id of strict.keys()) if ((state.get(id) ?? 0) === 0) dfs(id);
    return issues;
  }
}

// ---- builders from existing dataset structure -----------------------------------------------------------------------------------------

export const SOLAR_PARENT_SOURCE = { label: 'solar-system.parent', derivedFrom: 'public/data/solar-system.v1.json bodies[].parent (JPL satellite / planetary data as imported by tools/solar-import.ts)' } as const;

/** Sun -> planets -> moons from the Solar System dataset's `parent` field: physical-gravitational 'orbits'. */
export function relationsFromSolar(data: { readonly file: { readonly bodies: readonly { readonly id: string; readonly name: string; readonly parent: string | null }[] } }): Relation[] {
  const names = new Map(data.file.bodies.map((b) => [b.id, b.name] as const));
  const out: Relation[] = [];
  for (const b of data.file.bodies) {
    if (b.parent === null) continue;
    out.push({
      from: `solar:${b.id}`, to: `solar:${b.parent}`, kind: 'orbits', basis: 'physical-gravitational',
      statement: `${b.name} orbits ${names.get(b.parent) ?? b.parent} (Solar System dataset: parent body).`,
      source: SOLAR_PARENT_SOURCE,
    });
  }
  return out;
}

export interface MembershipBasisDecision { readonly basis: Extract<RelationBasis, 'physical-gravitational' | 'spatial-association'>; readonly reason: string }
const RE_NOT_PHYSICAL = /our cut|not a published membership|all rows of|within\s+[\d.]+\s*(?:mpc|kpc|pc)\s+of the sun|selection effect|contaminated/i;
const RE_PHYSICAL = /physical group|gravitationally bound|bound (?:group|system|member)|virialis?z?ed|virial radius/i;
/** See the module comment. Negative signals win over positive ones. */
export function classifyMembershipBasis(basisText: string | undefined): MembershipBasisDecision {
  if (basisText === undefined || basisText.trim().length === 0) return { basis: 'spatial-association', reason: 'no membership basis stated' };
  if (RE_NOT_PHYSICAL.test(basisText)) return { basis: 'spatial-association', reason: 'the membership is a distance / selection cut, not a published bound-membership criterion' };
  if (RE_PHYSICAL.test(basisText)) return { basis: 'physical-gravitational', reason: 'the source defines membership as a physical (bound) group' };
  return { basis: 'spatial-association', reason: 'the source does not say the members are gravitationally bound' };
}

/** The slice of DeepSpaceData that the builder reads. */
export interface DeepObjectLike {
  readonly id: string; readonly name: string; readonly kind: string; readonly parentId?: string;
  readonly membership?: { readonly pointsFileId: string; readonly names: readonly string[]; readonly basis: string; readonly source: { readonly url?: string; readonly release?: string; readonly source: string } };
}

/**
 * deep-space parentId and membership -> relations.
 *  - parent is a group/cluster WITH a membership basis:  'member-of', basis per classifyMembershipBasis(parent.membership.basis)
 *  - parent is a group/cluster without one:              'member-of', spatial-association
 *  - any other parent (Milky Way, ...):                  'part-of', structural
 *  - each membership name that resolves to a catalogue row (via `pointRow`) gets the same member-of relation to the group.
 */
export function relationsFromDeep(objects: readonly DeepObjectLike[], opts: { readonly pointRow?: (fileId: string, name: string) => number | undefined } = {}): Relation[] {
  const byId = new Map(objects.map((o) => [o.id, o] as const));
  const out: Relation[] = [];
  const isGroup = (o: DeepObjectLike): boolean => o.kind === 'galaxy-group' || o.kind === 'galaxy-cluster';
  for (const o of objects) {
    if (o.parentId === undefined) continue;
    const parent = byId.get(o.parentId);
    const parentName = parent?.name ?? o.parentId;
    if (parent && (isGroup(parent) || parent.membership)) {
      const d = classifyMembershipBasis(parent.membership?.basis);
      out.push({
        from: `deep:${o.id}`, to: `deep:${o.parentId}`, kind: 'member-of', basis: d.basis,
        statement: `${o.name} is listed in ${parentName} (${d.basis === 'physical-gravitational' ? 'a physical group by the source\'s definition' : 'a spatial association; ' + d.reason}).`,
        source: { label: 'deep-space.parentId + membership.basis', derivedFrom: `public/data/deep-space.v1.json objects[${o.id}].parentId; basis text of ${o.parentId}: ${parent.membership?.basis ?? '(none)'}` },
      });
    } else {
      out.push({
        from: `deep:${o.id}`, to: `deep:${o.parentId}`, kind: 'part-of', basis: 'structural',
        statement: `${o.name} lies within ${parentName} (containment in a larger structure, not a bound orbit).`,
        source: { label: 'deep-space.parentId', derivedFrom: `public/data/deep-space.v1.json objects[${o.id}].parentId` },
      });
    }
  }
  if (opts.pointRow) {
    for (const g of objects) {
      if (!g.membership) continue;
      const d = classifyMembershipBasis(g.membership.basis);
      for (const name of g.membership.names) {
        const row = opts.pointRow(g.membership.pointsFileId, name);
        if (row === undefined) continue;
        out.push({
          from: `point:${g.membership.pointsFileId}:${row}`, to: `deep:${g.id}`, kind: 'member-of', basis: d.basis,
          statement: `${name} is listed as a member of ${g.name} (${d.basis === 'physical-gravitational' ? 'a physical group by the source\'s definition' : 'a spatial association; ' + d.reason}).`,
          source: { label: 'deep-space.membership.names', ...(g.membership.source.url ? { url: g.membership.source.url } : {}), derivedFrom: `objects[${g.id}].membership (${g.membership.pointsFileId})` },
        });
      }
    }
  }
  return out;
}

const col = (c: Readonly<Record<string, readonly unknown[]>>, name: string): readonly unknown[] => c[name] ?? [];

/** Exoplanet -> host star: physical-gravitational 'orbits' (the archive lists the planet under its host). */
export function relationsFromExoplanets(file: { readonly planets: Readonly<Record<string, readonly unknown[]>>; readonly manifest?: { readonly source?: { readonly url?: string } } }): Relation[] {
  const names = col(file.planets, 'plName'), hosts = col(file.planets, 'hostname');
  const url = file.manifest?.source?.url;
  const out: Relation[] = [];
  for (let i = 0; i < names.length; i++) {
    const p = names[i], h = hosts[i];
    if (typeof p !== 'string' || typeof h !== 'string' || p.length === 0 || h.length === 0) continue;
    out.push({
      from: `exo:${p}`, to: `host:${h}`, kind: 'orbits', basis: 'physical-gravitational',
      statement: `${p} orbits ${h} (NASA Exoplanet Archive: confirmed planet of this host).`,
      source: { label: 'nasa-exoplanet-archive.pscomppars.hostname', ...(url ? { url } : {}), derivedFrom: 'planets.hostname' },
    });
  }
  return out;
}

/**
 * Identity links from `sameAs` (one per unordered pair). Pass `known` to keep only links whose far end is a loaded record: a link to a record that is
 * not in the atlas would dangle.
 */
export function relationsFromSameAs(records: readonly { readonly id: UniversalId; readonly sameAs?: readonly UniversalId[] }[], opts: { readonly known?: (id: UniversalId) => boolean } = {}): Relation[] {
  const out: Relation[] = [];
  const seen = new Set<string>();
  for (const r of records) {
    for (const o of r.sameAs ?? []) {
      const k = r.id < o ? `${r.id}\u0000${o}` : `${o}\u0000${r.id}`;
      if (seen.has(k) || o === r.id || (opts.known && !opts.known(o))) continue;
      seen.add(k);
      out.push({ from: r.id, to: o, kind: 'same-object-as', basis: 'identity', statement: `${r.id} and ${o} are the same object in two datasets.`, source: { label: 'record.sameAs', derivedFrom: 'cross-identification stored on the record (Gaia source id in the Hipparcos / Exoplanet Archive file, or mergeRecords)' } });
    }
  }
  return out;
}

// ---- curated file ---------------------------------------------------------------------------------------------------------------------

const KINDS: readonly RelationKind[] = ['orbits', 'member-of', 'component-of', 'part-of', 'near', 'same-object-as'];
const BASES: readonly RelationBasis[] = ['physical-gravitational', 'structural', 'spatial-association', 'identity'];
const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

/** Parse public/data/relations.v1.json without trusting its shape. Invalid entries are reported and skipped, never repaired. */
export function parseRelationsFile(input: unknown): { readonly relations: Relation[]; readonly issues: GraphIssue[] } {
  const issues: GraphIssue[] = [];
  const f = input as Partial<RelationsFile> | null;
  if (!f || typeof f !== 'object' || !f.manifest || f.manifest.schema !== 'atlas-relations/1' || !Array.isArray(f.relations)) {
    return { relations: [], issues: [{ code: 'invalid-shape', message: 'not an atlas-relations/1 file' }] };
  }
  const relations: Relation[] = [];
  f.relations.forEach((raw: unknown, i: number) => {
    const r = raw as Partial<Relation> | null;
    const src = r?.source as Partial<Relation['source']> | undefined;
    if (!r || !isStr(r.from) || !isStr(r.to) || !KINDS.includes(r.kind as RelationKind) || !BASES.includes(r.basis as RelationBasis) || !isStr(r.statement)) {
      issues.push({ code: 'invalid-shape', message: `relations[${i}] is missing from/to/kind/basis/statement or has an unknown kind or basis` });
      return;
    }
    if (!src || !isStr(src.label)) {
      issues.push({ code: r.basis === 'physical-gravitational' ? 'physical-without-source' : 'missing-source', message: `relations[${i}] (${r.from} ${r.kind} ${r.to}) has no source label; skipped` });
      return;
    }
    relations.push({
      from: r.from, to: r.to, kind: r.kind as RelationKind, basis: r.basis as RelationBasis, statement: r.statement,
      source: { label: src.label, ...(isStr(src.url) ? { url: src.url } : {}), ...(isStr(src.derivedFrom) ? { derivedFrom: src.derivedFrom } : {}) },
    });
  });
  return { relations, issues };
}
