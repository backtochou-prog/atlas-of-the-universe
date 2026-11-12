import { FrameTree, type FrameId, type SpatialPosition } from './frames';
import { length, toFloat32, type Vec3 } from './vec3';

export interface RebaseOptions {
  /** Descend into a child frame once within this fraction of the child's radius. */
  enterFraction: number;
  /** Ascend to the parent once farther than this multiple of the current frame's radius. */
  exitFraction: number;
}

/** enter < exit gives hysteresis, so hovering at a boundary can never flip-flop frames. */
export const DEFAULT_REBASE: RebaseOptions = { enterFraction: 0.5, exitFraction: 1.0 };

/**
 * Floating origin: keep the viewer's position expressed in the deepest frame that contains it.
 * Called after every camera move. Returns the same object if no hand-off is needed.
 */
export function refit(
  tree: FrameTree,
  pos: SpatialPosition,
  opts: RebaseOptions = DEFAULT_REBASE,
): SpatialPosition {
  if (opts.enterFraction >= opts.exitFraction) {
    throw new Error('enterFraction must be < exitFraction (hysteresis)');
  }
  let cur = pos;
  // Ascend while outside the current frame's radius.
  for (;;) {
    const f = tree.get(cur.frame);
    if (f.parent === null || length(cur.offset) <= f.radius * opts.exitFraction) break;
    cur = tree.rebaseTo(cur, f.parent);
  }
  // Descend into the nearest child we are deep inside.
  for (;;) {
    let best: { id: FrameId; d: number } | undefined;
    for (const child of tree.childrenOf(cur.frame)) {
      const inChild = tree.convert(cur, child.id);
      const d = length(inChild);
      if (d <= child.radius * opts.enterFraction && (!best || d < best.d)) best = { id: child.id, d };
    }
    if (!best) break;
    cur = tree.rebaseTo(cur, best.id);
  }
  return cur;
}

/** Camera-relative vector for the GPU: object position minus viewer, in float64, then narrowed. */
export function cameraRelative(tree: FrameTree, object: SpatialPosition, camera: SpatialPosition): Float32Array {
  const v: Vec3 = tree.convert(object, camera.frame);
  return toFloat32([v[0] - camera.offset[0], v[1] - camera.offset[1], v[2] - camera.offset[2]]);
}
