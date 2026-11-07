// The real room, as described by the headset's room setup (Quest 2 and 3 both provide planes).
import * as THREE from './three.js';

const NOT_A_RIFT_SITE = new Set([
  'door', 'door frame', 'window', 'window frame', 'wall art', 'screen', 'global mesh',
]);
const FURNITURE = new Set([
  'table', 'desk', 'couch', 'bed', 'storage', 'lamp', 'plant', 'chair', 'shelf', 'cabinet',
]);
const RIFT_SITES = new Set(['wall', 'floor', 'furniture', 'horizontal']);

function normalizeLabel(label) {
  return String(label || '').toLowerCase().replace(/[_-]+/g, ' ').trim();
}

// Labels are preferred, and the surface's direction is the fallback for when there aren't any.
function classifySurface(normalY, rawLabel) {
  const label = normalizeLabel(rawLabel);
  if (label === 'wall' || label === 'wall face') return 'wall';
  if (label === 'floor') return 'floor';
  if (label === 'ceiling') return 'ceiling';
  if (NOT_A_RIFT_SITE.has(label)) return 'skip';
  if (FURNITURE.has(label)) return 'furniture';
  if (Math.abs(normalY) < 0.35) return label && label !== 'other' ? 'other' : 'wall';
  if (Math.abs(normalY) > 0.8) return 'horizontal';
  return 'other';
}

function pointInPolygon(x, z, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i];
    const b = polygon[j];
    if ((a.z > z) !== (b.z > z) && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}

function distanceToEdge(x, z, polygon) {
  let best = Infinity;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[j];
    const b = polygon[i];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const lengthSq = dx * dx + dz * dz || 1e-9;
    const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / lengthSq));
    best = Math.min(best, Math.hypot(x - (a.x + t * dx), z - (a.z + t * dz)));
  }
  return best;
}

// Surfaces are { kind, matrix, inverse, polygon: [{x, z}] }.
function surfaceLevels(surfaces, headY) {
  const heights = (test) => surfaces.filter(test).map((s) => s.matrix.elements[13]);
  let floors = heights((s) => s.kind === 'floor');
  if (!floors.length) floors = heights((s) => s.kind === 'horizontal' && s.matrix.elements[13] < headY);
  let ceilings = heights((s) => s.kind === 'ceiling');
  if (!ceilings.length) ceilings = heights((s) => s.kind === 'horizontal' && s.matrix.elements[13] > headY);
  return {
    floorY: floors.length ? Math.min(...floors) : null,
    ceilingY: ceilings.length ? Math.max(...ceilings) : null,
  };
}

const worldPoint = new THREE.Vector3();
const localA = new THREE.Vector3();
const localB = new THREE.Vector3();

function segmentBlockedBy(surface, from, to) {
  localA.copy(from).applyMatrix4(surface.inverse);
  localB.copy(to).applyMatrix4(surface.inverse);
  if (localA.y * localB.y >= 0) return false;
  const t = localA.y / (localA.y - localB.y);
  return pointInPolygon(localA.x + (localB.x - localA.x) * t, localA.z + (localB.z - localA.z) * t, surface.polygon);
}

