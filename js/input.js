// Controllers or tracked hands, each drawn as a laser. The trigger or a pinch arrives as a session
// 'select' event, and these rays say where it was aimed.
import * as THREE from './three.js';

const Y_AXIS = new THREE.Vector3(0, 1, 0);
const beamGeometry = new THREE.CylinderGeometry(0.002, 0.002, 1, 6, 1, true).translate(0, 0.5, 0);
const tipGeometry = new THREE.SphereGeometry(0.012, 10, 8);

function createPointer(scene, key) {
  const material = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.75 });
  const beam = new THREE.Mesh(beamGeometry, material);
  const tip = new THREE.Mesh(tipGeometry, material);
  beam.renderOrder = 150;
  tip.renderOrder = 150;
  beam.visible = false;
  tip.visible = false;
  scene.add(beam, tip);
  return {
    key,
    source: null,
    valid: false,
    origin: new THREE.Vector3(),
    direction: new THREE.Vector3(0, 0, -1),
    beam,
    tip,
    material,
    flash: 0,
  };
}

const matrix = new THREE.Matrix4();

export class Pointers {
  constructor(scene) {
    this.scene = scene;
    this.pointers = new Map();
    this.active = null;
  }

  update(frame, refSpace, session, dt) {
    for (const pointer of this.pointers.values()) pointer.valid = false;

    for (const source of session.inputSources) {
      if (source.targetRayMode !== 'tracked-pointer') continue;
      const pose = frame.getPose(source.targetRaySpace, refSpace);
      if (!pose) continue;
      const key = source.handedness || 'none';
      let pointer = this.pointers.get(key);
      if (!pointer) {
        pointer = createPointer(this.scene, key);
        this.pointers.set(key, pointer);
      }
      pointer.source = source;
      pointer.valid = true;
      matrix.fromArray(pose.transform.matrix);
      pointer.origin.setFromMatrixPosition(matrix);
      pointer.direction.setFromMatrixColumn(matrix, 2).negate().normalize();
    }

    for (const pointer of this.pointers.values()) {
      pointer.beam.visible = pointer.valid;
      pointer.tip.visible = pointer.valid;
      pointer.flash = Math.max(0, pointer.flash - dt);
      pointer.material.color.setHex(pointer.flash > 0 ? 0xff7a7a : 0xffffff);
    }

    if (!this.active?.valid) {
      const valid = [...this.pointers.values()].filter((pointer) => pointer.valid);
      this.active = valid.find((pointer) => pointer.key === 'right') || valid[0] || null;
    }
  }

  forSource(source) {
    return [...this.pointers.values()].find((pointer) => pointer.valid && pointer.source === source) || null;
  }

  get list() {
    return [...this.pointers.values()].filter((pointer) => pointer.valid);
  }

  drawLaser(pointer, length) {
    pointer.beam.position.copy(pointer.origin);
    pointer.beam.quaternion.setFromUnitVectors(Y_AXIS, pointer.direction);
    pointer.beam.scale.set(1, length, 1);
    pointer.tip.position.copy(pointer.origin).addScaledVector(pointer.direction, length);
  }

  fire(pointer) {
    pointer.flash = 0.12;
  }

  pulse(pointer, strength = 0.7, ms = 60) {
    const actuator = pointer?.source?.gamepad?.hapticActuators?.[0];
    try {
      actuator?.pulse?.(strength, ms);
    } catch { /* Haptics are optional. */ }
  }

  dispose() {
    for (const pointer of this.pointers.values()) {
      this.scene.remove(pointer.beam, pointer.tip);
      pointer.material.dispose();
    }
    this.pointers.clear();
    this.active = null;
  }
}
