import * as THREE from './three.js';
import { RoomModel, findRiftSpots, pickRiftSpot, isRiftSite, distanceToEdge } from './room.js';
import { createRift, anchorRift, updateRift, closeRift, destroyRift, HOLE_RADIUS } from './rift.js';
import { Ghost } from './ghost.js';
import { SpatialAudio } from './audio.js';
import { DepthOcclusion } from './depth.js';
import { Pointers } from './input.js';
import { Panel, Toast, ScoreHud } from './ui.js';
import { probeFeatures } from './probe.js';

if (new URLSearchParams(location.search).has('sim')) await import('../test/mock-xr.js');

const CFG = window.GH_CONFIG;
const $ = (id) => document.getElementById(id);

const NO_ROOM_GRACE_SECONDS = 3;   // Meta says planes can take 2 to 3 seconds to appear.
const BRIGHTNESS_STEPS = [1, 0.75, 0.5];
const BEST_SCORE_KEY = 'ghostHunter.bestScore';
const emptyKills = () => ({ normal: 0, small: 0, big: 0 });

const G = {
  state: 'menu',            // menu -> setup -> playing -> gameover -> playing ...
  session: null,
  refType: 'local',
  rifts: [],
  ghosts: [],
  spots: [],
  placing: false,
  placeTarget: null,
  hitSource: null,
  hitSourceFor: null,
  hitSourcePending: false,
  pending: [],
  sessionTime: 0,
  roomCaptureUsed: false,
  riftCounter: 0,
  playTime: 0,
  spawnTimer: 0,
  riftTimer: 0,
  score: 0,
  best: loadBest(),
  newBest: false,
  kills: emptyKills(),
  spawnedByType: emptyKills(),
  uiTimer: 0,
  fps: 0,
  minFps: Infinity,
  lastTime: 0,
  tracking: 'unknown',
  trackingLosses: 0,
  refResets: 0,
  brightnessStep: 0,
  debug: false,
  voicesMuted: false,
  beepLabel: '',
  message: '',
  messageUntil: 0,
  flash: 0,
  stats: { misses: 0, hits: 0, selects: 0, riftsOpened: 0, riftsClosed: 0 },
  log: [],
  reports: [],
};

const device = (() => {
  const match = navigator.userAgent.match(/Quest (\d\w*|Pro)/i);
  return match ? `Quest ${match[1]}` : 'not a Quest';
})();

const audio = new SpatialAudio();
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(70, 1, 0.05, 40);
const room = new RoomModel(scene);
const depth = new DepthOcclusion();
const pointers = new Pointers(scene);
let panel = null;
let toast = null;
let scoreHud = null;
let renderer = null;

// The head pose, in the reference space.
const H = {
  known: false,
  matrix: new THREE.Matrix4(),
  pos: new THREE.Vector3(0, 1.6, 0),
  quat: new THREE.Quaternion(),
  scale: new THREE.Vector3(),
  fwd: new THREE.Vector3(0, 0, -1),
  up: new THREE.Vector3(0, 1, 0),
  right: new THREE.Vector3(1, 0, 0),
};

const tmpA = new THREE.Vector3();
const tmpB = new THREE.Vector3();
const hitMatrix = new THREE.Matrix4();
const Y_AXIS = new THREE.Vector3(0, 1, 0);

function log(message) {
  G.log.push(`${new Date().toISOString().slice(11, 19)} ${message}`);
  if (G.log.length > 40) G.log.shift();
}

function say(message, seconds = 2) {
  G.message = message;
  G.messageUntil = performance.now() + seconds * 1000;
}

// Storage can be unavailable in private windows, and the game works fine without it.
function loadBest() {
  try {
    return Number(localStorage.getItem(BEST_SCORE_KEY)) || 0;
  } catch {
    return 0;
  }
}

function saveBest() {
  if (G.score <= G.best) return;
  G.best = G.score;
  G.newBest = true;
  try {
    localStorage.setItem(BEST_SCORE_KEY, String(G.best));
  } catch { /* Kept for this visit only. */ }
}

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

function ramp([start, end]) {
  return start + (end - start) * Math.min(1, G.playTime / CFG.rampSeconds);
}

// ---------- Things drawn in the world ----------

const reticle = new THREE.Mesh(
  new THREE.RingGeometry(0.15, 0.18, 32).rotateX(-Math.PI / 2),
  new THREE.MeshBasicMaterial({ color: 0x8cf0c0, transparent: true, depthWrite: false, side: THREE.DoubleSide }),
);
reticle.visible = false;
scene.add(reticle);

