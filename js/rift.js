// A rift: a hole in a real surface, held in place by a spatial anchor.
// The rift's local +Y axis is the surface normal, pointing into the room.
import * as THREE from './three.js';

export const HOLE_RADIUS = 0.16;
const TUNNEL_DEPTH = 0.25;
const ANIMATION_SECONDS = 0.5;

const Y_AXIS = new THREE.Vector3(0, 1, 0);

let nextStencilRef = 1;

function radialTexture(stops) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 128;
  const ctx = canvas.getContext('2d');
  const gradient = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  stops.forEach(([at, color]) => gradient.addColorStop(at, color));
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(canvas);
}

export function createShadowTexture() {
  return radialTexture([[0, 'rgba(0,0,0,0.75)'], [0.55, 'rgba(0,0,0,0.35)'], [1, 'rgba(0,0,0,0)']]);
}

let glowTexture = null;

function addTunnel(rift) {
  const { visual } = rift;
  const stencilRef = nextStencilRef;
  nextStencilRef = (nextStencilRef % 254) + 1;

  // Marks the pixels where the opening is visible. Room setup only knows a desk's flat top, so
  // without this the tunnel could be seen hanging below the desk near an edge or from a low angle.
  const mask = new THREE.Mesh(
    new THREE.CircleGeometry(HOLE_RADIUS, 32),
    new THREE.MeshBasicMaterial({
      colorWrite: false,
      depthWrite: false,
      side: THREE.DoubleSide,
      stencilWrite: true,
      stencilFunc: THREE.AlwaysStencilFunc,
      stencilRef,
      stencilZPass: THREE.ReplaceStencilOp,
    }),
  );
  mask.rotation.x = -Math.PI / 2;
  mask.position.y = 0.003;
  mask.renderOrder = -5;
  visual.add(mask);

  const insideOpening = { stencilWrite: true, stencilFunc: THREE.EqualStencilFunc, stencilRef };

  const tunnel = new THREE.Mesh(
    new THREE.CylinderGeometry(HOLE_RADIUS, HOLE_RADIUS * 0.75, TUNNEL_DEPTH, 32, 1, true),
    new THREE.MeshBasicMaterial({ color: 0x1a0d33, side: THREE.BackSide, ...insideOpening }),
  );
  tunnel.position.y = -TUNNEL_DEPTH / 2;
  visual.add(tunnel);

  const back = new THREE.Mesh(
    new THREE.CircleGeometry(HOLE_RADIUS * 0.75, 32),
    new THREE.MeshBasicMaterial({ color: 0x05020d, ...insideOpening }),
  );
  back.rotation.x = -Math.PI / 2;
  back.position.y = -TUNNEL_DEPTH;
  visual.add(back);

  // Quest 3 only: removes the real surface's depth from the hole. See depth.js.
  rift.punch = new THREE.Mesh(new THREE.CircleGeometry(HOLE_RADIUS, 32));
  rift.punch.rotation.x = -Math.PI / 2;
  rift.punch.position.y = 0.002;
  rift.punch.renderOrder = -20;
  rift.punch.visible = false;
  visual.add(rift.punch);
}