// Every usable rift location on walls, the floor and furniture: clear of the surface's edges and of
// doors and windows, far enough from the player, and not hidden from them by another surface.
export function findRiftSpots(surfaces, headPos, {
  step = 0.25, wallEdgeClearance = 0.3, surfaceEdgeClearance = 0.22, minDist = 1.2, maxDist = 7,
  floorClearance = 0.6, ceilingClearance = 0.35, unknownBelow = 1.2, unknownAbove = 1,
  random = Math.random,
} = {}) {
  const { floorY, ceilingY } = surfaceLevels(surfaces, headPos.y);
  const minY = floorY === null ? headPos.y - unknownBelow : floorY + floorClearance;
  const maxY = ceilingY === null ? headPos.y + unknownAbove : ceilingY - ceilingClearance;
  const skips = surfaces.filter((s) => s.kind === 'skip');
  const spots = [];

  for (const surface of surfaces) {
    if (!RIFT_SITES.has(surface.kind)) continue;
    const isWall = surface.kind === 'wall';
    const edgeClearance = isWall ? wallEdgeClearance : surfaceEdgeClearance;

    // A horizontal surface above eye level would be a ceiling or the underside of something.
    const surfaceNormal = new THREE.Vector3().setFromMatrixColumn(surface.matrix, 1).normalize();
    if (Math.abs(surfaceNormal.y) > 0.8 && surface.matrix.elements[13] > headPos.y - 0.1) continue;

    const xs = surface.polygon.map((p) => p.x);
    const zs = surface.polygon.map((p) => p.z);
    const [x0, x1, z0, z1] = [Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)];

    for (let x = x0; x <= x1; x += step) {
      for (let z = z0; z <= z1; z += step) {
        const px = x + (random() - 0.5) * step * 0.5;
        const pz = z + (random() - 0.5) * step * 0.5;
        if (!pointInPolygon(px, pz, surface.polygon)) continue;
        if (distanceToEdge(px, pz, surface.polygon) < edgeClearance) continue;

        worldPoint.set(px, 0, pz).applyMatrix4(surface.matrix);
        if (isWall && (worldPoint.y < minY || worldPoint.y > maxY)) continue;
        const dist = Math.hypot(worldPoint.x - headPos.x, worldPoint.z - headPos.z);
        if (dist < minDist || dist > maxDist) continue;

        const onSkipped = skips.some((skip) => {
          localA.copy(worldPoint).applyMatrix4(skip.inverse);
          return Math.abs(localA.y) < 0.2 && (pointInPolygon(localA.x, localA.z, skip.polygon)
            || distanceToEdge(localA.x, localA.z, skip.polygon) < edgeClearance);
        });
        if (onSkipped) continue;

        const pos = worldPoint.clone();
        if (surfaces.some((s) => s !== surface && s.kind !== 'skip' && segmentBlockedBy(s, headPos, pos))) continue;

        const normal = surfaceNormal.clone();
        if (normal.dot(localB.subVectors(headPos, pos)) < 0) normal.negate();
        spots.push({ pos, normal, surface, local: { x: px, z: pz } });
      }
    }
  }
  return spots;
}

// Picks a surface first, each with an equal chance, so a small table isn't drowned out by a big floor.
// Then picks a spot on it, favoring directions away from the other rifts so ghosts come from all around.
export function pickRiftSpot(spots, headPos, taken, { minSpacing = 0.9, random = Math.random } = {}) {
  const free = spots.filter((spot) => taken.every((position) => position.distanceTo(spot.pos) >= minSpacing));
  if (!free.length) return null;

  const surfaces = [...new Set(free.map((spot) => spot.surface))];
  const surface = surfaces[Math.floor(random() * surfaces.length)];

  const azimuth = (position) => Math.atan2(position.x - headPos.x, position.z - headPos.z);
  let best = null;
  let bestScore = -Infinity;
  for (const spot of free) {
    if (spot.surface !== surface) continue;
    let separation = 0.5;
    if (taken.length) {
      separation = Math.min(...taken.map((position) => {
        const diff = Math.abs(azimuth(position) - azimuth(spot.pos)) % (Math.PI * 2);
        return Math.min(diff, Math.PI * 2 - diff) / Math.PI;
      }));
    }
    const score = separation + random() * 0.5;
    if (score > bestScore) {
      bestScore = score;
      best = spot;
    }
  }
  return best;
}

// Writes depth without color, so real surfaces hide virtual things behind them while the passthrough stays visible.
const occluderMaterial = new THREE.MeshBasicMaterial({ colorWrite: false, side: THREE.DoubleSide });

export class RoomModel {
  constructor(scene) {
    this.group = new THREE.Group();
    scene.add(this.group);
    this.surfaces = new Map();
    this.levels = { floorY: null, ceilingY: null };
  }

  get list() {
    return [...this.surfaces.values()];
  }

