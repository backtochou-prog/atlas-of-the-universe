import * as THREE from 'three';
import { bodyFixedToIcrs, type RotationElements } from '../../core/orbits/rotation';
import { column } from '../../core/orbits/mat3';
import { add, length, sub, ZERO, type Vec3 } from '../../core/spatial/vec3';
import { displayRadius, MARKER_PIXEL_RADIUS, TRUE_SCALE, type ScalePolicy } from '../../core/solar/displayScale';
import type { SolarBodyRecord } from '../../data/solar/types';
import type { SolarSystemData } from '../../data/solar/solarCatalogue';
import { appearanceOf, markerColour, type BodyAppearance } from './appearance';
import { ATMOSPHERE_FRAGMENT, GLOW_FRAGMENT, GLOW_VERTEX, MARKER_FRAGMENT, MARKER_VERTEX, PLANET_FRAGMENT, PLANET_VERTEX, RING_FRAGMENT, SUN_FRAGMENT } from './shaders';
import type { TextureManager } from './textures';

export interface BodyScreenInfo {
  id: string;
  /** Screen position, pixels from the top-left. */
  x: number; y: number;
  /** Radius of the drawn disc in pixels (at least the marker radius when drawn as a marker). */
  pixelRadius: number;
  /** Distance from the camera, metres. */
  distance: number;
  visible: boolean;
  asSphere: boolean;
  physicalRadius: number;
  displayRadius: number;
  exaggeration: number;
  /** Heliocentric position, metres, ICRS axes. */
  helio: Vec3;
}

export interface SolarUpdateInput {
  jdTdb: number;
  camera: THREE.PerspectiveCamera;
  /** Camera position, heliocentric metres, ICRS axes. */
  camHelio: Vec3;
  viewport: { width: number; height: number };
  policy: ScalePolicy;
  selectedId: string | null;
  nowSeconds: number;
  pixelRatio: number;
  /** Distance from the camera to its focus, metres. */
  focusDistance: number;
}

interface Node {
  readonly id: string;
  readonly rec: SolarBodyRecord;
  readonly look: BodyAppearance;
  readonly meanR: number; readonly eqR: number; readonly polarR: number; readonly hasRadius: boolean;
  readonly moons: string[];
  readonly group: THREE.Group;
  mesh: THREE.Mesh | null;
  mat: THREE.ShaderMaterial | null;
  atmos: THREE.Mesh | null; atmosMat: THREE.ShaderMaterial | null;
  ring: THREE.Mesh | null; ringMat: THREE.ShaderMaterial | null;
  glow: THREE.Mesh | null; glowMat: THREE.ShaderMaterial | null;
  orbit: THREE.LineLoop | null; orbitPositions: Float32Array | null;
  info: BodyScreenInfo;
}

const HIGH_SEGMENTS: [number, number] = [96, 48];
const LOW_SEGMENTS: [number, number] = [24, 12];
const ORBIT_SEGMENTS = 256;
const MAX_OCCLUDERS = 5;

/**
 * The Solar System as a three.js scene. Positions come from the ephemeris in float64 and are made camera-relative before
 * they reach the GPU. Physical radii are never modified: only the DRAWN radius follows the display-scale policy.
 */
export class SolarLayer {
  readonly scene = new THREE.Scene();
  readonly nodes = new Map<string, Node>();
  private readonly order: Node[] = [];
  private readonly highSphere = new THREE.SphereGeometry(1, HIGH_SEGMENTS[0], HIGH_SEGMENTS[1]);
  private readonly lowSphere = new THREE.SphereGeometry(1, LOW_SEGMENTS[0], LOW_SEGMENTS[1]);
  private readonly glowQuad = new THREE.PlaneGeometry(2, 2);
  private readonly sunView = new THREE.Vector3();
  private readonly tmp = { m4: new THREE.Matrix4(), a: new THREE.Vector3(), b: new THREE.Vector3(), c: new THREE.Vector3() };
  private readonly markers: THREE.Points;
  private readonly markerPos: Float32Array;
  private readonly markerCol: Float32Array;
  private readonly markerSize: Float32Array;
  private readonly helio = new Map<string, Vec3>();
  private lastSweep = 0;
  /** Reused every frame (the Info objects are mutated in place), so the loop allocates no map. */
  private readonly screenMap = new Map<string, BodyScreenInfo>();
  maxExaggeration = 1;
  /** The body that is enlarged the most among those drawn as spheres. */
  maxExaggerationBody: string | null = null;
  /** Number of bodies currently drawn as spheres, as markers, and orbit lines drawn (for performance reporting). */
  stats = { spheres: 0, markers: 0, orbits: 0 };

