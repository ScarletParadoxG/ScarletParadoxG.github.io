// The real room, as described by the headset's room setup (Quest 2 and 3 both provide planes).
// Spot-finding functions take plain data, so they can be tested without a headset.
import * as THREE from './three.js';

const SKIP_AS_RIFT_SITE = new Set([
  'door', 'door frame', 'window', 'window frame', 'wall art', 'screen', 'global mesh',
]);
const FURNITURE = new Set([
  'table', 'desk', 'couch', 'bed', 'storage', 'lamp', 'plant', 'chair', 'shelf', 'cabinet',
]);

const KIND_COLOR = {
  wall: 0xff9d5c, floor: 0x5cd1ff, ceiling: 0xc98cff, furniture: 0x8cf0c0, skip: 0xff5c7a, horizontal: 0x5cd1ff, other: 0xbbbbbb,
};

function normalizeLabel(label) {
  return String(label || '').toLowerCase().replace(/[_-]+/g, ' ').trim();
}

// Labels are preferred, and the surface's direction is the fallback for when there aren't any.
export function classifySurface(normalY, rawLabel) {
  const label = normalizeLabel(rawLabel);
  if (label === 'wall' || label === 'wall face') return 'wall';
  if (label === 'floor') return 'floor';
  if (label === 'ceiling') return 'ceiling';
  if (SKIP_AS_RIFT_SITE.has(label)) return 'skip';
  if (FURNITURE.has(label)) return 'furniture';
  if (Math.abs(normalY) < 0.35) return label && label !== 'other' ? 'other' : 'wall';
  if (Math.abs(normalY) > 0.8) return 'horizontal';
  return 'other';
}

export function pointInPolygon(x, z, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i];
    const b = polygon[j];
    if ((a.z > z) !== (b.z > z) && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}

export function distanceToEdge(x, z, polygon) {
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

// Entries are { kind, matrix, inverse, polygon: [{x, z}] }.
export function surfaceLevels(entries, headY) {
  const heights = (test) => entries.filter(test).map((e) => e.matrix.elements[13]);
  let floors = heights((e) => e.kind === 'floor');
  if (!floors.length) floors = heights((e) => e.kind === 'horizontal' && e.matrix.elements[13] < headY);
  let ceilings = heights((e) => e.kind === 'ceiling');
  if (!ceilings.length) ceilings = heights((e) => e.kind === 'horizontal' && e.matrix.elements[13] > headY);
  return {
    floorY: floors.length ? Math.min(...floors) : null,
    ceilingY: ceilings.length ? Math.max(...ceilings) : null,
  };
}

const worldPoint = new THREE.Vector3();
const localA = new THREE.Vector3();
const localB = new THREE.Vector3();

function segmentBlockedBy(entry, from, to) {
  localA.copy(from).applyMatrix4(entry.inverse);
  localB.copy(to).applyMatrix4(entry.inverse);
  if (localA.y * localB.y >= 0) return false;
  const t = localA.y / (localA.y - localB.y);
  return pointInPolygon(localA.x + (localB.x - localA.x) * t, localA.z + (localB.z - localA.z) * t, entry.polygon);
}

// Every usable rift location on the room's walls: inside a wall, clear of its edges, doors and
// windows, at a sensible height, and not hidden from the player by another surface.
export function findWallSpots(entries, headPos, {
  step = 0.25, edgeClearance = 0.3, minDist = 1, maxDist = 7,
  floorClearance = 0.6, ceilingClearance = 0.35, unknownBelow = 1.2, unknownAbove = 1,
  random = Math.random,
} = {}) {
  const { floorY, ceilingY } = surfaceLevels(entries, headPos.y);
  const minY = floorY === null ? headPos.y - unknownBelow : floorY + floorClearance;
  const maxY = ceilingY === null ? headPos.y + unknownAbove : ceilingY - ceilingClearance;
  const skips = entries.filter((e) => e.kind === 'skip');
  const spots = [];

  for (const wall of entries) {
    if (wall.kind !== 'wall') continue;
    const xs = wall.polygon.map((p) => p.x);
    const zs = wall.polygon.map((p) => p.z);
    const [x0, x1, z0, z1] = [Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)];

    for (let x = x0; x <= x1; x += step) {
      for (let z = z0; z <= z1; z += step) {
        const px = x + (random() - 0.5) * step * 0.5;
        const pz = z + (random() - 0.5) * step * 0.5;
        if (!pointInPolygon(px, pz, wall.polygon)) continue;
        if (distanceToEdge(px, pz, wall.polygon) < edgeClearance) continue;

        worldPoint.set(px, 0, pz).applyMatrix4(wall.matrix);
        if (worldPoint.y < minY || worldPoint.y > maxY) continue;
        const dist = Math.hypot(worldPoint.x - headPos.x, worldPoint.z - headPos.z);
        if (dist < minDist || dist > maxDist) continue;

        const onSkipped = skips.some((skip) => {
          localA.copy(worldPoint).applyMatrix4(skip.inverse);
          return Math.abs(localA.y) < 0.2 && (pointInPolygon(localA.x, localA.z, skip.polygon)
            || distanceToEdge(localA.x, localA.z, skip.polygon) < edgeClearance);
        });
        if (onSkipped) continue;

        const pos = worldPoint.clone();
        if (entries.some((e) => e !== wall && e.kind !== 'skip' && segmentBlockedBy(e, headPos, pos))) continue;

        const normal = new THREE.Vector3().setFromMatrixColumn(wall.matrix, 1).normalize();
        if (normal.dot(localB.subVectors(headPos, pos)) < 0) normal.negate();
        spots.push({ pos, normal, wall, local: { x: px, z: pz } });
      }
    }
  }
  return spots;
}

