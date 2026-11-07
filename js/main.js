import * as THREE from './three.js';
import { SurfaceMap, selectRifts, classify } from './scan.js';
import { createRift, anchorRift, updateRift, setRiftDebug, destroyRift } from './rift.js';
import { Ghost } from './ghost.js';
import { SpatialAudio } from './audio.js';
import { probeFeatures } from './probe.js';

if (new URLSearchParams(location.search).has('sim')) await import('../test/mock-xr.js');

const CFG = window.GH_CONFIG;
const $ = (id) => document.getElementById(id);

const G = {
  state: 'menu',            // menu -> scanning -> playing
  session: null,
  viewerSpace: null,
  rays: [],
  surfaces: new SurfaceMap(),
  candidateCount: 0,
  candidateTick: 0,
  rifts: [],
  ghosts: [],
  floorY: null,
  centerHit: null,
  scanStart: 0,
  align: { poseDeg: 0, poseCm: 0, aimDeg: 0, hitDeg: null, maxPoseDeg: 0, maxHitDeg: 0 },
  tapMode: false,
  pending: [],
  spawnTimer: 2,
  hudTimer: 0,
  fps: 0,
  lastTime: 0,
  tracking: 'unknown',
  launchTracking: 'n/a',
  refResets: 0,
  trackingLosses: 0,
  overlay: 'none',
  brightness: 1,
  debug: false,
  showArrow: true,
  rayFade: true,
  lastTap: 0,
  beepLabel: '',
  message: '',
  messageUntil: 0,
  stats: { kills: 0, misses: 0, reached: 0, tapsSelect: 0, tapsTouch: 0, spawned: 0 },
  log: [],
  reports: [],
};

const audio = new SpatialAudio();

// Latest viewer pose, in the local reference space.
const V = {
  known: false,
  matrix: new THREE.Matrix4(),
  pos: new THREE.Vector3(),
  quat: new THREE.Quaternion(),
  scale: new THREE.Vector3(),
  fwd: new THREE.Vector3(0, 0, -1),
  aim: new THREE.Vector3(0, 0, -1),    // Through the middle of the screen. Differs from fwd if the camera lens is off center.
  up: new THREE.Vector3(0, 1, 0),
  right: new THREE.Vector3(1, 0, 0),
};

const tmpA = new THREE.Vector3();
const tmpB = new THREE.Vector3();
const tmpQuat = new THREE.Quaternion();
const hitMatrix = new THREE.Matrix4();
const inverseProjection = new THREE.Matrix4();
const poseMatrix = new THREE.Matrix4();
const posePos = new THREE.Vector3();

const MAX_CENTER_HIT_DEG = 6;   // A hit further than this from the crosshair isn't "under" it.

let renderer = null;
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.05, 40);

function log(message) {
  G.log.push(`${new Date().toISOString().slice(11, 19)} ${message}`);
  if (G.log.length > 40) G.log.shift();
}

function say(message, seconds = 1.5) {
  G.message = message;
  G.messageUntil = performance.now() + seconds * 1000;
}

// ---------- World helpers ----------

const crosshair = new THREE.Mesh(
  new THREE.RingGeometry(0.012, 0.016, 32),
  new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, depthTest: false }),
);
crosshair.renderOrder = 100;
crosshair.visible = false;
scene.add(crosshair);

const reticle = new THREE.Mesh(
  new THREE.RingGeometry(0.14, 0.16, 32).rotateX(-Math.PI / 2),
  new THREE.MeshBasicMaterial({ color: 0x8cf0c0, transparent: true, depthWrite: false, side: THREE.DoubleSide }),
);
reticle.matrixAutoUpdate = false;
reticle.visible = false;
scene.add(reticle);

// Colored dots show the player which surfaces the scan has found.
const MAX_DOTS = 1500;
const KIND_COLOR = { wall: new THREE.Color(0xff9d5c), up: new THREE.Color(0x5cd1ff), down: new THREE.Color(0xc98cff) };
const dotGeometry = new THREE.BufferGeometry();
dotGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX_DOTS * 3), 3));
dotGeometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(MAX_DOTS * 3), 3));
dotGeometry.setDrawRange(0, 0);
const dots = new THREE.Points(dotGeometry, new THREE.PointsMaterial({ size: 0.035, vertexColors: true }));
dots.frustumCulled = false;
dots.visible = false;
scene.add(dots);
let dotCount = 0;