// Only used when no controller or hand is tracked, so the head does the aiming.
const gazeCursor = new THREE.Mesh(
  new THREE.RingGeometry(0.012, 0.016, 32),
  new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, depthTest: false }),
);
gazeCursor.renderOrder = 150;
gazeCursor.visible = false;
scene.add(gazeCursor);

const damageFlash = new THREE.Mesh(
  new THREE.SphereGeometry(0.2, 16, 12),
  new THREE.MeshBasicMaterial({ color: 0xff3030, transparent: true, opacity: 0, side: THREE.BackSide, depthTest: false }),
);
damageFlash.renderOrder = 220;
damageFlash.visible = false;
scene.add(damageFlash);

// ---------- Session lifecycle ----------

function ensureRenderer() {
  if (renderer) return;
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.xr.enabled = true;
  window.__gh.renderer = renderer;
}

function requestGameSession() {
  return navigator.xr.requestSession('immersive-ar', {
    optionalFeatures: ['local-floor', 'plane-detection', 'anchors', 'hit-test', 'depth-sensing', 'hand-tracking'],
    // GPU only: this is the form three.js reads. Quest 2 simply won't grant the feature.
    depthSensing: { usagePreference: ['gpu-optimized'], dataFormatPreference: [] },
  });
}

async function enterAR() {
  audio.unlock();
  try {
    await startSession(await requestGameSession());
  } catch (error) {
    log(`Could not start AR: ${error.name}: ${error.message}`);
    $('support-status').textContent = `Could not start AR: ${error.message}`;
    showReport();
  }
}

async function startSession(session) {
  ensureRenderer();
  G.session = session;
  G.sessionTime = 0;
  G.lastTime = 0;
  G.roomCaptureUsed = false;
  log(`Session started on ${device}`);
  log(`Granted: ${session.enabledFeatures ? [...session.enabledFeatures].join(', ') : 'not reported'}`);

  session.addEventListener('end', onSessionEnd);
  session.addEventListener('select', (event) => {
    G.stats.selects++;
    G.pending.push(() => handleSelect(event.inputSource));
  });
  session.addEventListener('squeeze', togglePanel);
  session.addEventListener('visibilitychange', () => {
    log(`Visibility: ${session.visibilityState}`);
    audio.setMuted(session.visibilityState !== 'visible');
  });

  // local-floor puts the real floor at y = 0.
  G.refType = await session.requestReferenceSpace('local-floor').then(() => 'local-floor', () => 'local');
  log(`Reference space: ${G.refType}`);
  renderer.xr.setReferenceSpaceType(G.refType);
  await renderer.xr.setSession(session);

  renderer.xr.getReferenceSpace()?.addEventListener?.('reset', () => {
    G.refResets++;
    log('Reference space reset');
  });

  panel = new Panel(scene);
  toast = new Toast(scene);
  scoreHud = new ScoreHud(scene);
  G.minFps = Infinity;
  setState('setup');
  document.documentElement.classList.add('in-session');
  renderer.setAnimationLoop(onFrame);
}

function onSessionEnd() {
  log('Session ended');
  saveBest();
  G.reports.push(buildDiagnostics());
  renderer.setAnimationLoop(null);
  clearRound();
  G.spots = [];
  room.dispose();
  depth.reset();
  pointers.dispose();
  panel?.dispose(scene);
  toast?.dispose(scene);
  scoreHud?.dispose(scene);
  panel = null;
  toast = null;
  scoreHud = null;
  setPlacing(false);
  G.pending = [];
  G.session = null;
  G.tracking = 'unknown';
  G.score = 0;
  H.known = false;
  syncVoiceMute(false);
  [reticle, gazeCursor, damageFlash].forEach((object) => { object.visible = false; });
  document.documentElement.classList.remove('in-session');
  G.state = 'menu';
  showReport();
}

function setState(state) {
  G.state = state;
  room.setOutlines(state === 'setup' || G.debug);
  G.uiTimer = 0;
}

// ---------- Frame loop ----------

