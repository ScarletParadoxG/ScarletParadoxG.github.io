// A rift: a hole in a real surface, held in place by a spatial anchor.
// The rift's local +Y axis is the surface normal, pointing into the room.
import * as THREE from './three.js';

const HOLE_RADIUS = 0.16;
const OCCLUDER_HALF_SIZE = 0.6;   // Keep below half of the minimum rift spacing in scan.js.
const TUNNEL_DEPTH = 0.25;        // Shallow, so it stays behind the occluder at steep viewing angles.

const Y_AXIS = new THREE.Vector3(0, 1, 0);

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

// A flat invisible surface with a round hole. It writes depth only, so the camera feed
// stays visible while anything behind it (the tunnel, an emerging ghost) gets hidden.
function occluderGeometry() {
  const size = OCCLUDER_HALF_SIZE;
  const shape = new THREE.Shape();
  shape.moveTo(-size, -size);
  shape.lineTo(size, -size);
  shape.lineTo(size, size);
  shape.lineTo(-size, size);
  shape.closePath();
  const hole = new THREE.Path();
  hole.absarc(0, 0, HOLE_RADIUS, 0, Math.PI * 2, true);
  shape.holes.push(hole);
  const geometry = new THREE.ShapeGeometry(shape, 32);
  geometry.rotateX(-Math.PI / 2);
  return geometry;
}

export function createRift(position, normal, kind) {
  const group = new THREE.Group();
  group.position.copy(position);
  group.quaternion.setFromUnitVectors(Y_AXIS, normal.clone().normalize());

  const rift = {
    id: 0,
    kind,
    group,
    anchor: null,
    anchorState: 'none',
    anchorMethod: '-',
    anchorRetry: false,
    destroyed: false,
    tracked: false,
    anchorOffset: null,
    targetPos: position.clone(),
    targetQuat: group.quaternion.clone(),
    lastAnchorPos: null,
    firstAnchorPos: null,
    maxJump: 0,
    drift: 0,
    debugParts: [],
    pulseTime: Math.random() * 10,
    ring: null,
  };

  if (kind !== 'air') {
    const occluderGeo = occluderGeometry();
    const occluder = new THREE.Mesh(occluderGeo, new THREE.MeshBasicMaterial({
      colorWrite: false,
      side: THREE.DoubleSide,
    }));
    occluder.position.y = 0.004;
    occluder.renderOrder = -10;   // Must fill the depth buffer before anything it hides is drawn.
    group.add(occluder);

    const outline = new THREE.Mesh(occluderGeo, new THREE.MeshBasicMaterial({
      color: 0xff40c0,
      wireframe: true,
      transparent: true,
      opacity: 0.5,
    }));
    outline.position.y = 0.012;
    outline.visible = false;
    group.add(outline);
    rift.debugParts.push(outline);

    const tunnel = new THREE.Mesh(
      new THREE.CylinderGeometry(HOLE_RADIUS, HOLE_RADIUS * 0.75, TUNNEL_DEPTH, 32, 1, true),
      new THREE.MeshBasicMaterial({ color: 0x1a0d33, side: THREE.BackSide }),
    );
    tunnel.position.y = -TUNNEL_DEPTH / 2;
    group.add(tunnel);

    const back = new THREE.Mesh(
      new THREE.CircleGeometry(HOLE_RADIUS * 0.75, 32),
      new THREE.MeshBasicMaterial({ color: 0x05020d }),
    );
    back.rotation.x = -Math.PI / 2;
    back.position.y = -TUNNEL_DEPTH;
    group.add(back);
  }

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
  group.add(glow);

  const ring = new THREE.Mesh(
    new THREE.RingGeometry(HOLE_RADIUS - 0.006, HOLE_RADIUS + 0.018, 48),
    new THREE.MeshBasicMaterial({ color: 0xc8b6ff, transparent: true, depthWrite: false, side: THREE.DoubleSide }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.014;
  group.add(ring);
  rift.ring = ring;

  return rift;
}

// Must be called inside an XR frame. A failed hit-result anchor is retried once from the frame.
export function anchorRift(rift, frame, refSpace, hitResult) {
  let method = null;
  let run = null;
  if (hitResult?.createAnchor) {
    method = 'hit-result';
    run = () => hitResult.createAnchor();
  } else if (frame.createAnchor) {
    method = 'frame';
    run = () => {
      const p = rift.group.position;
      const q = rift.group.quaternion;
      const transform = new XRRigidTransform(
        { x: p.x, y: p.y, z: p.z, w: 1 },
        { x: q.x, y: q.y, z: q.z, w: q.w },
      );
      return frame.createAnchor(transform, refSpace);
    };
  }

  if (!run) {
    rift.anchorState = 'unsupported';
    return;
  }

  rift.anchorState = 'pending';
  rift.anchorMethod = method;
  const failed = (error) => {
    if (method === 'hit-result') {
      rift.anchorRetry = true;
    } else {
      rift.anchorState = `failed: ${error?.name || error}`;
    }
  };
  try {
    run().then((anchor) => {
      if (rift.destroyed) {
        anchor?.delete?.();
        return;
      }
      if (!anchor) throw new Error('empty anchor');
      rift.anchor = anchor;
      rift.anchorState = 'anchored';
    }).catch(failed);
  } catch (error) {
    failed(error);
  }
}

const anchorMatrix = new THREE.Matrix4();
const targetMatrix = new THREE.Matrix4();
const unitScale = new THREE.Vector3();

export function updateRift(rift, frame, refSpace, dt) {
  if (rift.anchorRetry) {
    rift.anchorRetry = false;
    anchorRift(rift, frame, refSpace, null);
  }

  if (rift.anchor) {
    const pose = frame.getPose(rift.anchor.anchorSpace, refSpace);
    rift.tracked = !!pose && (frame.trackedAnchors ? frame.trackedAnchors.has(rift.anchor) : true);
    if (pose) {
      anchorMatrix.fromArray(pose.transform.matrix);
      // The anchor's axes may differ from the rift's, so store the offset between them once.
      if (!rift.anchorOffset) {
        rift.group.updateMatrix();
        rift.anchorOffset = anchorMatrix.clone().invert().multiply(rift.group.matrix);
      }
      targetMatrix.multiplyMatrices(anchorMatrix, rift.anchorOffset);
      targetMatrix.decompose(rift.targetPos, rift.targetQuat, unitScale);

      if (rift.lastAnchorPos) {
        rift.maxJump = Math.max(rift.maxJump, rift.targetPos.distanceTo(rift.lastAnchorPos));
        rift.drift = rift.targetPos.distanceTo(rift.firstAnchorPos);
        rift.lastAnchorPos.copy(rift.targetPos);
      } else {
        rift.lastAnchorPos = rift.targetPos.clone();
        rift.firstAnchorPos = rift.targetPos.clone();
      }
    }
  }

  // Ease toward the anchor so tracking corrections don't make the rift visibly jump.
  const ease = 1 - Math.exp(-dt * 6);
  rift.group.position.lerp(rift.targetPos, ease);
  rift.group.quaternion.slerp(rift.targetQuat, ease);

  rift.pulseTime += dt;
  rift.ring.material.opacity = 0.65 + Math.sin(rift.pulseTime * 3) * 0.3;
}

export function setRiftDebug(rift, on) {
  rift.debugParts.forEach((part) => { part.visible = on; });
}

export function destroyRift(rift, scene) {
  rift.destroyed = true;
  rift.anchor?.delete?.();
  scene.remove(rift.group);
  rift.group.traverse((obj) => {
    obj.geometry?.dispose();
    obj.material?.dispose();
  });
}