function addDot(cell) {
  if (dotCount >= MAX_DOTS) return;
  const color = KIND_COLOR[cell.kind];
  dotGeometry.attributes.position.setXYZ(dotCount, cell.pos.x, cell.pos.y, cell.pos.z);
  dotGeometry.attributes.color.setXYZ(dotCount, color.r, color.g, color.b);
  dotCount++;
  dotGeometry.setDrawRange(0, dotCount);
  dotGeometry.attributes.position.needsUpdate = true;
  dotGeometry.attributes.color.needsUpdate = true;
}

function resetDots() {
  dotCount = 0;
  dotGeometry.setDrawRange(0, 0);
}

// Used only if the app has no DOM overlay, so a status line is still readable in AR.
const fallback = { mesh: null, ctx: null, texture: null, text: '' };

function createFallbackPanel() {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 128;
  fallback.ctx = canvas.getContext('2d');
  fallback.texture = new THREE.CanvasTexture(canvas);
  fallback.mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(0.4, 0.1),
    new THREE.MeshBasicMaterial({ map: fallback.texture, transparent: true, depthTest: false }),
  );
  fallback.mesh.renderOrder = 101;
  scene.add(fallback.mesh);
}

function drawFallbackPanel(text) {
  if (!fallback.mesh || text === fallback.text) return;
  fallback.text = text;
  const { ctx } = fallback;
  ctx.clearRect(0, 0, 512, 128);
  ctx.fillStyle = 'rgba(14,15,24,0.85)';
  ctx.fillRect(0, 0, 512, 128);
  ctx.fillStyle = '#fff';
  ctx.font = '600 26px system-ui, sans-serif';
  text.split('\n').slice(0, 3).forEach((line, i) => ctx.fillText(line, 14, 38 + i * 36, 484));
  fallback.texture.needsUpdate = true;
}

// ---------- Session lifecycle ----------

function ensureRenderer() {
  if (renderer) return;
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.xr.enabled = true;
  renderer.xr.setReferenceSpaceType('local');
}

async function requestGameSession() {
  const features = ['local', 'hit-test', 'anchors', 'dom-overlay'];
  const domOverlay = { root: $('overlay') };
  try {
    return await navigator.xr.requestSession('immersive-ar', { optionalFeatures: features, domOverlay });
  } catch (error) {
    log(`Optional-feature request rejected: ${error.name}. Retrying as required, as Variant's docs show.`);
    return navigator.xr.requestSession('immersive-ar', { requiredFeatures: features, domOverlay });
  }
}

async function enterAR() {
  audio.unlock();
  try {
    const session = await requestGameSession();
    await startSession(session);
  } catch (error) {
    log(`Could not start AR: ${error.name}: ${error.message}`);
    $('support-status').textContent = `Could not start AR: ${error.message}`;
    showReport();
  }
}

async function startSession(session) {
  ensureRenderer();
  G.session = session;
  G.overlay = session.domOverlayState?.type || 'none';
  log(`Session started. Features: ${session.enabledFeatures ? [...session.enabledFeatures].join(', ') : 'not reported'}`);
  log(`DOM overlay: ${G.overlay}`);
  if (G.overlay === 'none') createFallbackPanel();

  session.addEventListener('end', onSessionEnd);
  session.addEventListener('select', () => onTap('select'));
  session.addEventListener('visibilitychange', () => log(`Visibility: ${session.visibilityState}`));

  await renderer.xr.setSession(session);

  const refSpace = renderer.xr.getReferenceSpace();
  refSpace?.addEventListener?.('reset', () => {
    G.refResets++;
    log('Reference space reset');
  });

  await setUpHitTest(session);

  document.documentElement.classList.add('in-ar');
  $('menu').hidden = true;
  $('ar-ui').hidden = false;
  setState('scanning');
  G.scanStart = performance.now();
  // The screen-fixed crosshair can't drift, so the 3D one is only for apps without an overlay.
  $('crosshair').hidden = G.overlay === 'none';
  crosshair.visible = G.overlay === 'none';
  renderer.setAnimationLoop(onFrame);
}