function onFrame(time, frame) {
  const elapsed = G.lastTime ? (time - G.lastTime) / 1000 : 0;
  const dt = Math.min(elapsed, 0.1);   // Game movement stays small after a long stall.
  G.lastTime = time;
  if (elapsed > 0.002) {   // Ignores timer jitter, which would read as an absurd frame rate.
    G.fps += (1 / elapsed - G.fps) * 0.05;
    if (G.sessionTime > 3) G.minFps = Math.min(G.minFps, G.fps);
  }
  if (!frame) return;
  G.sessionTime += elapsed;

  const refSpace = renderer.xr.getReferenceSpace();
  const pose = frame.getViewerPose(refSpace);
  const tracked = !!pose && !pose.emulatedPosition;
  updateTracking(tracked);

  if (pose) {
    H.known = true;
    // pose.transform is the point between the eyes, not one eye's view.
    H.matrix.fromArray(pose.transform.matrix);
    H.matrix.decompose(H.pos, H.quat, H.scale);
    H.fwd.set(0, 0, -1).applyQuaternion(H.quat);
    H.up.set(0, 1, 0).applyQuaternion(H.quat);
    H.right.set(1, 0, 0).applyQuaternion(H.quat);
    audio.setListener(H.pos, H.fwd, H.up);
  }

  room.update(frame, refSpace, H.pos.y);
  pointers.update(frame, refSpace, G.session, dt);
  updatePlacement(frame, refSpace);

  const actions = G.pending;
  G.pending = [];
  actions.forEach((action) => action(frame, refSpace));

  // Tracking loss, the system menu and the in-game menu all stop the game.
  const paused = G.state === 'playing' && !!panel?.visible;
  const active = tracked && G.session?.visibilityState === 'visible' && !paused;
  syncVoiceMute(paused);

  depth.update(renderer, G.rifts);
  updateRifts(frame, refSpace, dt);
  if (G.state === 'playing' && active) updateDirector(frame, refSpace, dt);
  updateGhosts(dt, active);
  updateAim();
  updateEffects(dt);

  G.uiTimer -= elapsed;
  if (G.uiTimer <= 0) {
    G.uiTimer = 0.5;
    refreshInterface();
  }
  updateToast();
  scoreHud?.update(G.state === 'playing', G.score, Math.max(G.score, G.best), H.pos, H.quat, H.up, H.fwd);
  renderer.render(scene, camera);
}

function syncVoiceMute(muted) {
  if (muted === G.voicesMuted) return;
  G.voicesMuted = muted;
  audio.setVoicesMuted(muted);
}

function updateTracking(tracked) {
  const next = tracked ? 'ok' : 'lost';
  if (next === G.tracking) return;
  if (next === 'lost') G.trackingLosses++;
  log(`Tracking: ${next}`);
  G.tracking = next;
}

// ---------- Aiming ----------

// The ray used by a pointer, or by the head if nothing is being tracked.
function rayFor(pointer) {
  return pointer ? { origin: pointer.origin, direction: pointer.direction } : { origin: H.pos, direction: H.fwd };
}

function updateAim() {
  let hovered = null;
  for (const pointer of pointers.list) {
    const onPanel = panel?.hit(pointer.origin, pointer.direction);
    const onRoom = room.raycast(pointer.origin, pointer.direction);
    let length = 4;
    if (onRoom) length = onRoom.distance;
    if (onPanel) {
      length = onPanel.distance;
      if (onPanel.button && pointer === pointers.active) hovered = onPanel.button.id;
    }
    pointers.drawLaser(pointer, length);
  }
  panel?.setHover(hovered);

  const noPointers = pointers.list.length === 0 && H.known;
  gazeCursor.visible = noPointers;
  if (noPointers) {
    gazeCursor.position.copy(H.pos).addScaledVector(H.fwd, 1.2);
    gazeCursor.quaternion.copy(H.quat);
  }
}

function handleSelect(source) {
  const pointer = pointers.forSource(source);
  if (pointer) pointers.active = pointer;
  const { origin, direction } = rayFor(pointer);

  const onPanel = panel?.hit(origin, direction);
  if (onPanel) {
    if (onPanel.button && onPanel.button.enabled !== false) {
      pointers.pulse(pointer, 0.3, 30);
      runButton(onPanel.button.id);
    }
    return;
  }

  if (G.placing) {
    placeFromAim();
  } else if (G.state === 'playing' && !panel?.visible) {
    if (pointer) pointers.fire(pointer);
    shoot(origin, direction, pointer);
  }
}

