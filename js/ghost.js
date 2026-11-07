// A ghost lives in its rift's coordinate space, so anchor corrections move it with the room.
// That rift's anchor is kept until its last ghost is gone, even after the rift has closed.
import * as THREE from './three.js';
import { createShadowTexture } from './rift.js';

const BODY_COLOR = new THREE.Color(0xbfe8ff);
const FLASH_COLOR = new THREE.Color(0xffffff);
const FEATURE_COLOR = 0x0c1020;
const EMERGE_START = -0.2;      // Starts inside the tunnel, behind the real surface.
const FITS_THROUGH_RIFT = 0.42; // The largest scale that passes through the hole.
const FLASH_SECONDS = 0.12;
const KNOCKBACK = 0.12;

// A body made by spinning a profile of [radius, height] points around the vertical axis.
// `hem` optionally shapes the bottom edge into scallops or points.
function latheBody(profile, hem) {
  const geometry = new THREE.LatheGeometry(profile.map(([x, y]) => new THREE.Vector2(x, y)), 28);
  if (hem) {
    const position = geometry.attributes.position;
    const bottom = profile[profile.length - 1][1];
    for (let i = 0; i < position.count; i++) {
      const y = position.getY(i);
      if (y > hem.from) continue;
      const wave = Math.abs(Math.sin(Math.atan2(position.getX(i), position.getZ(i)) * hem.waves));
      const blend = (hem.from - y) / (hem.from - bottom);
      position.setY(i, y + (hem.pointed ? wave : wave * wave) * hem.depth * blend);
    }
  }
  return geometry;
}

const ROUND_EYE = new THREE.SphereGeometry(0.038, 12, 8);
const LARGE_EYE = new THREE.SphereGeometry(0.085, 14, 10);
const FEATURE = new THREE.SphereGeometry(0.05, 12, 8);
const TOOTH = new THREE.ConeGeometry(0.022, 0.05, 6);

// Each type has its own silhouette, face and way of moving, so they can be told apart at any distance.
// In `features`, a part is dark unless `bodyColored` is set. Geometry is shared between ghosts of a type.
const LOOKS = {
  // A classic sheet ghost: round head, scalloped hem and two round eyes.
  ghost: {
    sway: { speed: 1.4, amount: 0.06 },
    body: latheBody(
      [[0.001, 0.36], [0.12, 0.34], [0.2, 0.27], [0.24, 0.16], [0.25, 0], [0.26, -0.18], [0.29, -0.34], [0.33, -0.42]],
      { from: -0.3, waves: 4, depth: 0.1 },
    ),
    features: [
      { geometry: ROUND_EYE, position: [-0.08, 0.17, 0.2] },
      { geometry: ROUND_EYE, position: [0.08, 0.17, 0.2] },
    ],
  },
  // A darting wisp: a teardrop with a pointed tail and one large eye. It weaves as it flies.
  wisp: {
    sway: { speed: 5, amount: 0.3 },
    weave: { speed: 7, amount: 0.07 },
    body: latheBody(
      [[0.001, 0.32], [0.1, 0.3], [0.18, 0.22], [0.21, 0.08], [0.17, -0.08], [0.1, -0.24], [0.04, -0.4], [0.001, -0.52]],
    ),
    features: [
      { geometry: LARGE_EYE, position: [0, 0.12, 0.15] },
    ],
  },
  // A looming phantom: broad, with a jagged hem, slanted eyes and a toothed mouth. It sways slowly.
  phantom: {
    sway: { speed: 0.8, amount: 0.04 },
    body: latheBody(
      [[0.001, 0.3], [0.16, 0.3], [0.27, 0.24], [0.31, 0.1], [0.32, -0.1], [0.35, -0.3], [0.4, -0.42]],
      { from: -0.28, waves: 5, depth: 0.14, pointed: true },
    ),
    features: [
      { geometry: FEATURE, position: [-0.11, 0.13, 0.285], scale: [1.35, 0.65, 0.6], rotation: [0, 0, -0.45] },
      { geometry: FEATURE, position: [0.11, 0.13, 0.285], scale: [1.35, 0.65, 0.6], rotation: [0, 0, 0.45] },
      { geometry: FEATURE, position: [0, -0.07, 0.315], scale: [2.8, 1.3, 0.5] },
      { geometry: TOOTH, position: [-0.065, -0.03, 0.34], rotation: [Math.PI, 0, 0], bodyColored: true },
      { geometry: TOOTH, position: [0.065, -0.03, 0.34], rotation: [Math.PI, 0, 0], bodyColored: true },
    ],
  },
};