async function setUpHitTest(session) {
  G.rays = [];
  if (typeof session.requestHitTestSource !== 'function') {
    log('Hit test is unavailable. Use Air rift to test everything else.');
    return;
  }
  try {
    G.viewerSpace = await session.requestReferenceSpace('viewer');
  } catch (error) {
    log(`No viewer space: ${error.name}`);
    return;
  }

  try {
    const source = await session.requestHitTestSource({ space: G.viewerSpace });
    G.rays.push({ source, hit: null });
  } catch (error) {
    log(`Hit test source failed: ${error.name}: ${error.message}`);
    return;
  }

  // Extra angled rays speed up the sweep, but one center ray is enough.
  if (typeof XRRay === 'undefined') {
    log('XRRay is missing: using the center ray only.');
    return;
  }
  const spread = Math.tan(THREE.MathUtils.degToRad(12));
  const offsets = [[spread, 0], [-spread, 0], [0, spread], [0, -spread]];
  try {
    for (const [x, y] of offsets) {
      const length = Math.hypot(x, y, 1);
      const offsetRay = new XRRay({ x: 0, y: 0, z: 0, w: 1 }, { x: x / length, y: y / length, z: -1 / length, w: 0 });
      const source = await session.requestHitTestSource({ space: G.viewerSpace, offsetRay });
      G.rays.push({ source, hit: null });
    }
  } catch (error) {
    log(`Angled rays unavailable (${error.name}). Rays in use: ${G.rays.length}`);
  }
}

function onSessionEnd() {
  log('Session ended');
  G.reports.push(buildDiagnostics());
  renderer.setAnimationLoop(null);
  audio.stopAll();
  G.ghosts.forEach((ghost) => ghost.remove());
  G.ghosts = [];
  G.rifts.forEach((rift) => destroyRift(rift, scene));
  G.rifts = [];
  G.rays.forEach((ray) => ray.source.cancel?.());
  G.rays = [];
  G.surfaces = new SurfaceMap();
  G.candidateCount = 0;
  G.floorY = null;
  G.centerHit = null;
  G.tapMode = false;
  G.pending = [];
  G.session = null;
  G.tracking = 'unknown';
  V.known = false;
  resetDots();
  dots.visible = false;
  reticle.visible = false;
  crosshair.visible = false;
  if (fallback.mesh) {
    scene.remove(fallback.mesh);
    fallback.mesh = null;
    fallback.text = '';
  }

  document.documentElement.classList.remove('in-ar');
  $('ar-ui').hidden = true;
  $('crosshair').hidden = true;
  $('arrow').hidden = true;
  $('menu').hidden = false;
  setState('menu');
  showReport();
}

function setState(state) {
  G.state = state;
  dots.visible = state === 'scanning' || G.debug;
  reticle.visible = false;
  $('btn-tap').hidden = state !== 'scanning';
  $('btn-primary').hidden = state !== 'scanning';
  $('btn-spawn').hidden = state !== 'playing';
  updateControls();
}

// ---------- Frame loop ----------

function onFrame(time, frame) {
  const dt = Math.min((time - G.lastTime) / 1000 || 0, 0.1);
  G.lastTime = time;
  if (dt > 0) G.fps += (1 / dt - G.fps) * 0.05;
  if (!frame) return;

  const refSpace = renderer.xr.getReferenceSpace();
  const pose = frame.getViewerPose(refSpace);
  const tracked = !!pose && !pose.emulatedPosition;
  updateTracking(tracked);

  if (pose) {
    updateViewer(pose);
    audio.setListener(V.pos, V.fwd, V.up);

    readHits(frame, refSpace);
    runPending(frame, refSpace);
    placeViewerAttachments();
  }

  G.rifts.forEach((rift) => updateRift(rift, frame, refSpace, dt));
  updateGhosts(dt, tracked);

  G.hudTimer -= dt;
  if (G.hudTimer <= 0) {
    G.hudTimer = 0.25;
    refreshSlowState();
    updateControls();
    if (!$('panel').hidden) $('diag').textContent = buildDiagnostics();
  }
  updateBanner();
  renderer.render(scene, camera);
}