function shoot(origin, direction, pointer) {
  let best = null;
  let bestT = Infinity;
  for (const ghost of G.ghosts) {
    if (!ghost.shootable) continue;
    ghost.getWorldPosition(tmpA);
    tmpA.sub(origin);
    const t = tmpA.dot(direction);
    if (t <= 0 || t >= bestT) continue;
    const miss = tmpB.copy(direction).multiplyScalar(t).distanceTo(tmpA);
    if (miss < ghost.type.hitRadius + t * 0.03) {    // Forgiving aim, wider with distance.
      best = ghost;
      bestT = t;
    }
  }
  if (!best) {
    G.stats.misses++;
    audio.blip(180, 0.08, 'square', 0.06);
    pointers.pulse(pointer, 0.2, 20);
    return;
  }

  G.stats.hits++;
  if (best.hit(direction)) {
    G.score += best.type.points;
    G.kills[best.typeName]++;
    audio.blip(880, 0.25);
    pointers.pulse(pointer, 0.9, 90);
    log(`Killed ${best.typeName} at ${bestT.toFixed(2)} m`);
  } else {
    audio.blip(520, 0.1, 'square', 0.12);
    pointers.pulse(pointer, 0.5, 40);
  }
}

// ---------- Rifts ----------

function addRift(frame, refSpace, position, normal, surface, site) {
  const rift = createRift(position, normal, surface);
  rift.id = ++G.riftCounter;
  rift.quota = Math.round(randomBetween(CFG.ghostsPerRiftMin, CFG.ghostsPerRiftMax));
  rift.kind = site?.entry.kind || surface;
  if (site) rift.site = { entry: site.entry, hole: room.addHole(site.entry, site.x, site.z, HOLE_RADIUS) };
  scene.add(rift.group);
  anchorRift(rift, frame, refSpace);
  G.rifts.push(rift);
  G.stats.riftsOpened++;
  log(`Rift R${rift.id}: ${rift.kind} at ${fmt(position)}, ${rift.quota} ghosts`);
  return rift;
}

function isOpen(rift) {
  return rift.phase === 'opening' || rift.phase === 'open';
}

// Opens a rift somewhere random. With no room data, it floats in the air instead.
function openRandomRift(frame, refSpace, { desperate = false } = {}) {
  const taken = G.rifts.filter((rift) => rift.phase !== 'closed').map((rift) => rift.group.position);
  const spots = findRiftSpots(room.list, H.pos);
  let spot = pickRiftSpot(spots, H.pos, taken);
  if (!spot && desperate) spot = pickRiftSpot(spots, H.pos, taken, { minSpacing: 0.6 });

  if (spot) {
    return addRift(frame, refSpace, spot.pos, spot.normal, 'room', { entry: spot.surface, x: spot.local.x, z: spot.local.z });
  }
  if (spots.length) return null;   // The room is full for now, so try again later.

  const azimuth = Math.random() * Math.PI * 2;
  const elevation = THREE.MathUtils.degToRad(randomBetween(-20, 25));
  const direction = new THREE.Vector3(
    Math.sin(azimuth) * Math.cos(elevation),
    Math.sin(elevation),
    Math.cos(azimuth) * Math.cos(elevation),
  );
  const position = H.pos.clone().addScaledVector(direction, randomBetween(2, 3));
  return addRift(frame, refSpace, position, direction.negate(), 'air', null);
}

function updateRifts(frame, refSpace, dt) {
  for (const rift of G.rifts) {
    updateRift(rift, frame, refSpace, dt);
    if (rift.phase === 'closed' && rift.site) {
      room.removeHole(rift.site.entry, rift.site.hole);
      rift.site = null;
    }
  }
  // A closed rift's anchor stays until its last ghost has gone, since ghosts are positioned by it.
  G.rifts = G.rifts.filter((rift) => {
    if (rift.phase !== 'closed' || G.ghosts.some((ghost) => ghost.rift === rift)) return true;
    destroyRift(rift, scene);
    return false;
  });
}

// Decides what happens next: which rifts close, when new ones open, and which ghosts come out.
function updateDirector(frame, refSpace, dt) {
  G.playTime += dt;

  for (const rift of G.rifts) {
    if (!isOpen(rift) || rift.spawned < rift.quota) continue;
    const stillEmerging = G.ghosts.some((ghost) => ghost.rift === rift && ghost.alive && ghost.phase === 'emerge');
    if (!stillEmerging) {
      closeRift(rift);
      G.stats.riftsClosed++;
      log(`Rift R${rift.id} closing`);
    }
  }

  const openRifts = G.rifts.filter(isOpen);
  G.riftTimer -= dt;
  if (openRifts.length === 0 || (G.riftTimer <= 0 && openRifts.length < Math.round(ramp(CFG.maxRifts)))) {
    openRandomRift(frame, refSpace, { desperate: openRifts.length === 0 });
    G.riftTimer = randomBetween(CFG.riftOpenIntervalMin, CFG.riftOpenIntervalMax);
  }

  G.spawnTimer -= dt;
  if (G.spawnTimer > 0) return;
  const alive = G.ghosts.filter((ghost) => ghost.alive).length;
  const ready = G.rifts.filter((rift) => rift.phase === 'open' && rift.spawned < rift.quota);
  if (alive >= Math.round(ramp(CFG.maxGhosts)) || !ready.length) return;
  spawnGhost(pickGhostType(), ready[Math.floor(Math.random() * ready.length)]);
  G.spawnTimer = ramp(CFG.spawnInterval);
}

