// Turns hit-test results into a map of real surfaces, then picks rift locations.
// Nothing here touches WebXR, so it can be tested without a device.
import * as THREE from './three.js';

const toViewer = new THREE.Vector3();

// `ny` is the Y part of a unit normal that has already been turned to face the viewer.
export function classify(ny) {
  if (ny > 0.8) return 'up';       // Floor or tabletop.
  if (ny < -0.8) return 'down';    // Ceiling.
  if (Math.abs(ny) < 0.35) return 'wall';
  return null;                     // Sloped: usually a bad estimate, so it isn't used.
}

export class SurfaceMap {
  constructor(cellSize = 0.2, maxCells = 1500) {
    this.cellSize = cellSize;
    this.maxCells = maxCells;
    this.cells = new Map();
    this.rejected = 0;
    this.flipped = 0;
  }

  // Returns the cell the hit landed in, or null if the hit was rejected.
  add(position, normal, viewerPos) {
    const n = normal.clone().normalize();
    // Runtimes differ on which way a plane's normal points, so always face it at the viewer.
    if (toViewer.subVectors(viewerPos, position).dot(n) < 0) {
      n.negate();
      this.flipped++;
    }
    const kind = classify(n.y);
    if (!kind) {
      this.rejected++;
      return null;
    }

    const s = this.cellSize;
    const key = `${kind}:${Math.floor(position.x / s)}:${Math.floor(position.y / s)}:${Math.floor(position.z / s)}`;
    let cell = this.cells.get(key);
    if (!cell) {
      if (this.cells.size >= this.maxCells) return null;
      cell = { kind, pos: position.clone(), normal: n, hits: 1 };
      this.cells.set(key, cell);
    } else {
      cell.hits++;
      const weight = 1 / Math.min(cell.hits, 20);
      cell.pos.lerp(position, weight);
      cell.normal.lerp(n, weight).normalize();
    }
    return cell;
  }

  counts() {
    const counts = { wall: 0, up: 0, down: 0 };
    for (const cell of this.cells.values()) counts[cell.kind]++;
    return counts;
  }

  // The lowest level with real support. Tables only count as floor if the floor was never scanned.
  floorY(minCells = 3, binSize = 0.1) {
    const bins = new Map();
    for (const cell of this.cells.values()) {
      if (cell.kind !== 'up') continue;
      const bin = Math.round(cell.pos.y / binSize);
      const entry = bins.get(bin) || { count: 0, sum: 0 };
      entry.count++;
      entry.sum += cell.pos.y;
      bins.set(bin, entry);
    }
    const levels = [...bins.keys()].sort((a, b) => a - b);
    for (const level of levels) {
      const entry = bins.get(level);
      if (entry.count >= minCells) return entry.sum / entry.count;
    }
    return null;
  }

  // Cells far enough from the viewer, with enough nearby coplanar cells for a rift to fit,
  // and clear of corners, so a rift's hole doesn't spill past the edge of its surface.
  // `clearance` should exceed the rift's outer radius. Two cells are needed to reject a spot,
  // so one noisy hit can't rule it out.
  candidates(viewerPos, {
    minDist = 1, maxDist = 7, support = 3, radius = 0.5, planeTolerance = 0.08,
    clearance = 0.55, maxConflicts = 1,
  } = {}) {
    const cells = [...this.cells.values()];
    const delta = new THREE.Vector3();
    const radiusSq = radius * radius;
    const clearanceSq = clearance * clearance;
    return cells.filter((cell) => {
      const dist = Math.hypot(cell.pos.x - viewerPos.x, cell.pos.z - viewerPos.z);
      if (dist < minDist || dist > maxDist) return false;
      let neighbours = 0;
      let conflicts = 0;
      for (const other of cells) {
        if (other === cell) continue;
        delta.subVectors(other.pos, cell.pos);
        const distSq = delta.lengthSq();
        if (distSq > clearanceSq && distSq > radiusSq) continue;
        const facing = other.normal.dot(cell.normal);
        if (facing < 0.7) {
          if (distSq <= clearanceSq && ++conflicts > maxConflicts) return false;
        } else if (
          distSq <= radiusSq && facing >= 0.9 && other.kind === cell.kind
          && Math.abs(delta.dot(cell.normal)) <= planeTolerance
        ) {
          neighbours++;
        }
      }
      return neighbours >= support;
    });
  }
}

const KIND_BONUS = { wall: 0.6, down: 0.5, up: 0.15 };

// Greedy but random: each pick favors walls and directions not yet used, so ghosts come from all around.
export function selectRifts(candidates, viewerPos, count, { minSpacing = 2, random = Math.random } = {}) {
  const azimuth = (cell) => Math.atan2(cell.pos.x - viewerPos.x, cell.pos.z - viewerPos.z);
  const chosen = [];

  while (chosen.length < count) {
    let best = null;
    let bestScore = -Infinity;
    for (const cell of candidates) {
      if (chosen.some((c) => c.pos.distanceTo(cell.pos) < minSpacing)) continue;

      let separation = 0.5;
      if (chosen.length) {
        separation = Math.min(...chosen.map((c) => {
          const diff = Math.abs(azimuth(c) - azimuth(cell)) % (Math.PI * 2);
          return Math.min(diff, Math.PI * 2 - diff) / Math.PI;
        }));
      }
      const repeat = cell.kind !== 'wall' && chosen.some((c) => c.kind === cell.kind) ? 0.4 : 0;
      const score = separation + KIND_BONUS[cell.kind] - repeat + random() * 0.5;
      if (score > bestScore) {
        bestScore = score;
        best = cell;
      }
    }
    if (!best) break;
    chosen.push(best);
  }
  return chosen;
}