// Uses the view the picture is drawn from, since some runtimes report a different pose.transform.
function updateViewer(pose) {
  const view = pose.views[0];
  V.known = true;
  V.matrix.fromArray((view?.transform ?? pose.transform).matrix);
  V.matrix.decompose(V.pos, V.quat, V.scale);
  V.fwd.set(0, 0, -1).applyQuaternion(V.quat);
  V.up.set(0, 1, 0).applyQuaternion(V.quat);
  V.right.set(1, 0, 0).applyQuaternion(V.quat);

  // Run the middle of the screen back through the projection to get the true aim ray.
  V.aim.copy(V.fwd);
  if (view?.projectionMatrix) {
    inverseProjection.fromArray(view.projectionMatrix).invert();
    tmpA.set(0, 0, -1).applyMatrix4(inverseProjection).normalize();
    if (tmpA.z < 0 && Number.isFinite(tmpA.x + tmpA.y + tmpA.z)) V.aim.copy(tmpA).applyQuaternion(V.quat);
  }

  // Reported in diagnostics, to show how far this runtime's poses disagree.
  poseMatrix.fromArray(pose.transform.matrix);
  posePos.setFromMatrixPosition(poseMatrix);
  tmpA.setFromMatrixColumn(poseMatrix, 2).negate().normalize();
  G.align.poseDeg = THREE.MathUtils.radToDeg(tmpA.angleTo(V.fwd));
  G.align.poseCm = posePos.distanceTo(V.pos) * 100;
  G.align.aimDeg = THREE.MathUtils.radToDeg(V.aim.angleTo(V.fwd));
  G.align.maxPoseDeg = Math.max(G.align.maxPoseDeg, G.align.poseDeg);
}

function updateTracking(tracked) {
  const next = tracked ? 'ok' : 'lost';
  if (next === G.tracking) return;
  if (next === 'lost') G.trackingLosses++;
  log(`Tracking: ${next}`);
  G.tracking = next;
}

function readHits(frame, refSpace) {
  let closest = null;
  let closestDeg = Infinity;
  G.rays.forEach((ray, index) => {
    ray.hit = null;
    const results = frame.getHitTestResults(ray.source);
    if (!results.length) return;
    const hitPose = results[0].getPose(refSpace);
    if (!hitPose) return;

    hitMatrix.fromArray(hitPose.transform.matrix);
    const position = new THREE.Vector3().setFromMatrixPosition(hitMatrix);
    // WebXR defines the pose's Y axis as the surface normal.
    const normal = new THREE.Vector3().setFromMatrixColumn(hitMatrix, 1).normalize();
    const hit = {
      result: results[0], position, normal, matrix: hitMatrix.clone(), distance: position.distanceTo(V.pos),
    };
    ray.hit = hit;

    const cell = G.surfaces.add(position, normal, V.pos);
    if (cell?.hits === 1) addDot(cell);

    const offCenter = THREE.MathUtils.radToDeg(tmpA.subVectors(position, V.pos).angleTo(V.aim));
    if (offCenter < closestDeg) {
      closestDeg = offCenter;
      closest = hit;
    }
    if (index === 0) {
      G.align.hitDeg = offCenter;
      G.align.maxHitDeg = Math.max(G.align.maxHitDeg, offCenter);
    }
  });

  // Checked against the crosshair, so a misbehaving ray can't place anything somewhere else.
  G.centerHit = closestDeg <= MAX_CENTER_HIT_DEG ? closest : null;
  const showReticle = G.state === 'scanning' && G.tapMode && !!G.centerHit && isWallHit(G.centerHit);
  reticle.visible = showReticle;
  if (showReticle) reticle.matrix.copy(G.centerHit.matrix);
}

function isWallHit(hit) {
  return classify(hit.normal.y) === 'wall';
}

function placeViewerAttachments() {
  crosshair.position.copy(V.pos).addScaledVector(V.aim, 0.6);
  crosshair.quaternion.copy(V.quat);
  if (fallback.mesh) {
    fallback.mesh.position.copy(V.pos).addScaledVector(V.fwd, 0.8).addScaledVector(V.up, -0.2);
    fallback.mesh.quaternion.copy(V.quat);
  }
}

function refreshSlowState() {
  G.floorY = G.surfaces.floorY();
  // Compares every cell against every other, so it runs less often than the rest of this.
  G.candidateTick = (G.candidateTick + 1) % 3;
  if (G.state === 'scanning' && V.known && G.candidateTick === 0) {
    G.candidateCount = G.surfaces.candidates(V.pos).length;
  }
  audio.resume();
}

// ---------- Actions that need an active XR frame ----------

function runPending(frame, refSpace) {
  const actions = G.pending;
  G.pending = [];
  actions.forEach((action) => action(frame, refSpace));
}