function setPlacing(on) {
  G.placing = on;
  if (!on) {
    G.placeTarget = null;
    reticle.visible = false;
    G.hitSource?.cancel?.();
    G.hitSource = null;
    G.hitSourceFor = null;
  }
}

function canUseHitTest() {
  return typeof G.session?.requestHitTestSource === 'function';
}

// Finds what the active pointer is aimed at: a room surface, or a hit-test surface if there's no room data.
function updatePlacement(frame, refSpace) {
  if (!G.placing) return;
  const pointer = pointers.active;
  const { origin, direction } = rayFor(pointer);
  let target = null;

  const onRoom = room.raycast(origin, direction);
  if (onRoom) {
    const { entry, x, z, distance } = onRoom;
    const normal = new THREE.Vector3().setFromMatrixColumn(entry.matrix, 1).normalize();
    if (normal.dot(direction) > 0) normal.negate();   // Always facing the player.
    target = {
      position: origin.clone().addScaledVector(direction, distance),
      normal,
      site: { entry, x, z },
      surface: 'room',
      valid: isRiftSite(entry.kind) && normal.y > -0.35 && distanceToEdge(x, z, entry.polygon) > HOLE_RADIUS + 0.04,
    };
  } else if (canUseHitTest() && pointer) {
    if (G.hitSourceFor !== pointer.source && !G.hitSourcePending) requestHitSource(pointer.source);
    const results = G.hitSource ? frame.getHitTestResults(G.hitSource) : [];
    const hitPose = results[0]?.getPose(refSpace);
    if (hitPose) {
      hitMatrix.fromArray(hitPose.transform.matrix);
      const normal = new THREE.Vector3().setFromMatrixColumn(hitMatrix, 1).normalize();
      if (normal.dot(direction) > 0) normal.negate();
      target = {
        position: new THREE.Vector3().setFromMatrixPosition(hitMatrix),
        normal,
        site: null,
        surface: 'patch',
        valid: normal.y > -0.35,
      };
    }
  }

  G.placeTarget = target;
  reticle.visible = !!target;
  if (target) {
    reticle.position.copy(target.position).addScaledVector(target.normal, 0.015);
    reticle.quaternion.setFromUnitVectors(Y_AXIS, target.normal);
    reticle.material.color.setHex(target.valid ? 0x8cf0c0 : 0xff6b6b);
  }
}

function requestHitSource(source) {
  G.hitSourcePending = true;
  G.session.requestHitTestSource({ space: source.targetRaySpace }).then((hitSource) => {
    G.hitSource?.cancel?.();
    G.hitSource = hitSource;
    G.hitSourceFor = source;
  }, (error) => {
    log(`Hit test source failed: ${error.name}`);
    G.hitSourceFor = source;   // Don't keep retrying for this pointer.
  }).finally(() => {
    G.hitSourcePending = false;
  });
}

function placeFromAim() {
  G.pending.push((frame, refSpace) => {
    const target = G.placeTarget;
    if (!target) {
      say('Aim at a surface first.');
      return;
    }
    if (!target.valid) {
      say('A rift can\'t open there.');
      return;
    }
    addRift(frame, refSpace, target.position, target.normal, target.surface, target.site);
    say(`Rift placed. ${G.rifts.length} ready.`);
    G.uiTimer = 0;
  });
}

// ---------- A round ----------

// Removes everything from the current round.
function clearRound() {
  audio.stopAll();
  G.ghosts.forEach((ghost) => ghost.remove());
  G.ghosts = [];
  G.rifts.forEach((rift) => {
    if (rift.site) room.removeHole(rift.site.entry, rift.site.hole);
    destroyRift(rift, scene);
  });
  G.rifts = [];
}