// Greedy but random: each pick favors directions and heights not yet used, so ghosts come from all around.
export function selectRifts(spots, headPos, count, { minSpacing = 1.3, random = Math.random } = {}) {
  const azimuth = (spot) => Math.atan2(spot.pos.x - headPos.x, spot.pos.z - headPos.z);
  const chosen = [];

  while (chosen.length < count) {
    let best = null;
    let bestScore = -Infinity;
    for (const spot of spots) {
      if (chosen.some((c) => c.pos.distanceTo(spot.pos) < minSpacing)) continue;

      let separation = 0.5;
      let heightSpread = 0.5;
      if (chosen.length) {
        separation = Math.min(...chosen.map((c) => {
          const diff = Math.abs(azimuth(c) - azimuth(spot)) % (Math.PI * 2);
          return Math.min(diff, Math.PI * 2 - diff) / Math.PI;
        }));
        heightSpread = Math.min(1, Math.min(...chosen.map((c) => Math.abs(c.pos.y - spot.pos.y))));
      }
      const score = separation + heightSpread * 0.4 + random() * 0.5;
      if (score > bestScore) {
        bestScore = score;
        best = spot;
      }
    }
    if (!best) break;
    chosen.push(best);
  }
  return chosen;
}

// ---------- Live room data ----------

// Writes depth without color, so real surfaces hide virtual things behind them while the passthrough stays visible.
const occluderMaterial = new THREE.MeshBasicMaterial({ colorWrite: false, side: THREE.DoubleSide });

export class RoomModel {
  constructor(scene) {
    this.group = new THREE.Group();
    scene.add(this.group);
    this.entries = new Map();
    this.supported = true;
    this.showOutlines = false;
    this.levels = { floorY: null, ceilingY: null };
  }

  get list() {
    return [...this.entries.values()];
  }

  update(frame, refSpace, headY) {
    const planes = frame.detectedPlanes;
    if (!planes) {
      this.supported = false;
      return;
    }

    for (const [plane, entry] of this.entries) {
      if (!planes.has(plane)) {
        this.removeMeshes(entry);
        this.entries.delete(plane);
      }
    }

    for (const plane of planes) {
      const pose = frame.getPose(plane.planeSpace, refSpace);
      if (!pose) continue;

      let entry = this.entries.get(plane);
      if (!entry) {
        entry = {
          plane, kind: 'other', label: '', matrix: new THREE.Matrix4(), inverse: new THREE.Matrix4(),
          polygon: [], holes: [], changed: -1, occluder: null, outline: null,
        };
        this.entries.set(plane, entry);
      }

      entry.matrix.fromArray(pose.transform.matrix);
      entry.inverse.copy(entry.matrix).invert();

      const changed = plane.lastChangedTime ?? 0;
      if (entry.changed !== changed || !entry.occluder) {
        entry.changed = changed;
        entry.label = plane.semanticLabel || '';
        entry.polygon = plane.polygon.map((p) => ({ x: p.x, z: p.z }));
        entry.kind = classifySurface(new THREE.Vector3().setFromMatrixColumn(entry.matrix, 1).normalize().y, entry.label);
        this.rebuild(entry);
      }

      entry.occluder.matrix.copy(entry.matrix);
      entry.occluder.matrixWorldNeedsUpdate = true;
      entry.outline.matrix.copy(entry.matrix);
      entry.outline.matrixWorldNeedsUpdate = true;
    }

    this.levels = surfaceLevels(this.list, headY);
  }