function addRift(frame, refSpace, position, normal, kind, hitResult) {
  const rift = createRift(position, normal, kind);
  rift.id = G.rifts.length + 1;
  setRiftDebug(rift, G.debug);
  scene.add(rift.group);
  anchorRift(rift, frame, refSpace, hitResult);
  G.rifts.push(rift);
  log(`Rift R${rift.id}: ${kind} at ${fmt(position)}, ${rift.anchorMethod} anchor`);
  return rift;
}

function autoPlaceRifts(frame, refSpace) {
  const candidates = G.surfaces.candidates(V.pos);
  const picks = selectRifts(candidates, V.pos, CFG.riftCount);
  log(`Auto placement: ${picks.length} picked from ${candidates.length} candidates`);
  picks.forEach((cell) => addRift(frame, refSpace, cell.pos, cell.normal, cell.kind, null));
}

function startPlaying() {
  if (!G.rifts.length) {
    say('No rifts yet. Scan more, or use tap to place.', 3);
    return;
  }
  G.tapMode = false;
  G.spawnTimer = 1.5;
  setState('playing');
  log('Ghosts active');
}

// ---------- Ghosts ----------

function spawnGhost() {
  if (!G.rifts.length) return;
  const rift = G.rifts[Math.floor(Math.random() * G.rifts.length)];
  G.ghosts.push(new Ghost(rift, scene, audio.createVoice(), CFG.ghostSpeed));
  G.stats.spawned++;
  log(`Ghost from R${rift.id}`);
}

// Fades a ghost when a hit-test ray finds a real surface between it and the player.
function isRayOccluded(ghost) {
  if (!G.rayFade || ghost.phase !== 'chase') return false;
  ghost.getWorldPosition(tmpA);
  tmpA.sub(V.pos);
  const distance = tmpA.length();
  tmpA.divideScalar(distance);
  const cone = Math.cos(THREE.MathUtils.degToRad(9));
  return G.rays.some(({ hit }) => {
    if (!hit || hit.distance >= distance - 0.25) return false;
    tmpB.subVectors(hit.position, V.pos).normalize();
    return tmpB.dot(tmpA) > cone;
  });
}

function updateGhosts(dt, tracked) {
  if (G.state === 'playing' && tracked) {
    G.spawnTimer -= dt;
    const alive = G.ghosts.filter((ghost) => ghost.alive).length;
    if (G.spawnTimer <= 0 && alive < CFG.maxGhosts) {
      G.spawnTimer = CFG.spawnInterval;
      spawnGhost();
    }
  }

  let nearest = null;
  let nearestDist = Infinity;
  for (const ghost of G.ghosts) {
    const result = ghost.update(dt, V.pos, {
      paused: !tracked,                // World-locked positions can't be trusted without tracking.
      floorY: G.floorY,
      occluded: ghost.alive && isRayOccluded(ghost),
      brightness: G.brightness,
    });

    if (result === 'reached') {
      G.stats.reached++;
      ghost.remove();
      audio.blip(90, 0.5, 'sawtooth', 0.3);
      flashDamage();
      say('A ghost reached you', 2);
      log('Ghost reached the player');
      continue;
    }
    if (ghost.done) continue;

    ghost.getWorldPosition(tmpA);
    ghost.voice?.update(tmpA);
    if (ghost.alive) {
      const distance = tmpA.distanceTo(V.pos);
      if (distance < nearestDist) {
        nearestDist = distance;
        nearest = ghost;
      }
    }
  }
  G.ghosts = G.ghosts.filter((ghost) => !ghost.done);
  updateArrow(nearest);
}

function shoot() {
  let best = null;
  let bestT = Infinity;
  for (const ghost of G.ghosts) {
    if (!ghost.shootable) continue;
    ghost.getWorldPosition(tmpA);
    tmpA.sub(V.pos);
    const t = tmpA.dot(V.aim);
    if (t <= 0 || t >= bestT) continue;
    const miss = tmpB.copy(V.aim).multiplyScalar(t).distanceTo(tmpA);
    if (miss < 0.14 + t * 0.03) {    // Forgiving aim, wider with distance.
      best = ghost;
      bestT = t;
    }
  }
  if (best) {
    best.kill();
    G.stats.kills++;
    audio.blip(880, 0.25);
    say('Ghost destroyed');
    log(`Kill at ${bestT.toFixed(2)} m`);
  } else {
    G.stats.misses++;
    audio.blip(180, 0.08, 'square', 0.06);
  }
}