function startRound(frame, refSpace) {
  setPlacing(false);
  G.score = 0;
  G.newBest = false;
  G.kills = emptyKills();
  G.spawnedByType = emptyKills();
  G.stats.misses = 0;
  G.stats.hits = 0;
  G.playTime = 0;
  G.spawnTimer = 1.5;
  G.riftTimer = randomBetween(CFG.riftOpenIntervalMin, CFG.riftOpenIntervalMax);

  // Rifts placed by hand during setup count toward the starting number.
  for (let i = G.rifts.length; i < CFG.startingRifts; i++) {
    if (!openRandomRift(frame, refSpace, { desperate: true })) break;
  }
  panel?.hide();
  setState('playing');
  say('Pull the trigger to shoot. Grip opens the menu.', 4);
  log(`Round started with ${G.rifts.length} rifts`);
}

function gameOver() {
  saveBest();
  log(`Game over: score ${G.score}, ${G.playTime.toFixed(0)} s`);
  clearRound();
  audio.blip(90, 0.5, 'sawtooth', 0.3);
  pointers.list.forEach((pointer) => pointers.pulse(pointer, 1, 200));
  G.flash = 0.45;
  G.messageUntil = 0;
  setState('gameover');
  panel?.showInFront(H.pos, H.fwd);
}

// ---------- Ghosts ----------

function pickGhostType() {
  const share = (from, maxShare) => {
    if (G.playTime < from) return 0;
    return 0.1 + (maxShare - 0.1) * Math.min(1, (G.playTime - from) / CFG.mixRampSeconds);
  };
  const big = share(CFG.bigGhostsFrom, CFG.bigGhostsMaxShare);
  const small = share(CFG.smallGhostsFrom, CFG.smallGhostsMaxShare);
  const roll = Math.random();
  if (roll < big) return 'big';
  if (roll < big + small) return 'small';
  return 'normal';
}

function spawnGhost(typeName = 'normal', rift = G.rifts.find(isOpen)) {
  if (!rift) return null;
  const type = CFG.ghostTypes[typeName];
  const ghost = new Ghost(rift, scene, audio.createVoice(type.voice), typeName, type);
  G.ghosts.push(ghost);
  rift.spawned++;
  G.spawnedByType[typeName]++;
  log(`${typeName} ghost from R${rift.id} (${rift.spawned}/${rift.quota})`);
  return ghost;
}

const shadowSurface = (x, y, z) => {
  const surface = room.surfaceBelow(x, y, z);
  if (surface !== null) return surface;
  return G.refType === 'local-floor' ? 0 : null;   // The floor is at 0 in this space.
};

function updateGhosts(dt, active) {
  let reached = false;
  for (const ghost of G.ghosts) {
    const result = ghost.update(dt, H.pos, {
      paused: !active,                 // World-locked positions can't be trusted without tracking.
      shadowSurface,
      brightness: BRIGHTNESS_STEPS[G.brightnessStep],
    });
    if (result === 'reached') reached = true;
    if (ghost.done) continue;
    ghost.getWorldPosition(tmpA);
    ghost.voice?.update(tmpA);
  }
  G.ghosts = G.ghosts.filter((ghost) => !ghost.done);
  if (reached && G.state === 'playing') gameOver();
}

function updateEffects(dt) {
  G.flash = Math.max(0, G.flash - dt);
  damageFlash.visible = G.flash > 0;
  if (G.flash > 0) {
    damageFlash.position.copy(H.pos);
    damageFlash.material.opacity = G.flash;
  }
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
      audio.beepAt(H.pos.clone().addScaledVector(H[axis], amount));
    }, index * 1100);
  });
  setTimeout(() => { G.beepLabel = ''; }, steps.length * 1100);
  log(`Audio test started. Context: ${audio.state}`);
}

// ---------- Interface inside the headset ----------

function togglePanel() {
  if (!panel || G.state === 'gameover') return;   // The game over screen stays until a choice is made.
  if (panel.visible) panel.hide();
  else panel.showInFront(H.pos, H.fwd);
  G.uiTimer = 0;
}

function runButton(id) {
  G.uiTimer = 0;
  switch (id) {
    case 'start': G.pending.push(startRound); break;
    case 'place': setPlacing(!G.placing); if (G.placing) panel.hide(); break;
    case 'capture':
      G.roomCaptureUsed = true;
      log('Room setup requested');
      G.session.initiateRoomCapture().catch?.((error) => log(`Room setup failed: ${error.name}`));
      break;
    case 'audio': runAudioTest(); break;
    case 'debug':
      G.debug = !G.debug;
      room.setOutlines(G.state === 'setup' || G.debug);
      break;
    case 'depth': depth.enabled = !depth.enabled; break;
    case 'bright': G.brightnessStep = (G.brightnessStep + 1) % BRIGHTNESS_STEPS.length; break;
    case 'resume': panel.hide(); break;
    case 'exit': G.session.end(); break;
    default: break;
  }
}