let shadowTexture = null;
const worldPos = new THREE.Vector3();
const toTarget = new THREE.Vector3();
const surfaceNormal = new THREE.Vector3();

export class Ghost {
  constructor(rift, scene, voice, typeName, type) {
    this.rift = rift;
    this.scene = scene;
    this.voice = voice;
    this.typeName = typeName;
    this.type = type;
    this.look = LOOKS[typeName];
    this.hitsLeft = type.hits;
    this.phase = 'emerge';       // emerge -> chase
    this.alive = true;
    this.done = false;
    this.deathTime = 0;
    this.flash = 0;
    this.time = Math.random() * 10;
    this.emergeEnd = 0.18 + type.scale * 0.55;       // Bigger ghosts need more room to clear the surface.
    this.reachDistance = 0.25 + type.scale * 0.3;

    // While coming out, anything still behind the surface is cut away.
    this.clipPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 1e4);
    this.bodyMaterial = new THREE.MeshBasicMaterial({
      color: BODY_COLOR,
      transparent: true,
      opacity: 0.9,
      side: THREE.DoubleSide,
      clippingPlanes: [this.clipPlane],
    });
    this.featureMaterial = new THREE.MeshBasicMaterial({
      color: FEATURE_COLOR,
      transparent: true,
      opacity: 0.9,
      clippingPlanes: [this.clipPlane],
    });

    this.body = new THREE.Mesh(this.look.body, this.bodyMaterial);
    this.body.scale.setScalar(Math.min(type.scale, FITS_THROUGH_RIFT));
    for (const { geometry, position, scale, rotation, bodyColored } of this.look.features) {
      const feature = new THREE.Mesh(geometry, bodyColored ? this.bodyMaterial : this.featureMaterial);
      feature.position.set(...position);
      if (scale) feature.scale.set(...scale);
      if (rotation) feature.rotation.set(...rotation);
      this.body.add(feature);
    }

    this.mesh = new THREE.Group();
    this.mesh.add(this.body);
    this.mesh.position.set(0, EMERGE_START, 0);
    rift.group.add(this.mesh);