// Points toward the nearest ghost when it's off screen.
function updateArrow(ghost) {
  const arrow = $('arrow');
  if (!ghost || !G.showArrow || G.overlay === 'none') {
    arrow.hidden = true;
    return;
  }
  ghost.getWorldPosition(tmpA);
  tmpA.sub(V.pos).applyQuaternion(tmpQuat.copy(V.quat).invert());
  const onScreen = tmpA.z < 0 && Math.abs(tmpA.x / tmpA.z) < 0.4 && Math.abs(tmpA.y / tmpA.z) < 0.75;
  arrow.hidden = onScreen;
  if (onScreen) return;
  const angle = Math.atan2(tmpA.x, tmpA.y);
  const radius = Math.min(innerWidth, innerHeight) * 0.38;
  arrow.style.transform =
    `translate(${Math.sin(angle) * radius}px, ${-Math.cos(angle) * radius}px) rotate(${angle}rad)`;
}

function flashDamage() {
  const flash = $('flash');
  flash.classList.add('on');
  requestAnimationFrame(() => requestAnimationFrame(() => flash.classList.remove('on')));
}

// ---------- Input ----------

// A tap can arrive as an XR select, a DOM touch, or both, so close pairs count once.
function onTap(source) {
  const now = performance.now();
  if (source === 'select') G.stats.tapsSelect++;
  else G.stats.tapsTouch++;
  if (now - G.lastTap < 180) return;
  G.lastTap = now;

  if (G.state === 'playing') {
    if (V.known) shoot();
  } else if (G.state === 'scanning') {
    if (G.tapMode) queueTapPlacement();
    else if (G.overlay === 'none' && canOpenRifts()) primaryAction();   // No buttons without an overlay.
  }
}

function queueTapPlacement() {
  G.pending.push((frame, refSpace) => {
    const hit = G.centerHit;
    if (!hit) {
      say('No surface under the crosshair', 2);
      return;
    }
    if (!isWallHit(hit)) {
      say('Rifts only open on walls. Aim at a wall.', 2);
      return;
    }
    const normal = hit.normal.clone();
    if (tmpA.subVectors(V.pos, hit.position).dot(normal) < 0) normal.negate();
    addRift(frame, refSpace, hit.position, normal, 'wall', hit.result);
    say(`Rift ${G.rifts.length} placed`);
  });
}

function canOpenRifts() {
  return G.rifts.length > 0 || G.candidateCount > 0;
}

function primaryAction() {
  G.pending.push((frame, refSpace) => {
    if (!G.rifts.length) autoPlaceRifts(frame, refSpace);
    startPlaying();
  });
}

function placeAirRift() {
  G.pending.push((frame, refSpace) => {
    const position = V.pos.clone().addScaledVector(V.aim, 2.5);
    addRift(frame, refSpace, position, V.aim.clone().negate(), 'air', null);
    say('Air rift placed');
    if (G.state === 'scanning') startPlaying();
  });
}

function runAudioTest() {
  audio.resume();
  const steps = [
    ['LEFT', 'right', -1.5], ['RIGHT', 'right', 1.5],
    ['FRONT', 'fwd', 1.5], ['BEHIND', 'fwd', -1.5],
    ['ABOVE', 'up', 1.5], ['BELOW', 'up', -1.5],
  ];
  steps.forEach(([label, axis, amount], index) => {
    setTimeout(() => {
      G.beepLabel = `Audio test: ${label}`;
      audio.beepAt(V.pos.clone().addScaledVector(V[axis], amount));
    }, index * 1100);
  });
  setTimeout(() => { G.beepLabel = ''; }, steps.length * 1100);
  log(`Audio test started. Context: ${audio.state}`);
}

// ---------- Interface ----------