// `onSurface` is false for a rift floating in the air, used when there's no room data.
export function createRift(position, normal, onSurface) {
  const group = new THREE.Group();
  group.position.copy(position);
  group.quaternion.setFromUnitVectors(Y_AXIS, normal.clone().normalize());

  // Everything that opens and closes. Ghosts are children of `group`, so they aren't affected.
  const visual = new THREE.Group();
  visual.scale.set(0.001, 1, 0.001);
  group.add(visual);

  const rift = {
    onSurface,
    group,
    visual,
    phase: 'opening',    // opening -> open -> closing -> closed
    phaseTime: 0,
    quota: 0,
    spawned: 0,
    site: null,          // The room surface and hole, if it's cut into one.
    anchor: null,
    destroyed: false,
    anchorOffset: null,
    targetPos: position.clone(),
    targetQuat: group.quaternion.clone(),
    pulseTime: Math.random() * 10,
    ring: null,
    punch: null,
  };

  if (onSurface) addTunnel(rift);

  // A pool of light on the real surface, so the rift seems to light the room.
  glowTexture ||= radialTexture([[0, 'rgba(150,110,255,0.7)'], [0.4, 'rgba(120,80,255,0.25)'], [1, 'rgba(120,80,255,0)']]);
  const glow = new THREE.Mesh(
    new THREE.PlaneGeometry(HOLE_RADIUS * 4.4, HOLE_RADIUS * 4.4),
    new THREE.MeshBasicMaterial({
      map: glowTexture,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  glow.rotation.x = -Math.PI / 2;
  glow.position.y = 0.01;
  visual.add(glow);

  const ring = new THREE.Mesh(
    new THREE.RingGeometry(HOLE_RADIUS - 0.006, HOLE_RADIUS + 0.018, 48),
    new THREE.MeshBasicMaterial({ color: 0xc8b6ff, transparent: true, depthWrite: false, side: THREE.DoubleSide }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.014;
  visual.add(ring);
  rift.ring = ring;

  return rift;
}

// Must be called inside an XR frame. The rift still works at a fixed position if this fails.
export function anchorRift(rift, frame, refSpace) {
  if (!frame.createAnchor) return;
  const p = rift.group.position;
  const q = rift.group.quaternion;
  try {
    const transform = new XRRigidTransform(
      { x: p.x, y: p.y, z: p.z, w: 1 },
      { x: q.x, y: q.y, z: q.z, w: q.w },
    );
    frame.createAnchor(transform, refSpace).then((anchor) => {
      if (rift.destroyed) anchor?.delete?.();
      else rift.anchor = anchor;
    }).catch(() => {});
  } catch { /* Anchors are unavailable in this session. */ }
}

export function closeRift(rift) {
  if (rift.phase === 'closing' || rift.phase === 'closed') return;
  rift.phase = 'closing';
  rift.phaseTime = 0;
}

const anchorMatrix = new THREE.Matrix4();
const targetMatrix = new THREE.Matrix4();
const unitScale = new THREE.Vector3();

export function updateRift(rift, frame, refSpace, dt) {
  if (rift.anchor) {
    const pose = frame.getPose(rift.anchor.anchorSpace, refSpace);
    if (pose) {
      anchorMatrix.fromArray(pose.transform.matrix);
      // The anchor's axes may differ from the rift's, so store the offset between them once.
      if (!rift.anchorOffset) {
        rift.group.updateMatrix();
        rift.anchorOffset = anchorMatrix.clone().invert().multiply(rift.group.matrix);
      }
      targetMatrix.multiplyMatrices(anchorMatrix, rift.anchorOffset);
      targetMatrix.decompose(rift.targetPos, rift.targetQuat, unitScale);
    }
  }

  // Ease toward the anchor so tracking corrections don't make the rift visibly jump.
  const ease = 1 - Math.exp(-dt * 6);
  rift.group.position.lerp(rift.targetPos, ease);
  rift.group.quaternion.slerp(rift.targetQuat, ease);

  rift.pulseTime += dt;
  rift.ring.material.opacity = 0.65 + Math.sin(rift.pulseTime * 3) * 0.3;

  rift.phaseTime += dt;
  if (rift.phase === 'opening') {
    const t = Math.min(1, rift.phaseTime / ANIMATION_SECONDS);
    rift.visual.scale.set(Math.max(t, 0.001), 1, Math.max(t, 0.001));
    if (t >= 1) rift.phase = 'open';
  } else if (rift.phase === 'closing') {
    const t = Math.max(0, 1 - rift.phaseTime / ANIMATION_SECONDS);
    rift.visual.scale.set(Math.max(t, 0.001), 1, Math.max(t, 0.001));
    if (t <= 0) {
      rift.phase = 'closed';
      rift.visual.visible = false;
    }
  }
}

export function destroyRift(rift, scene) {
  rift.destroyed = true;
  rift.anchor?.delete?.();
  scene.remove(rift.group);
  rift.group.traverse((obj) => {
    obj.geometry?.dispose();
    if (obj !== rift.punch) obj.material?.dispose();   // The punch material is shared.
  });
}
