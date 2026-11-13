import { FrameTree } from '../../core/spatial/frames';
import { galacticToIcrsVector } from '../../core/astro/coordinates';
import { SUN_GALACTOCENTRIC_DISTANCE_PC } from '../../core/astro/constants';
import { METRES_PER_GPC, METRES_PER_KPC, METRES_PER_MPC, METRES_PER_PARSEC } from '../../core/units';
import { scale } from '../../core/spatial/vec3';

/**
 * Frames used by the catalogue layer (this milestone defines only what the data needs; the full
 * seven-environment hierarchy is a navigation concern, not built yet).
 *
 *  milky-way             origin: Galactic centre direction anchor (the centre). Visualisation extent only.
 *  stellar-neighbourhood origin: the Sun. ICRS-aligned axes, so catalogue Cartesian offsets map directly.
 *
 * The Sun is placed at 8.178 kpc from the centre (GRAVITY 2019) ON the line to the Galactic centre
 * (the Sun's ~20 pc height above the plane is ignored). Frame radii are visualisation extents, not
 * astronomical boundaries.
 */
export const MILKY_WAY_FRAME = 'milky-way';
export const NEIGHBOURHOOD_FRAME = 'stellar-neighbourhood';
export const NEIGHBOURHOOD_RADIUS_PC = 10_000;

export function createStellarFrames(): FrameTree {
  // Direction from the Sun to the Galactic centre, in ICRS axes.
  const towardCentre = galacticToIcrsVector([1, 0, 0]);
  const sunInGalaxy = scale(towardCentre, -SUN_GALACTOCENTRIC_DISTANCE_PC * METRES_PER_PARSEC);
  return new FrameTree()
    .add({ id: MILKY_WAY_FRAME, parent: null, origin: [0, 0, 0], radius: 50 * METRES_PER_KPC })
    .add({ id: NEIGHBOURHOOD_FRAME, parent: MILKY_WAY_FRAME, origin: sunInGalaxy, radius: NEIGHBOURHOOD_RADIUS_PC * METRES_PER_PARSEC });
}

/**
 * Universe-scale hierarchy (deep-space layer). All frames are ICRS-aligned, metres, float64.
 *
 *  universe              root. Radius is a visualisation extent (50 Gpc), not the observable universe.
 *  nearby-universe       r 400 Mpc  (the 2MRS layer reaches ~ z 0.03 = ~130 Mpc). Origin = the Galactic-centre anchor.
 *  local-group           r 2 Mpc    ANCHOR at the Galactic centre. It is NOT the Local Group barycentre (the barycentre is
 *                        poorly defined and lies roughly 400-500 kpc from the Sun toward M31; no value is encoded here).
 *  milky-way             r 50 kpc   origin = the same anchor (the Galactic centre direction anchor).
 *  stellar-neighbourhood r 10 kpc   Sun-centred, exactly as createStellarFrames().
 *
 * Because every upper frame shares the Galactic-centre origin, a position inside the Milky Way never passes through
 * a large number when moved up or down the chain. Positions far from the anchor (a galaxy at 10 Mpc) are large in
 * float64 in ANY frame that contains them: ~3e23 m has an absolute resolution of ~7e7 m. Precision comes from keeping a
 * camera's state in its deepest frame (refit), not from summing through the root.
 */
export const UNIVERSE_FRAME = 'universe';
export const NEARBY_UNIVERSE_FRAME = 'nearby-universe';
export const LOCAL_GROUP_FRAME = 'local-group';
export const NEARBY_UNIVERSE_RADIUS_MPC = 400;
export const LOCAL_GROUP_RADIUS_MPC = 2;
export const UNIVERSE_EXTENT_GPC = 50;

export function createUniverseFrames(): FrameTree {
  const towardCentre = galacticToIcrsVector([1, 0, 0]);
  const sunInGalaxy = scale(towardCentre, -SUN_GALACTOCENTRIC_DISTANCE_PC * METRES_PER_PARSEC);
  return new FrameTree()
    .add({ id: UNIVERSE_FRAME, parent: null, origin: [0, 0, 0], radius: UNIVERSE_EXTENT_GPC * METRES_PER_GPC })
    .add({ id: NEARBY_UNIVERSE_FRAME, parent: UNIVERSE_FRAME, origin: [0, 0, 0], radius: NEARBY_UNIVERSE_RADIUS_MPC * METRES_PER_MPC })
    .add({ id: LOCAL_GROUP_FRAME, parent: NEARBY_UNIVERSE_FRAME, origin: [0, 0, 0], radius: LOCAL_GROUP_RADIUS_MPC * METRES_PER_MPC })
    .add({ id: MILKY_WAY_FRAME, parent: LOCAL_GROUP_FRAME, origin: [0, 0, 0], radius: 50 * METRES_PER_KPC })
    .add({ id: NEIGHBOURHOOD_FRAME, parent: MILKY_WAY_FRAME, origin: sunInGalaxy, radius: NEIGHBOURHOOD_RADIUS_PC * METRES_PER_PARSEC });
}