function updateBanner() {
  const banner = $('banner');
  let text = '';
  let warn = false;
  if (G.tracking === 'lost') {
    text = 'Tracking lost. Move slowly and aim at a detailed, well-lit area.';
    warn = true;
  } else if (G.beepLabel) {
    text = G.beepLabel;
  } else if (performance.now() < G.messageUntil) {
    text = G.message;
  } else if (G.state === 'scanning') {
    const { wall, up } = G.surfaces.counts();
    const stuck = G.candidateCount === 0 && !G.rifts.length && performance.now() - G.scanStart > 20000;
    if (G.tapMode) {
      text = `Aim the crosshair at a wall and tap. Rifts: ${G.rifts.length}`;
    } else if (stuck) {
      text = 'No usable walls yet. Try one with more detail or light, or use Air rift in Diagnostics.';
    } else {
      text = `Sweep over walls and floor. Walls ${wall}, floor/table ${up}`;
    }
  } else if (G.state === 'playing') {
    text = `Aim the crosshair and tap. Kills ${G.stats.kills}, reached you ${G.stats.reached}`;
  }
  if (banner.textContent !== text) banner.textContent = text;
  banner.classList.toggle('warn', warn);
  drawFallbackPanel(text.length > 44 ? text.replace(/(.{1,44})\s/g, '$1\n') : text);
}

function updateControls() {
  const primary = $('btn-primary');
  primary.disabled = !canOpenRifts();
  primary.textContent = G.rifts.length ? 'Start ghosts' : `Open rifts (${G.candidateCount} spots)`;
  $('btn-tap').textContent = `Tap to place: ${G.tapMode ? 'on' : 'off'}`;
}

function fmt(v) {
  return `${v.x.toFixed(2)}, ${v.y.toFixed(2)}, ${v.z.toFixed(2)}`;
}

function buildDiagnostics() {
  const counts = G.surfaces.counts();
  const anchored = G.rifts.filter((rift) => rift.anchor).length;
  const lines = [
    `State ${G.state} | FPS ${G.fps.toFixed(0)} | Tracking ${G.tracking} (lost ${G.trackingLosses}x)`,
    `Launch tracking ${G.launchTracking} | Space resets ${G.refResets}`,
    `Features ${G.session?.enabledFeatures ? [...G.session.enabledFeatures].join(', ') : 'not reported'}`,
    `DOM overlay ${G.overlay} | Hit rays ${G.rays.length}`,
    `Pose vs view ${G.align.poseDeg.toFixed(1)} deg (max ${G.align.maxPoseDeg.toFixed(1)}), ${G.align.poseCm.toFixed(1)} cm`,
    `Lens offset ${G.align.aimDeg.toFixed(1)} deg | Center ray off crosshair ${G.align.hitDeg === null ? 'n/a' : G.align.hitDeg.toFixed(1)} deg (max ${G.align.maxHitDeg.toFixed(1)})`,
    `Surfaces wall ${counts.wall}, up ${counts.up}, down ${counts.down} | Rejected ${G.surfaces.rejected}, flipped ${G.surfaces.flipped}`,
    `Floor ${G.floorY === null ? 'unknown' : `${G.floorY.toFixed(2)} m`} | Candidates ${G.candidateCount}`,
    `Rifts ${G.rifts.length}, anchored ${anchored}`,
    ...G.rifts.map((rift) => `  R${rift.id} ${rift.kind}: ${rift.anchorState} (${rift.anchorMethod}), `
      + `${rift.tracked ? 'tracked' : 'untracked'}, jump ${(rift.maxJump * 100).toFixed(1)} cm, drift ${(rift.drift * 100).toFixed(1)} cm`),
    `Ghosts alive ${G.ghosts.filter((ghost) => ghost.alive).length}, spawned ${G.stats.spawned}`,
    `Kills ${G.stats.kills}, misses ${G.stats.misses}, reached ${G.stats.reached}`,
    `Taps: select ${G.stats.tapsSelect}, touch ${G.stats.tapsTouch}`,
    `Audio ${audio.state}, voices ${audio.voices.size}`,
  ];
  if (window.__ghErrors.length) lines.push(`Errors: ${window.__ghErrors.join(' | ')}`);
  lines.push('Log:', ...G.log.slice(-10));
  return lines.join('\n');
}

function showReport() {
  const report = $('report');
  report.textContent = G.reports.join('\n\n') || buildDiagnostics();
  report.hidden = false;
  $('btn-copy-menu').hidden = false;
}

async function copyReport(button) {
  const inSession = G.state !== 'menu';
  const text = inSession
    ? [...G.reports, buildDiagnostics()].join('\n\n')
    : G.reports.join('\n\n') || buildDiagnostics();
  const original = button.textContent;
  try {
    await navigator.clipboard.writeText(text);
    button.textContent = 'Copied';
  } catch {
    // Web views often block the clipboard, so fall back to a text selection the user can copy.
    const target = inSession ? $('diag') : $('report');
    target.textContent = text;
    getSelection().selectAllChildren(target);
    button.textContent = 'Selected: copy it';
  }
  setTimeout(() => { button.textContent = original; }, 2500);
}