  constructor(private readonly data: SolarSystemData, private readonly textures: TextureManager) {
    const bodies = data.file.bodies;
    for (const rec of bodies) {
      const look = appearanceOf(rec.id);
      // A body with no published radius is NEVER given an invented size: it is drawn only as a marker.
      const known = data.meanRadiusMetres(rec.id);
      const meanR = known ?? 0;
      const eq = (rec.physical['equatorial_radius']?.value ?? rec.physical['mean_radius']?.value ?? meanR / 1000) * 1000;
      const polar = (rec.physical['polar_radius']?.value ?? (rec.physical['flattening'] ? eq / 1000 * (1 - rec.physical['flattening'].value) : eq / 1000)) * 1000;
      const node: Node = {
        id: rec.id, rec, look, meanR, eqR: eq, polarR: polar, hasRadius: known !== undefined, moons: data.children(rec.id).map((c) => c.id),
        group: new THREE.Group(), mesh: null, mat: null, atmos: null, atmosMat: null, ring: null, ringMat: null, glow: null, glowMat: null, orbit: null, orbitPositions: null,
        info: { id: rec.id, x: 0, y: 0, pixelRadius: 0, distance: 0, visible: false, asSphere: false, physicalRadius: known ?? NaN, displayRadius: known ?? NaN, exaggeration: 1, helio: ZERO },
      };
      node.group.visible = false;
      this.scene.add(node.group);
      this.nodes.set(rec.id, node); this.order.push(node);
    }
    for (const nd of this.order) this.screenMap.set(nd.id, nd.info);
    const n = this.order.length;
    this.markerPos = new Float32Array(n * 3); this.markerCol = new Float32Array(n * 3); this.markerSize = new Float32Array(n);
    this.order.forEach((node, i) => { const c = markerColour(node.id); this.markerCol.set(c, i * 3); });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.markerPos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aColour', new THREE.BufferAttribute(this.markerCol, 3));
    g.setAttribute('aSize', new THREE.BufferAttribute(this.markerSize, 1).setUsage(THREE.DynamicDrawUsage));
    this.markers = new THREE.Points(g, new THREE.ShaderMaterial({ vertexShader: MARKER_VERTEX, fragmentShader: MARKER_FRAGMENT, transparent: true, depthTest: true, depthWrite: false }));
    this.markers.frustumCulled = false; this.markers.renderOrder = 10;
    this.scene.add(this.markers);
  }

  // -------------------------------------------------------------------------------------------------------------
  private sharedUniforms() {
    return {
      uSunView: { value: this.sunView }, uSunRadius: { value: 6.957e8 },
      uOcc: { value: Array.from({ length: MAX_OCCLUDERS }, () => new THREE.Vector4()) }, uOccCount: { value: 0 },
    };
  }