  removeMeshes(entry) {
    if (!entry.occluder) return;
    this.group.remove(entry.occluder, entry.outline);
    entry.occluder.geometry.dispose();
    entry.outline.geometry.dispose();
    entry.outline.material.dispose();
    entry.occluder = null;
    entry.outline = null;
  }

  rebuild(entry) {
    this.removeMeshes(entry);
    const shape = new THREE.Shape(entry.polygon.map((p) => new THREE.Vector2(p.x, -p.z)));
    entry.holes.forEach(({ x, z, radius }) => {
      const hole = new THREE.Path();
      hole.absarc(x, -z, radius, 0, Math.PI * 2, true);
      shape.holes.push(hole);
    });
    const geometry = new THREE.ShapeGeometry(shape, 32);
    geometry.rotateX(-Math.PI / 2);

    entry.occluder = new THREE.Mesh(geometry, occluderMaterial);
    entry.occluder.matrixAutoUpdate = false;
    entry.occluder.renderOrder = -10;   // Must fill the depth buffer before anything it hides is drawn.
    entry.occluder.visible = entry.kind !== 'skip';   // These sit on a wall that already covers them.

    const points = entry.polygon.map((p) => new THREE.Vector3(p.x, 0.012, p.z));
    entry.outline = new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints(points),
      new THREE.LineBasicMaterial({ color: KIND_COLOR[entry.kind] }),
    );
    entry.outline.matrixAutoUpdate = false;
    entry.outline.visible = this.showOutlines;

    entry.occluder.matrix.copy(entry.matrix);
    entry.outline.matrix.copy(entry.matrix);
    this.group.add(entry.occluder, entry.outline);
  }

  setOutlines(on) {
    this.showOutlines = on;
    this.list.forEach((entry) => { if (entry.outline) entry.outline.visible = on; });
  }

  // Cuts a round hole so a rift's tunnel can be seen through this surface.
  addHole(entry, x, z, radius) {
    entry.holes.push({ x, z, radius });
    this.rebuild(entry);
  }

  // Nearest room surface along a ray, or null.
  raycast(origin, direction, maxDistance = 12) {
    let best = null;
    const end = worldPoint.copy(origin).addScaledVector(direction, maxDistance).clone();
    for (const entry of this.entries.values()) {
      localA.copy(origin).applyMatrix4(entry.inverse);
      localB.copy(end).applyMatrix4(entry.inverse);
      if (localA.y * localB.y >= 0) continue;
      const fraction = localA.y / (localA.y - localB.y);
      const x = localA.x + (localB.x - localA.x) * fraction;
      const z = localA.z + (localB.z - localA.z) * fraction;
      if (!pointInPolygon(x, z, entry.polygon)) continue;
      if (entry.holes.some((h) => Math.hypot(x - h.x, z - h.z) < h.radius)) continue;
      const distance = fraction * maxDistance;
      if (!best || distance < best.distance) best = { entry, distance, x, z };
    }
    return best;
  }

  // The highest upward-facing surface under a point, so shadows land on tables as well as the floor.
  surfaceBelow(x, y, z) {
    let best = this.levels.floorY;
    for (const entry of this.entries.values()) {
      const height = entry.matrix.elements[13];
      if (height >= y || (best !== null && height <= best)) continue;
      const normalY = entry.matrix.elements[5];
      if (Math.abs(normalY) < 0.8 || entry.kind === 'ceiling') continue;
      localA.set(x, y, z).applyMatrix4(entry.inverse);
      if (pointInPolygon(localA.x, localA.z, entry.polygon)) best = height;
    }
    return best;
  }

  summary() {
    const counts = {};
    this.list.forEach((e) => { counts[e.kind] = (counts[e.kind] || 0) + 1; });
    return counts;
  }

  labels() {
    return [...new Set(this.list.map((e) => e.label || '(none)'))];
  }

  dispose() {
    this.list.forEach((entry) => this.removeMeshes(entry));
    this.entries.clear();
    this.levels = { floorY: null, ceilingY: null };
    this.supported = true;
  }
}