function bindUI() {
  $('btn-enter').addEventListener('click', enterAR);

  $('btn-probe').addEventListener('click', async () => {
    const button = $('btn-probe');
    button.disabled = true;
    try {
      G.reports.push(await probeFeatures($('overlay')));
    } catch (error) {
      G.reports.push(`Probe failed: ${error.name}: ${error.message}`);
    }
    button.disabled = false;
    showReport();
  });

  $('btn-copy-menu').addEventListener('click', (e) => copyReport(e.currentTarget));
  $('btn-copy').addEventListener('click', (e) => copyReport(e.currentTarget));
  $('btn-exit').addEventListener('click', () => G.session?.end());
  $('btn-primary').addEventListener('click', primaryAction);
  $('btn-spawn').addEventListener('click', spawnGhost);
  $('btn-beep').addEventListener('click', runAudioTest);
  $('btn-air').addEventListener('click', placeAirRift);

  $('btn-tap').addEventListener('click', () => {
    G.tapMode = !G.tapMode;
    updateControls();
  });

  $('btn-panel').addEventListener('click', (e) => {
    const panel = $('panel');
    panel.hidden = !panel.hidden;
    e.currentTarget.setAttribute('aria-expanded', String(!panel.hidden));
    if (!panel.hidden) $('diag').textContent = buildDiagnostics();
  });

  $('chk-debug').addEventListener('change', (e) => {
    G.debug = e.target.checked;
    G.rifts.forEach((rift) => setRiftDebug(rift, G.debug));
    dots.visible = G.state === 'scanning' || G.debug;
  });
  $('chk-arrow').addEventListener('change', (e) => { G.showArrow = e.target.checked; });
  $('chk-fade').addEventListener('change', (e) => { G.rayFade = e.target.checked; });
  $('rng-bright').addEventListener('input', (e) => { G.brightness = Number(e.target.value); });

  // Touches on the interface shouldn't fire the weapon as well.
  document.querySelectorAll('.ui').forEach((element) => {
    element.addEventListener('beforexrselect', (e) => e.preventDefault());
  });
  $('overlay').addEventListener('pointerdown', (e) => {
    if (G.session && !e.target.closest('.ui')) onTap('touch');
  });

  const onLaunchTracking = (e) => {
    G.launchTracking = e.detail?.state || 'unknown';
    log(`Launch tracking: ${G.launchTracking}`);
  };
  window.addEventListener('vlaunch-ar-tracking', onLaunchTracking);
  document.addEventListener('vlaunch-ar-tracking', onLaunchTracking);
}

function addLaunchLink(label, href) {
  const link = document.createElement('a');
  link.className = 'button';
  link.href = href;
  link.textContent = label;
  $('launch-links').append(link);
}

function applyLaunchInfo(detail) {
  if (!detail) return;
  log(`Variant Launch: ${detail.webXRStatus}`);
  if (detail.launchRequired && detail.launchUrl) addLaunchLink('Open with Variant Launch', detail.launchUrl);
}

async function checkSupport() {
  const status = $('support-status');
  const enter = $('btn-enter');
  let supported = false;
  if (navigator.xr) {
    try {
      supported = await navigator.xr.isSessionSupported('immersive-ar');
    } catch (error) {
      log(`Support check failed: ${error.name}`);
    }
  }
  enter.disabled = !supported;
  if (supported) {
    status.textContent = 'AR is available here.';
    return;
  }
  status.textContent = navigator.xr
    ? 'This browser has WebXR, but not AR.'
    : 'This browser has no WebXR. On iPhone, open this page in a WebXR app or launcher.';
  addLaunchLink('Open with Needle Go', `https://appclip.needle.tools/ar?url=${encodeURIComponent(location.href)}`);
}

// Lets the simulator draw its fake room and tests inspect state. Not used on a device.
window.__gh = { G, V, scene, audio, THREE, SurfaceMap, selectRifts, spawnGhost };

bindUI();
applyLaunchInfo(window.__ghLaunch);
window.addEventListener('vlaunch-initialized', (e) => applyLaunchInfo(e.detail));
await checkSupport();