  private build(node: Node): void {
    if (node.mesh) return;
    const { look } = node;
    if (look.emissive) {
      node.mat = new THREE.ShaderMaterial({ vertexShader: PLANET_VERTEX, fragmentShader: SUN_FRAGMENT });
      node.mesh = new THREE.Mesh(this.highSphere, node.mat);
      node.glowMat = new THREE.ShaderMaterial({ vertexShader: GLOW_VERTEX, fragmentShader: GLOW_FRAGMENT, transparent: true, depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending, uniforms: { uOpacity: { value: 0.75 }, uInner: { value: 0 } } });
      node.glow = new THREE.Mesh(this.glowQuad, node.glowMat);
      node.glow.renderOrder = 5;
      node.group.add(node.mesh); this.scene.add(node.glow);
      return;
    }
    const ring = look.rings ? this.textures.ringRadiiMetres(look.rings.texture) : null;
    node.mat = new THREE.ShaderMaterial({
      vertexShader: PLANET_VERTEX, fragmentShader: PLANET_FRAGMENT,
      uniforms: {
        ...this.sharedUniforms(),
        uDay: { value: null }, uNight: { value: null }, uClouds: { value: null }, uHasDay: { value: 0 }, uHasNight: { value: 0 }, uHasClouds: { value: 0 },
        uFallback: { value: new THREE.Vector3(...look.fallback) }, uTint: { value: new THREE.Vector3(...(look.tint ?? [1, 1, 1])) },
        uLonLeft: { value: look.day ? this.textures.lonLeftRadians(look.day) : -Math.PI },
        uAmbient: { value: 0.012 }, uSpecular: { value: look.specular ?? 0 }, uNoData: { value: 0 },
        uTwilightColour: { value: new THREE.Vector3(1.0, 0.5, 0.25) }, uTwilight: { value: look.atmosphere?.twilight ?? 0 },
        uHasRing: { value: ring ? 1 : 0 }, uRingTex: { value: null }, uRingNormalView: { value: new THREE.Vector3(0, 0, 1) }, uRingCentreView: { value: new THREE.Vector3() }, uRingRadii: { value: new THREE.Vector2(ring?.[0] ?? 0, ring?.[1] ?? 1) },
      },
    });
    node.mesh = new THREE.Mesh(this.highSphere, node.mat);
    node.group.add(node.mesh);

    if (look.atmosphere) {
      const a = look.atmosphere;
      node.atmosMat = new THREE.ShaderMaterial({
        vertexShader: PLANET_VERTEX, fragmentShader: ATMOSPHERE_FRAGMENT, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.FrontSide,
        uniforms: { ...this.sharedUniforms(), uColour: { value: new THREE.Vector3(...a.colour) }, uStrength: { value: a.strength }, uPower: { value: 3.2 } },
      });
      node.atmos = new THREE.Mesh(this.highSphere, node.atmosMat);
      node.atmos.renderOrder = 3;
      node.group.add(node.atmos);
    }
    if (ring) {
      node.ringMat = new THREE.ShaderMaterial({
        vertexShader: PLANET_VERTEX, fragmentShader: RING_FRAGMENT, transparent: true, depthWrite: false, side: THREE.DoubleSide,
        uniforms: { ...this.sharedUniforms(), uRingTex: { value: null }, uRingRadii: { value: new THREE.Vector2(ring[0], ring[1]) }, uAmbient: { value: 0.02 } },
      });
      node.ring = new THREE.Mesh(new THREE.RingGeometry(ring[0], ring[1], 192, 1), node.ringMat);
      node.ring.renderOrder = 2;
      node.group.add(node.ring);
    }
  }