    shadowTexture ||= createShadowTexture();
    this.shadow = new THREE.Mesh(
      new THREE.PlaneGeometry(0.35, 0.35),
      new THREE.MeshBasicMaterial({ map: shadowTexture, transparent: true, depthWrite: false }),
    );
    this.shadow.rotation.x = -Math.PI / 2;
    this.shadow.visible = false;
    scene.add(this.shadow);
  }

  getWorldPosition(target) {
    return this.mesh.getWorldPosition(target);
  }

  // Inside the surface it can't be seen, so it isn't a fair target yet.
  get shootable() {
    return this.alive && (this.phase === 'chase' || this.mesh.position.y > 0);
  }

  // A shot. Returns true if it killed the ghost.
  hit(shotDirection) {
    this.hitsLeft--;
    if (this.hitsLeft <= 0) {
      this.kill();
      return true;
    }
    this.flash = FLASH_SECONDS;
    if (this.phase === 'chase') {
      this.getWorldPosition(worldPos);
      worldPos.addScaledVector(shotDirection, KNOCKBACK);
      this.rift.group.worldToLocal(worldPos);
      this.mesh.position.copy(worldPos);
    }
    return false;
  }

  kill() {
    this.alive = false;
    this.voice?.stop();
    this.voice = null;
    this.shadow.visible = false;
  }

  remove() {
    this.done = true;
    this.voice?.stop();
    this.voice = null;
    this.rift.group.remove(this.mesh);
    this.scene.remove(this.shadow);
    this.bodyMaterial.dispose();
    this.featureMaterial.dispose();
    this.shadow.geometry.dispose();
    this.shadow.material.dispose();
  }

  // `shadowSurface` finds the height of whatever is under a point, or null if nothing is known.
  // Returns 'reached' on the frame the ghost gets to the player.
  update(dt, viewerPos, { paused, shadowSurface }) {
    this.time += dt;

    if (!this.alive) {
      this.updateDeath(dt);
      return null;
    }

    const reached = !paused && this.move(dt, viewerPos);
    this.updateClipping();
    this.animate(dt, viewerPos);
    this.updateShadow(shadowSurface);
    return reached ? 'reached' : null;
  }

  updateDeath(dt) {
    this.deathTime += dt;
    const t = this.deathTime / 0.35;
    this.mesh.scale.setScalar(1 + t * 0.9);
    this.bodyMaterial.opacity = Math.max(0, 0.9 * (1 - t));
    this.featureMaterial.opacity = this.bodyMaterial.opacity;
    if (t >= 1) this.remove();
  }

  // Returns true if the ghost has reached the player.
  move(dt, viewerPos) {
    if (this.phase === 'emerge') {
      this.mesh.position.y += this.type.speed * 0.7 * dt;
      // Starts small enough to fit through the hole, reaching full size once out.
      const progress = THREE.MathUtils.clamp(this.mesh.position.y / this.emergeEnd, 0, 1);
      const narrow = Math.min(this.type.scale, FITS_THROUGH_RIFT);
      this.body.scale.setScalar(narrow + (this.type.scale - narrow) * progress);
      if (this.mesh.position.y >= this.emergeEnd) this.phase = 'chase';
      return false;
    }

    this.getWorldPosition(worldPos);
    toTarget.subVectors(viewerPos, worldPos);
    const distance = toTarget.length();
    if (distance < this.reachDistance) return true;
    worldPos.addScaledVector(toTarget.divideScalar(distance), this.type.speed * dt);
    this.rift.group.worldToLocal(worldPos);
    this.mesh.position.copy(worldPos);
    return false;
  }

  updateClipping() {
    if (this.phase === 'emerge' && this.rift.onSurface) {
      surfaceNormal.set(0, 1, 0).applyQuaternion(this.rift.group.quaternion);
      this.clipPlane.setFromNormalAndCoplanarPoint(surfaceNormal, this.rift.group.position);
    } else {
      this.clipPlane.constant = 1e4;   // Moved far away, so nothing is cut.
    }
  }

  animate(dt, viewerPos) {
    const { sway, weave } = this.look;
    this.body.position.y = Math.sin(this.time * 2.2) * 0.015;
    this.body.position.x = weave ? Math.sin(this.time * weave.speed) * weave.amount : 0;
    this.body.rotation.z = Math.sin(this.time * sway.speed) * sway.amount;
    this.mesh.lookAt(viewerPos);

    this.flash = Math.max(0, this.flash - dt);
    this.bodyMaterial.color.copy(this.flash > 0 ? FLASH_COLOR : BODY_COLOR);
  }

  updateShadow(shadowSurface) {
    const emerged = this.phase === 'chase' || this.mesh.position.y > 0.1;
    this.getWorldPosition(worldPos);
    const surfaceY = emerged ? shadowSurface(worldPos.x, worldPos.y, worldPos.z) : null;
    const height = surfaceY === null ? -1 : worldPos.y - surfaceY;
    if (height <= 0) {
      this.shadow.visible = false;
      return;
    }
    // Soft and directly below, since the room's real light direction isn't known.
    this.shadow.visible = true;
    this.shadow.position.set(worldPos.x, surfaceY + 0.012, worldPos.z);
    this.shadow.scale.setScalar((1 + height * 0.35) * (this.type.scale / 0.4));
    this.shadow.material.opacity = THREE.MathUtils.clamp(1.1 - height * 0.35, 0.3, 1);
  }
}