  update(frame, refSpace, headY) {
    const planes = frame.detectedPlanes;
    if (!planes) return;

    for (const [plane, surface] of this.surfaces) {
      if (!planes.has(plane)) {
        this.removeMesh(surface);
        this.surfaces.delete(plane);
      }
    }

    for (const plane of planes) {
      const pose = frame.getPose(plane.planeSpace, refSpace);
      if (!pose) continue;

      let surface = this.surfaces.get(plane);
      if (!surface) {
        surface = {
          plane, kind: 'other', matrix: new THREE.Matrix4(), inverse: new THREE.Matrix4(),
          polygon: [], holes: [], changed: -1, occluder: null,
        };
        this.surfaces.set(plane, surface);
      }

      surface.matrix.fromArray(pose.transform.matrix);
      surface.inverse.copy(surface.matrix).invert();

      const changed = plane.lastChangedTime ?? 0;
      if (surface.changed !== changed || !surface.occluder) {
        surface.changed = changed;
        surface.polygon = plane.polygon.map((p) => ({ x: p.x, z: p.z }));
        const normalY = new THREE.Vector3().setFromMatrixColumn(surface.matrix, 1).normalize().y;
        surface.kind = classifySurface(normalY, plane.semanticLabel);
        this.rebuild(surface);
      }

      surface.occluder.matrix.copy(surface.matrix);
      surface.occluder.matrixWorldNeedsUpdate = true;
    }

    this.levels = surfaceLevels(this.list, headY);
  }

  removeMesh(surface) {
    if (!surface.occluder) return;
    this.group.remove(surface.occluder);
    surface.occluder.geometry.dispose();
    surface.occluder = null;
  }

  rebuild(surface) {
    this.removeMesh(surface);
    const shape = new THREE.Shape(surface.polygon.map((p) => new THREE.Vector2(p.x, -p.z)));
    surface.holes.forEach(({ x, z, radius }) => {
      const hole = new THREE.Path();
      hole.absarc(x, -z, radius, 0, Math.PI * 2, true);
      shape.holes.push(hole);
    });
    const geometry = new THREE.ShapeGeometry(shape, 32);
    geometry.rotateX(-Math.PI / 2);

    surface.occluder = new THREE.Mesh(geometry, occluderMaterial);
    surface.occluder.matrixAutoUpdate = false;
    surface.occluder.renderOrder = -10;   // Must fill the depth buffer before anything it hides is drawn.
    surface.occluder.visible = surface.kind !== 'skip';   // These sit on a wall that already covers them.
    surface.occluder.matrix.copy(surface.matrix);
    this.group.add(surface.occluder);
  }

  // Cuts a round hole so a rift's tunnel can be seen through this surface.
  addHole(surface, x, z, radius) {
    const hole = { x, z, radius };
    surface.holes.push(hole);
    this.rebuild(surface);
    return hole;
  }

  removeHole(surface, hole) {
    surface.holes = surface.holes.filter((other) => other !== hole);
    if (this.list.includes(surface)) this.rebuild(surface);
  }

  // Distance to the nearest room surface along a ray, or null.
  raycast(origin, direction, maxDistance = 12) {
    let best = null;
    const end = worldPoint.copy(origin).addScaledVector(direction, maxDistance).clone();
    for (const surface of this.surfaces.values()) {
      localA.copy(origin).applyMatrix4(surface.inverse);
      localB.copy(end).applyMatrix4(surface.inverse);
      if (localA.y * localB.y >= 0) continue;
      const fraction = localA.y / (localA.y - localB.y);
      const x = localA.x + (localB.x - localA.x) * fraction;
      const z = localA.z + (localB.z - localA.z) * fraction;
      if (!pointInPolygon(x, z, surface.polygon)) continue;
      if (surface.holes.some((h) => Math.hypot(x - h.x, z - h.z) < h.radius)) continue;
      const distance = fraction * maxDistance;
      if (best === null || distance < best) best = distance;
    }
    return best;
  }

  // The highest upward-facing surface under a point, so shadows land on tables as well as the floor.
  surfaceBelow(x, y, z) {
    let best = this.levels.floorY;
    for (const surface of this.surfaces.values()) {
      const height = surface.matrix.elements[13];
      if (height >= y || (best !== null && height <= best)) continue;
      const normalY = surface.matrix.elements[5];
      if (Math.abs(normalY) < 0.8 || surface.kind === 'ceiling') continue;
      localA.set(x, y, z).applyMatrix4(surface.inverse);
      if (pointInPolygon(localA.x, localA.z, surface.polygon)) best = height;
    }
    return best;
  }

  clear() {
    this.list.forEach((surface) => this.removeMesh(surface));
    this.surfaces.clear();
    this.levels = { floorY: null, ceilingY: null };
  }
}