  private ensureOrbit(node: Node): void {
    if (node.orbit || !node.rec.orbit) return;
    node.orbitPositions = new Float32Array(ORBIT_SEGMENTS * 3);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(node.orbitPositions, 3).setUsage(THREE.DynamicDrawUsage));
    const mat = new THREE.LineBasicMaterial({ color: node.rec.kind === 'planet' ? 0x5b6f8c : 0x6d7a8f, transparent: true, opacity: 0.55, depthWrite: false });
    node.orbit = new THREE.LineLoop(g, mat);
    node.orbit.frustumCulled = false; node.orbit.renderOrder = 1;
    this.scene.add(node.orbit);
  }

  private applyOrientation(node: Node, rot: RotationElements | undefined, jd: number): void {
    const mesh = node.mesh;
    if (!mesh || !rot) return;
    const R = bodyFixedToIcrs(rot, jd);
    const bx = column(R, 0), by = column(R, 1), bz = column(R, 2);
    const { m4, a, b, c } = this.tmp;
    // Body-fixed (x prime meridian, y east, z pole) -> mesh-local (x, y = pole, z = -east): the SphereGeometry has its poles on +/-y.
    a.set(bx[0], bx[1], bx[2]); b.set(bz[0], bz[1], bz[2]); c.set(-by[0], -by[1], -by[2]);
    m4.makeBasis(a, b, c);
    mesh.quaternion.setFromRotationMatrix(m4);
    if (node.atmos) node.atmos.quaternion.copy(mesh.quaternion);
    if (node.ring) {
      // The ring lies in the equatorial plane: ring-local z is the pole (spin does not matter for a ring).
      a.set(bx[0], bx[1], bx[2]); b.set(by[0], by[1], by[2]); c.set(bz[0], bz[1], bz[2]);
      m4.makeBasis(a, b, c);
      node.ring.quaternion.setFromRotationMatrix(m4);
    }
  }

  /** Compute positions, choose sphere or marker, set uniforms, and report each body's screen position. */
  update(input: SolarUpdateInput): Map<string, BodyScreenInfo> {
    const { camera, camHelio, jdTdb, viewport, policy } = input;
    camera.updateMatrixWorld();
    const e = camera.matrixWorldInverse.elements;
    const halfTan = Math.tan((camera.fov * Math.PI) / 360);
    const aspect = viewport.width / viewport.height;
    const eph = this.data.ephemeris;
    this.stats = { spheres: 0, markers: 0, orbits: 0 };
    this.maxExaggeration = 1; this.maxExaggerationBody = null;

    // 1. Heliocentric positions (parents precede children in the dataset order).
    for (const node of this.order) {
      const rel = eph.relativePosition(node.id, jdTdb);
      this.helio.set(node.id, node.rec.parent ? add(this.helio.get(node.rec.parent)!, rel) : rel);
    }
    const toView = (v: Vec3, out: THREE.Vector3) => out.set(e[0]! * v[0] + e[4]! * v[1] + e[8]! * v[2], e[1]! * v[0] + e[5]! * v[1] + e[9]! * v[2], e[2]! * v[0] + e[6]! * v[1] + e[10]! * v[2]);
    const sunRel: Vec3 = [-camHelio[0], -camHelio[1], -camHelio[2]];
    toView(sunRel, this.sunView);

    // 2. Per-body placement and representation.
    this.order.forEach((node, i) => {
      const hp = this.helio.get(node.id)!;
      const rel = sub(hp, camHelio);
      const d = Math.max(length(rel), 1);
      const info = node.info;
      info.helio = hp; info.distance = d;
      const parentPos = node.rec.parent ? this.helio.get(node.rec.parent)! : ZERO;
      // Clearance for display enlargement: how close the nearest neighbour is that the enlarged body must not engulf.
      const nearestMoon = node.moons.length ? Math.min(...node.moons.map((m) => length(sub(this.helio.get(m)!, hp)))) : Infinity;
      const clearance = node.rec.kind === 'moon' ? length(sub(hp, parentPos)) : node.rec.kind === 'star' ? 0 : Math.min(nearestMoon, 0.25 * length(hp));
      // Enlargement applies only to bodies in the neighbourhood of what the camera is looking at (within 30 focus distances:
      // the focus's own system, or everything at overview scale). A distant body stays at true scale and so becomes a marker.
      const bodyPolicy = d <= 30 * input.focusDistance ? policy : TRUE_SCALE;
      const drawR = node.hasRadius ? displayRadius(node.meanR, d, clearance, bodyPolicy) : 0;
      info.physicalRadius = node.hasRadius ? node.meanR : NaN; info.displayRadius = node.hasRadius ? drawR : NaN; info.exaggeration = node.hasRadius ? drawR / node.meanR : 1;

      const v = toView(rel, this.tmp.a);
      const inFront = v.z < -1;
      const ndcX = inFront ? v.x / (-v.z * halfTan * aspect) : 0, ndcY = inFront ? v.y / (-v.z * halfTan) : 0;
      info.x = (ndcX * 0.5 + 0.5) * viewport.width; info.y = (0.5 - ndcY * 0.5) * viewport.height;
      const px = node.hasRadius ? (drawR / d) / halfTan * (viewport.height / 2) : 0;
      info.pixelRadius = px;
      info.asSphere = node.hasRadius && inFront && px >= MARKER_PIXEL_RADIUS;
      const onScreen = inFront && info.x > -viewport.width && info.x < 2 * viewport.width && info.y > -viewport.height && info.y < 2 * viewport.height;
      info.visible = onScreen;

      // Marker (fixed screen size, carries no size information).
      this.markerPos.set([rel[0], rel[1], rel[2]], i * 3);
      this.markerSize[i] = info.asSphere || !onScreen ? 0 : (node.rec.kind === 'star' ? 7 : node.rec.kind === 'planet' ? 5 : 3.5) * input.pixelRatio;
      if (!info.asSphere && onScreen) this.stats.markers++;

      node.group.visible = info.asSphere;
      if (node.glow) node.glow.visible = false;
      if (!info.asSphere) { if (node.orbit) node.orbit.visible = false; if (node.glow && onScreen) this.updateGlow(node, rel, d, camera); return; }
      this.stats.spheres++;
      if (info.exaggeration > this.maxExaggeration) { this.maxExaggeration = info.exaggeration; this.maxExaggerationBody = node.id; }
      this.build(node);
      const mesh = node.mesh!;
      node.group.position.set(rel[0], rel[1], rel[2]);
      const k = drawR / node.meanR;
      mesh.scale.set(node.eqR * k, node.polarR * k, node.eqR * k);
      mesh.geometry = px < 40 ? this.lowSphere : this.highSphere;
      if (node.atmos) {
        const t = 1 + (node.look.atmosphere!.thickness);
        node.atmos.scale.set(node.eqR * k * t, node.polarR * k * t, node.eqR * k * t);
        node.atmos.geometry = px < 40 ? this.lowSphere : this.highSphere;
      }
      this.applyOrientation(node, node.rec.rotation, jdTdb);
      if (node.glow) { node.glow.visible = true; this.updateGlow(node, rel, d, camera); }
      if (node.mat && !node.look.emissive) this.updateMaterial(node, px, input, toView);
    });

    // 3. Orbit lines (instantaneous Keplerian ellipses), only where they are large enough on screen to be read.
    // The extent is computed analytically from the elements; the 256-point path is built only for orbits that are drawn.
    for (const node of this.order) {
      if (!node.rec.orbit) continue;
      const at = eph.elementsAt(node.id, jdTdb);
      if (!at) continue;
      const maxR = at.elements.a * (1 + at.elements.e);
      const parentPos = node.rec.parent ? this.helio.get(node.rec.parent)! : ZERO;
      const centreDist = Math.max(length(sub(parentPos, camHelio)), maxR * 0.02);
      const orbitPx = (maxR / centreDist) / halfTan * (viewport.height / 2);
      // A planet's heliocentric orbit is hidden when the camera is deep inside a planetary system, and an orbit through a big
      // close disc is only a line across it.
      const nearSelf = (node.rec.kind === 'planet' && input.focusDistance < 0.05 * maxR) || (node.info.asSphere && node.info.pixelRadius > 30);
      const show = orbitPx >= 14 && orbitPx < 4e4 && !nearSelf;
      if (!show) { if (node.orbit) node.orbit.visible = false; continue; }
      const path = eph.orbitPathIcrs(node.id, jdTdb, ORBIT_SEGMENTS);
      if (!path) continue;
      this.ensureOrbit(node);
      const pos = node.orbitPositions!;
      const bx = parentPos[0] - camHelio[0], by = parentPos[1] - camHelio[1], bz = parentPos[2] - camHelio[2];
      for (let i = 0; i < path.length; i += 3) { pos[i] = path[i]! + bx; pos[i + 1] = path[i + 1]! + by; pos[i + 2] = path[i + 2]! + bz; }
      (node.orbit!.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
      node.orbit!.visible = true;
      const selected = input.selectedId === node.id;
      const mat = node.orbit!.material as THREE.LineBasicMaterial;
      mat.opacity = selected ? 0.95 : Math.min(0.55, orbitPx / 120);
      mat.color.setHex(selected ? 0xd9b97a : node.rec.kind === 'planet' ? 0x5b6f8c : 0x6d7a8f);
      this.stats.orbits++;
    }

    (this.markers.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (this.markers.geometry.getAttribute('aSize') as THREE.BufferAttribute).needsUpdate = true;
    if (input.nowSeconds - this.lastSweep > 2) { this.textures.sweep(input.nowSeconds); this.lastSweep = input.nowSeconds; }
    return this.screenMap;
  }

  private updateGlow(node: Node, rel: Vec3, d: number, camera: THREE.PerspectiveCamera): void {
    const glow = node.glow;
    if (!glow) return;
    const r = Math.max(node.meanR * 6, 0.015 * d);
    glow.position.set(rel[0], rel[1], rel[2]);
    glow.scale.set(r, r, r);
    glow.quaternion.copy(camera.quaternion);
    glow.visible = true;
  }

  private updateMaterial(node: Node, px: number, input: SolarUpdateInput, toView: (v: Vec3, out: THREE.Vector3) => THREE.Vector3): void {
    const mat = node.mat!;
    const u = mat.uniforms as Record<string, { value: unknown }>;
    const level = px > 110 ? '2k' : '512';
    const want = px >= 6;
    const t = input.nowSeconds;
    if (want && node.look.day) {
      const tex = this.textures.get(node.look.day, level, t); u['uDay']!.value = tex; u['uHasDay']!.value = tex ? 1 : 0;
      u['uNoData']!.value = (this.textures.entry(node.look.day)?.nodata_fraction ?? 0) > 0.005 ? 1 : 0;
    }
    if (want && node.look.night) { const tex = this.textures.get(node.look.night, level, t); u['uNight']!.value = tex; u['uHasNight']!.value = tex ? 1 : 0; }
    if (want && node.look.clouds) { const tex = this.textures.get(node.look.clouds, level, t, 'data'); u['uClouds']!.value = tex; u['uHasClouds']!.value = tex ? 1 : 0; }
    // Occluders for eclipses: the parent planet shadows its moons; a planet's moons shadow the planet. Physical radii, so shadows are true.
    const occ = (u['uOcc'] as { value: THREE.Vector4[] }).value;
    let n = 0;
    const camHelio = input.camHelio;
    const add1 = (id: string) => {
      if (n >= MAX_OCCLUDERS) return;
      const o = this.nodes.get(id)!;
      const v = toView(sub(this.helio.get(id)!, camHelio), this.tmp.b);
      occ[n]!.set(v.x, v.y, v.z, o.meanR); n++;
    };
    if (node.rec.parent && node.rec.kind === 'moon') add1(node.rec.parent);
    for (const m of node.moons) add1(m);
    (u['uOccCount'] as { value: number }).value = n;
    if (node.ring && node.look.rings) {
      const ringTex = this.textures.get(node.look.rings.texture, '2k', t);
      u['uRingTex']!.value = ringTex; u['uHasRing']!.value = ringTex ? 1 : 0;
      (node.ringMat!.uniforms['uRingTex'] as { value: unknown }).value = ringTex;
      const nrm = this.tmp.c.set(0, 0, 1).applyQuaternion(node.ring.quaternion);
      const ev = camera_e(input.camera);
      const rv = new THREE.Vector3(ev[0]! * nrm.x + ev[4]! * nrm.y + ev[8]! * nrm.z, ev[1]! * nrm.x + ev[5]! * nrm.y + ev[9]! * nrm.z, ev[2]! * nrm.x + ev[6]! * nrm.y + ev[10]! * nrm.z);
      (u['uRingNormalView'] as { value: THREE.Vector3 }).value.copy(rv);
      const cv = toView(sub(this.helio.get(node.id)!, camHelio), this.tmp.a);
      (u['uRingCentreView'] as { value: THREE.Vector3 }).value.copy(cv);
      // Ring shading needs the same occluder (the planet itself) as the planet shader needs rings.
      const ru = node.ringMat!.uniforms as Record<string, { value: unknown }>;
      const rocc = (ru['uOcc'] as { value: THREE.Vector4[] }).value;
      rocc[0]!.set(cv.x, cv.y, cv.z, node.meanR); (ru['uOccCount'] as { value: number }).value = 1;
    }
    if (node.atmosMat) {
      const au = node.atmosMat.uniforms as Record<string, { value: unknown }>;
      const aocc = (au['uOcc'] as { value: THREE.Vector4[] }).value;
      for (let i = 0; i < n; i++) aocc[i]!.copy(occ[i]!);
      (au['uOccCount'] as { value: number }).value = n;
    }
  }

  /** Release GPU resources. */
  dispose(): void {
    this.highSphere.dispose(); this.lowSphere.dispose(); this.glowQuad.dispose();
    for (const n of this.order) { n.mat?.dispose(); n.atmosMat?.dispose(); n.ringMat?.dispose(); n.glowMat?.dispose(); n.orbit?.geometry.dispose(); n.ring?.geometry.dispose(); }
    this.markers.geometry.dispose(); (this.markers.material as THREE.Material).dispose();
    this.textures.dispose();
  }
}

function camera_e(camera: THREE.PerspectiveCamera): number[] { return camera.matrixWorldInverse.elements; }
