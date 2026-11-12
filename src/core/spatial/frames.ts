import { add, sub, ZERO, type Vec3 } from './vec3';

export type FrameId = string;

/**
 * A reference frame: a node in the hierarchy Universe > ... > Galaxy > Star system > Body.
 * All frames share ICRS-aligned axes (no rotation) and use metres. Body-fixed rotation
 * (spin, axial tilt) is a render-layer concern, not a coordinate-frame concern.
 */
export interface FrameDef {
  readonly id: FrameId;
  readonly parent: FrameId | null;
  /** Position of this frame's origin expressed in the PARENT frame (metres, float64). */
  readonly origin: Vec3;
  /** Radius (metres) within which positions are expressed in this frame. Drives rebasing. */
  readonly radius: number;
}

/** A position is always (frame, local offset). Never a single global coordinate. */
export interface SpatialPosition {
  readonly frame: FrameId;
  readonly offset: Vec3;
}

export class FrameTree {
  private readonly frames = new Map<FrameId, FrameDef>();
  private readonly children = new Map<FrameId, FrameId[]>();

  add(def: FrameDef): this {
    if (this.frames.has(def.id)) throw new Error(`Duplicate frame "${def.id}"`);
    if (def.parent === null) {
      if (this.root !== undefined) throw new Error('Frame tree already has a root');
    } else if (!this.frames.has(def.parent)) {
      throw new Error(`Unknown parent "${def.parent}" for frame "${def.id}"`);
    }
    this.frames.set(def.id, def);
    if (def.parent !== null) {
      const siblings = this.children.get(def.parent) ?? [];
      siblings.push(def.id);
      this.children.set(def.parent, siblings);
    }
    return this;
  }

  get root(): FrameDef | undefined {
    for (const f of this.frames.values()) if (f.parent === null) return f;
    return undefined;
  }

  get(id: FrameId): FrameDef {
    const f = this.frames.get(id);
    if (!f) throw new Error(`Unknown frame "${id}"`);
    return f;
  }

  childrenOf(id: FrameId): readonly FrameDef[] {
    return (this.children.get(id) ?? []).map((c) => this.get(c));
  }

  /** Frame ids from `id` up to the root, inclusive, deepest first. */
  ancestry(id: FrameId): FrameId[] {
    const out: FrameId[] = [];
    for (let cur: FrameId | null = id; cur !== null; cur = this.get(cur).parent) out.push(cur);
    return out;
  }

  lowestCommonAncestor(a: FrameId, b: FrameId): FrameId {
    const inA = new Set(this.ancestry(a));
    for (const id of this.ancestry(b)) if (inA.has(id)) return id;
    throw new Error(`Frames "${a}" and "${b}" share no ancestor`);
  }

  /**
   * Express `pos` in frame `to`.
   *
   * Precision rule: offsets are summed only up to the lowest common ancestor, never to the
   * universe root. Two points in the same star system therefore never touch galaxy-scale
   * magnitudes, and keep sub-metre precision no matter where that system sits in the galaxy.
   */
  convert(pos: SpatialPosition, to: FrameId): Vec3 {
    if (pos.frame === to) return pos.offset;
    const lca = this.lowestCommonAncestor(pos.frame, to);

    let up = pos.offset; // pos expressed in the LCA frame
    for (let f = pos.frame; f !== lca; f = this.get(f).parent!) up = add(up, this.get(f).origin);

    let down: Vec3 = ZERO; // origin of `to` expressed in the LCA frame
    for (let f = to; f !== lca; f = this.get(f).parent!) down = add(down, this.get(f).origin);

    return sub(up, down);
  }

  /** Convert a position into another frame, returning a new SpatialPosition. */
  rebaseTo(pos: SpatialPosition, to: FrameId): SpatialPosition {
    return { frame: to, offset: this.convert(pos, to) };
  }
}