function occlusionSummary() {
  if (depth.active) return depth.enabled ? 'real-time depth and room surfaces' : 'room surfaces (depth off)';
  return 'room surfaces';
}

function formatTime(seconds) {
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

function refreshInterface() {
  if (!panel) return;
  if (G.state === 'setup') {
    G.spots = H.known ? findRiftSpots(room.list, H.pos) : [];
    // Show the panel once the headset has a pose to place it by.
    if (!panel.visible && !G.placing && H.known && !panel.shownOnce) {
      panel.showInFront(H.pos, H.fwd);
      panel.shownOnce = true;
    }
  }
  if (!panel.visible) return;

  const counts = room.summary();
  const walls = counts.wall || 0;
  const roomMissing = G.sessionTime > NO_ROOM_GRACE_SECONDS && G.spots.length === 0;
  const lines = [];
  const buttons = [];
  let title = 'Ghost Hunter';

  if (G.state === 'gameover') {
    title = 'Game over';
    lines.push({ big: String(G.score) });
    lines.push(G.newBest ? `Final score. A new high score!` : `Final score. High score: ${G.best}.`);
    lines.push(`Survived ${formatTime(G.playTime)}. Killed ${G.kills.normal} normal, ${G.kills.small} small, ${G.kills.big} big.`);
    buttons.push({ id: 'start', label: 'Restart', primary: true });
    buttons.push({ id: 'exit', label: 'Exit and show report' });
    panel.setContent(title, lines, buttons);
    return;
  }

  if (G.state === 'setup') {
    lines.push(`${device}. Walls: ${walls}. Furniture: ${counts.furniture || 0}. Rift spots: ${G.spots.length}.`);
    lines.push(`Occlusion: ${occlusionSummary()}. High score: ${G.best}.`);
    if (!room.supported) lines.push('This browser did not grant room planes, so rifts will float in the air.');
    else if (roomMissing) lines.push('No room found, so rifts will float in the air. Run room setup to use your real surfaces.');
    else lines.push('Room outlines should line up with your real surfaces.');
    buttons.push({ id: 'start', label: 'Start game', primary: true });
    buttons.push({ id: 'place', label: `Place by pointing: ${G.placing ? 'on' : 'off'}` });
    if (typeof G.session.initiateRoomCapture === 'function' && roomMissing) {
      buttons.push({ id: 'capture', label: 'Run room setup', enabled: !G.roomCaptureUsed });
    }
  } else {
    title = 'Paused';
    lines.push(`Score ${G.score}. Time ${formatTime(G.playTime)}.`);
    lines.push(`Occlusion: ${occlusionSummary()}. FPS ${G.fps.toFixed(0)}.`);
    buttons.push({ id: 'resume', label: 'Resume', primary: true });
  }

  buttons.push({ id: 'audio', label: 'Audio test' });
  buttons.push({ id: 'debug', label: `Room outlines: ${G.debug ? 'on' : 'off'}` });
  buttons.push({ id: 'bright', label: `Ghost brightness: ${Math.round(BRIGHTNESS_STEPS[G.brightnessStep] * 100)}%` });
  if (depth.active) buttons.push({ id: 'depth', label: `Depth occlusion: ${depth.enabled ? 'on' : 'off'}` });
  buttons.push({ id: 'exit', label: 'Exit and show report' });

  panel.setContent(title, lines, buttons);
}

function updateToast() {
  if (!toast) return;
  let text = '';
  let warn = false;
  if (G.tracking === 'lost') {
    text = 'Tracking lost. Look at a well-lit area.';
    warn = true;
  } else if (G.beepLabel) {
    text = G.beepLabel;
  } else if (performance.now() < G.messageUntil) {
    text = G.message;
  } else if (G.placing) {
    text = 'Aim at a surface and pull the trigger. Grip opens the menu.';
  }
  toast.update(text, warn, H.pos, H.quat, H.up, H.fwd);
}

// ---------- Report ----------

function fmt(v) {
  return `${v.x.toFixed(2)}, ${v.y.toFixed(2)}, ${v.z.toFixed(2)}`;
}

function buildDiagnostics() {
  const counts = room.summary();
  const { floorY, ceilingY } = room.levels;
  const lines = [
    `--- Session report ${new Date().toISOString()} ---`,
    `Device ${device} | ${navigator.userAgent}`,
    `State ${G.state} | FPS ${G.fps.toFixed(0)}, lowest ${Number.isFinite(G.minFps) ? G.minFps.toFixed(0) : 'n/a'} | Session ${G.sessionTime.toFixed(0)} s`,
    `Tracking ${G.tracking} (lost ${G.trackingLosses}x) | Space ${G.refType}, resets ${G.refResets}`,
    `Granted ${G.session?.enabledFeatures ? [...G.session.enabledFeatures].join(', ') : 'not reported'}`,
    `Planes ${room.supported ? JSON.stringify(counts) : 'not granted'} | Labels ${room.labels().join(', ') || 'none'}`,
    `Floor ${floorY === null ? 'unknown' : `${floorY.toFixed(2)} m`} | Ceiling ${ceilingY === null ? 'unknown' : `${ceilingY.toFixed(2)} m`}`,
    `Depth occlusion ${depth.active ? `active, ${depth.enabled ? 'on' : 'off'}, near ${depth.near} far ${depth.far}` : 'not available'}`,
    `Pointers ${pointers.list.map((p) => `${p.key}${p.source?.hand ? ' hand' : ''}`).join(', ') || 'none'}`,
    `Score ${G.score}, high score ${G.best} | Round time ${G.playTime.toFixed(0)} s`,
    `Killed ${JSON.stringify(G.kills)} of ${JSON.stringify(G.spawnedByType)} | Hits ${G.stats.hits}, misses ${G.stats.misses}, trigger presses ${G.stats.selects}`,
    `Rifts opened ${G.stats.riftsOpened}, closed ${G.stats.riftsClosed}, current ${G.rifts.length}`,
    ...G.rifts.map((rift) => `  R${rift.id} ${rift.kind} ${rift.phase}, ${rift.spawned}/${rift.quota} ghosts: ${rift.anchorState}, `
      + `${rift.tracked ? 'tracked' : 'untracked'}, jump ${(rift.maxJump * 100).toFixed(1)} cm, drift ${(rift.drift * 100).toFixed(1)} cm`),
    `Audio ${audio.state}, voices ${audio.voices.size}`,
  ];
  if (window.__ghErrors.length) lines.push(`Errors: ${window.__ghErrors.join(' | ')}`);
  lines.push('Log:', ...G.log.slice(-16));
  return lines.join('\n');
}

function reportText() {
  return G.reports.join('\n\n') || buildDiagnostics();
}

function showReport() {
  $('report').textContent = reportText();
  $('report-area').hidden = false;
}

async function copyReport(button) {
  const original = button.textContent;
  try {
    await navigator.clipboard.writeText(reportText());
    button.textContent = 'Copied';
  } catch {
    getSelection().selectAllChildren($('report'));
    button.textContent = 'Selected: copy it';
  }
  setTimeout(() => { button.textContent = original; }, 2500);
}

function saveReport() {
  const url = URL.createObjectURL(new Blob([reportText()], { type: 'text/plain' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'ghost-hunter-report.txt';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// ---------- Page ----------

function bindPage() {
  $('btn-enter').addEventListener('click', enterAR);
  $('btn-probe').addEventListener('click', async () => {
    const button = $('btn-probe');
    button.disabled = true;
    button.textContent = 'Probing...';
    try {
      G.reports.push(await probeFeatures($('page')));
    } catch (error) {
      G.reports.push(`Probe failed: ${error.name}: ${error.message}`);
    }
    button.disabled = false;
    button.textContent = 'Probe features';
    showReport();
  });
  $('btn-copy').addEventListener('click', (e) => copyReport(e.currentTarget));
  $('btn-save').addEventListener('click', saveReport);
}

async function checkSupport() {
  const status = $('support-status');
  let supported = false;
  if (navigator.xr) {
    try {
      supported = await navigator.xr.isSessionSupported('immersive-ar');
    } catch (error) {
      log(`Support check failed: ${error.name}`);
    }
  }
  $('btn-enter').disabled = !supported;
  $('btn-probe').disabled = !navigator.xr;
  if (supported) {
    status.textContent = device === 'not a Quest' ? 'AR is available here.' : `Ready on ${device}.`;
  } else {
    status.textContent = 'Open this page in the Browser on a Meta Quest headset.';
  }
}

// Lets the simulator draw its fake room and tests inspect state. Not used on a headset.
window.__gh = {
  G, H, scene, audio, room, depth, pointers, THREE, findRiftSpots, pickRiftSpot, spawnGhost, pickGhostType,
  get panel() { return panel; },
  get toast() { return toast; },
  get scoreHud() { return scoreHud; },
};

bindPage();
await checkSupport();
