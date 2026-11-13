import { FrameTree, type FrameId, type SpatialPosition } from '../../core/spatial/frames';
import { refit } from '../../core/spatial/anchor';
import { createUniverseFrames, LOCAL_GROUP_FRAME, MILKY_WAY_FRAME, NEARBY_UNIVERSE_FRAME, NEIGHBOURHOOD_FRAME, UNIVERSE_FRAME } from '../../data/catalogue/frames';
import type { SolarSystemData } from '../../data/solar/solarCatalogue';
import { METRES_PER_AU } from '../../core/units';
import type { Vec3 } from '../../core/spatial/vec3';

export const SOLAR_FRAME = 'solar-system';
/** Visualisation extent of the planetary region (Neptune is at 30 AU). Not the heliopause and not the Oort cloud. */
export const SOLAR_FRAME_RADIUS_AU = 100;

export interface FrameLabel { readonly id: FrameId; readonly name: string; readonly kind: 'visualisation extent' | 'system' | 'sample volume' | 'galaxy' | 'universe' | 'region' | 'anchor region' }

/**
 * The hierarchy: Universe > Nearby universe > Local Group (anchored at the Galactic centre) > Milky Way > stellar neighbourhood > Solar System > planetary system (planet and its moons).
 * Planet-system frames are centred on the planet and are updated every frame from the ephemeris, so they MOVE with
 * the planet. Radii are visualisation extents, not astronomical boundaries, and are labelled that way.
 */
export class SolarHierarchy {
  readonly tree: FrameTree;
  private readonly systemFrames = new Map<string, FrameId>();
  private readonly names = new Map<FrameId, FrameLabel>();

  constructor(private readonly data: SolarSystemData) {
    this.tree = createUniverseFrames();
    this.names.set(UNIVERSE_FRAME, { id: UNIVERSE_FRAME, name: 'Universe', kind: 'universe' });
    this.names.set(NEARBY_UNIVERSE_FRAME, { id: NEARBY_UNIVERSE_FRAME, name: 'Nearby universe', kind: 'region' });
    this.names.set(LOCAL_GROUP_FRAME, { id: LOCAL_GROUP_FRAME, name: 'Local Group', kind: 'anchor region' });
    this.names.set(MILKY_WAY_FRAME, { id: MILKY_WAY_FRAME, name: 'Milky Way', kind: 'galaxy' });
    this.names.set(NEIGHBOURHOOD_FRAME, { id: NEIGHBOURHOOD_FRAME, name: 'Stellar neighbourhood (Gaia sample)', kind: 'sample volume' });
    this.tree.add({ id: SOLAR_FRAME, parent: NEIGHBOURHOOD_FRAME, origin: [0, 0, 0], radius: SOLAR_FRAME_RADIUS_AU * METRES_PER_AU });
    this.names.set(SOLAR_FRAME, { id: SOLAR_FRAME, name: 'Solar System', kind: 'visualisation extent' });
    for (const planet of data.file.bodies.filter((b) => b.kind === 'planet')) {
      const moons = data.children(planet.id);
      if (moons.length === 0) continue;
      // The system's extent reaches 1.2 times the farthest modelled moon's semi-major axis (the satellite catalogue is not complete).
      const reach = Math.max(...moons.map((m) => (m.orbit && m.orbit.model === 'osculating-mean-motion' ? m.orbit.a * (1 + m.orbit.e) : 0)));
      const id = `${planet.id}-system`;
      this.tree.add({ id, parent: SOLAR_FRAME, origin: [0, 0, 0], radius: Math.max(reach * 1.2, (data.meanRadiusMetres(planet.id) ?? 1) * 4) });
      this.systemFrames.set(planet.id, id);
      this.names.set(id, { id, name: `${planet.name} system`, kind: 'system' });
    }
  }

  /** Move every planet-system frame to its planet's current position (heliocentric, ICRS axes, metres). */
  update(jdTdb: number): void {
    for (const [planet, frame] of this.systemFrames) this.tree.setOrigin(frame, this.data.ephemeris.heliocentricPosition(planet, jdTdb));
  }

  /**
   * Where is a point? Returns the deepest frame containing it and the chain of names from the top.
   * `heliocentric` is in metres, ICRS axes, relative to the Sun, which is also the origin of the neighbourhood frame.
   * `current` carries the previous frame so the refit hysteresis holds (no flicker at a boundary).
   */
  locate(heliocentric: Vec3, current: FrameId = NEIGHBOURHOOD_FRAME): { frame: FrameId; path: FrameLabel[] } {
    // The neighbourhood frame is Sun-centred with ICRS axes, so a heliocentric vector is already a neighbourhood offset.
    const start: SpatialPosition = { frame: NEIGHBOURHOOD_FRAME, offset: heliocentric };
    const here = this.tree.get(current) ? this.tree.rebaseTo(start, current) : start;
    const fit = refit(this.tree, here);
    const path = this.tree.ancestry(fit.frame).reverse().map((id) => this.names.get(id)!).filter(Boolean);
    return { frame: fit.frame, path };
  }

  systemFrameOf(planetId: string): FrameId | undefined { return this.systemFrames.get(planetId); }
  label(id: FrameId): FrameLabel | undefined { return this.names.get(id); }
}
