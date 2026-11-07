// A ghost lives in its rift's coordinate space, so anchor corrections move it with the room.
import * as THREE from './three.js';
import { createShadowTexture } from './rift.js';

const GHOST_SCALE = 0.4;     // About 31 cm tall and 26 cm wide.
const EMERGE_START = -0.2;   // Starts inside the tunnel, behind the real surface.
const EMERGE_END = 0.3;      // Clear of the surface, then it heads for the player.
const REACH_DISTANCE = 0.35;

const bodyProfile = [
  [0.001, 0.36], [0.12, 0.34], [0.2, 0.27], [0.24, 0.16],
  [0.25, 0], [0.26, -0.18], [0.29, -0.34], [0.33, -0.42],
].map(([x, y]) => new THREE.Vector2(x, y));
const bodyGeometry = new THREE.LatheGeometry(bodyProfile, 24);
const eyeGeometry = new THREE.SphereGeometry(0.038, 12, 8);

let shadowTexture = null;
const worldPos = new THREE.Vector3();
const toTarget = new THREE.Vector3();

export class Ghost {
  constructor(rift, scene, voice, speed) {
    this.rift = rift;
    this.scene = scene;
    this.voice = voice;
    this.speed = speed;
    this.phase = 'emerge';
    this.alive = true;
    this.done = false;
    this.deathTime = 0;
    this.time = Math.random() * 10;
    this.brightness = 1;

    this.bodyMaterial = new THREE.MeshBasicMaterial({
      color: 0xbfe8ff,
      transparent: true,
      opacity: 0.9,
      side: THREE.DoubleSide,
    });
    this.eyeMaterial = new THREE.MeshBasicMaterial({ color: 0x0c1020, transparent: true, opacity: 0.9 });

    this.mesh = new THREE.Group();
    this.body = new THREE.Mesh(bodyGeometry, this.bodyMaterial);
    this.body.scale.setScalar(GHOST_SCALE);
    this.mesh.add(this.body);
    for (const side of [-1, 1]) {
      const eye = new THREE.Mesh(eyeGeometry, this.eyeMaterial);
      eye.position.set(side * 0.08, 0.17, 0.2);
      this.body.add(eye);
    }
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

  // Inside the wall it can only be glimpsed through the hole, so it isn't a fair target yet.
  get shootable() {
    return this.alive && (this.phase === 'chase' || this.mesh.position.y > 0);
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
    this.eyeMaterial.dispose();
    this.shadow.geometry.dispose();
    this.shadow.material.dispose();
  }

  // `shadowSurface` finds the height of whatever is under a point, or null if nothing is known.
  // Returns 'reached' on the frame the ghost gets to the player.
  update(dt, viewerPos, { paused, shadowSurface, brightness }) {
    this.time += dt;

    if (!this.alive) {
      this.deathTime += dt;
      const t = this.deathTime / 0.35;
      this.mesh.scale.setScalar(1 + t * 0.9);
      this.applyOpacity(Math.max(0, 0.9 * (1 - t)));
      if (t >= 1) this.remove();
      return null;
    }

    let result = null;
    if (!paused) {
      if (this.phase === 'emerge') {
        this.mesh.position.y += this.speed * 0.7 * dt;
        if (this.mesh.position.y >= EMERGE_END) this.phase = 'chase';
      } else {
        this.getWorldPosition(worldPos);
        toTarget.subVectors(viewerPos, worldPos);
        const dist = toTarget.length();
        if (dist < REACH_DISTANCE) {
          result = 'reached';
        } else {
          worldPos.addScaledVector(toTarget.divideScalar(dist), this.speed * dt);
          this.rift.group.worldToLocal(worldPos);
          this.mesh.position.copy(worldPos);
        }
      }
    }

    this.body.position.y = Math.sin(this.time * 2.2) * 0.015;
    this.body.rotation.z = Math.sin(this.time * 1.4) * 0.06;
    this.mesh.lookAt(viewerPos);

    if (brightness !== this.brightness) {
      this.brightness = brightness;
      this.bodyMaterial.color.setHex(0xbfe8ff).multiplyScalar(brightness);
    }

    this.updateShadow(shadowSurface);
    return result;
  }

  applyOpacity(value) {
    this.bodyMaterial.opacity = value;
    this.eyeMaterial.opacity = value;
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
    this.shadow.scale.setScalar(1 + height * 0.35);
    this.shadow.material.opacity = THREE.MathUtils.clamp(1.1 - height * 0.35, 0.3, 1);
  }
}
