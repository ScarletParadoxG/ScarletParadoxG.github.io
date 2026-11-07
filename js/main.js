import * as THREE from './three.js';
import { CONFIG } from './config.js';
import { RoomModel, findRiftSpots, pickRiftSpot } from './room.js';
import { createRift, anchorRift, updateRift, closeRift, destroyRift, HOLE_RADIUS } from './rift.js';
import { Ghost } from './ghost.js';
import { SpatialAudio } from './audio.js';
import { DepthOcclusion } from './depth.js';
import { Pointers } from './input.js';
import { Panel, Toast, ScoreHud } from './ui.js';

const $ = (id) => document.getElementById(id);

const NO_ROOM_GRACE_SECONDS = 3;   // Room planes can take 2 to 3 seconds to appear.
const BEST_SCORE_KEY = 'ghostHunter.bestScore';
const emptyKills = () => ({ normal: 0, small: 0, big: 0 });

const G = {
  state: 'idle',            // idle -> title -> playing -> gameover -> playing ...
  session: null,
  refType: 'local',
  rifts: [],
  ghosts: [],
  spotCount: 0,
  pending: [],
  sessionTime: 0,
  roomCaptureUsed: false,
  titleShown: false,
  playTime: 0,
  spawnTimer: 0,
  riftTimer: 0,
  score: 0,
  best: loadBest(),
  newBest: false,
  kills: emptyKills(),
  uiTimer: 0,
  lastTime: 0,
  tracked: true,
  voicesMuted: false,
  message: '',
  messageUntil: 0,
  flash: 0,
};

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
};

const tmpA = new THREE.Vector3();
const tmpB = new THREE.Vector3();

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
  return start + (end - start) * Math.min(1, G.playTime / CONFIG.rampSeconds);
}

// ---------- Things drawn in the world ----------

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
  // The stencil buffer keeps rift tunnels inside their openings.
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, stencil: true });
  renderer.localClippingEnabled = true;
  renderer.xr.enabled = true;
}

async function enterAR() {
  audio.unlock();
  try {
    const session = await navigator.xr.requestSession('immersive-ar', {
      optionalFeatures: ['local-floor', 'plane-detection', 'anchors', 'depth-sensing', 'hand-tracking'],
      // GPU only: this is the form three.js reads. Quest 2 simply won't grant the feature.
      depthSensing: { usagePreference: ['gpu-optimized'], dataFormatPreference: [] },
    });
    await startSession(session);
  } catch (error) {
    $('status').textContent = `Couldn't start the game: ${error.message}`;
  }
}

async function startSession(session) {
  ensureRenderer();
  G.session = session;
  G.sessionTime = 0;
  G.lastTime = 0;
  G.roomCaptureUsed = false;
  G.titleShown = false;

  session.addEventListener('end', onSessionEnd);
  session.addEventListener('select', (event) => {
    G.pending.push(() => handleSelect(event.inputSource));
  });
  session.addEventListener('squeeze', togglePanel);
  session.addEventListener('visibilitychange', () => {
    audio.setMuted(session.visibilityState !== 'visible');
  });

  // local-floor puts the real floor at y = 0.
  G.refType = await session.requestReferenceSpace('local-floor').then(() => 'local-floor', () => 'local');
  renderer.xr.setReferenceSpaceType(G.refType);
  await renderer.xr.setSession(session);

  panel = new Panel(scene);
  toast = new Toast(scene);
  scoreHud = new ScoreHud(scene);
  G.state = 'title';
  G.uiTimer = 0;
  renderer.setAnimationLoop(onFrame);
}

function onSessionEnd() {
  saveBest();
  renderer.setAnimationLoop(null);
  clearRound();
  room.clear();
  depth.reset();
  pointers.dispose();
  panel?.dispose(scene);
  toast?.dispose(scene);
  scoreHud?.dispose(scene);
  panel = null;
  toast = null;
  scoreHud = null;
  G.pending = [];
  G.session = null;
  G.score = 0;
  H.known = false;
  syncVoiceMute(false);
  gazeCursor.visible = false;
  damageFlash.visible = false;
  G.state = 'idle';
  showBestOnPage();
}

// ---------- Frame loop ----------

function onFrame(time, frame) {
  const elapsed = G.lastTime ? Math.max(0, (time - G.lastTime) / 1000) : 0;
  const dt = Math.min(elapsed, 0.1);   // Game movement stays small after a long stall.
  G.lastTime = time;
  if (!frame) return;
  G.sessionTime += elapsed;

  const refSpace = renderer.xr.getReferenceSpace();
  const pose = frame.getViewerPose(refSpace);
  G.tracked = !!pose && !pose.emulatedPosition;

  if (pose) {
    H.known = true;
    // pose.transform is the point between the eyes, not one eye's view.
    H.matrix.fromArray(pose.transform.matrix);
    H.matrix.decompose(H.pos, H.quat, H.scale);
    H.fwd.set(0, 0, -1).applyQuaternion(H.quat);
    H.up.set(0, 1, 0).applyQuaternion(H.quat);
    audio.setListener(H.pos, H.fwd, H.up);
  }

  room.update(frame, refSpace, H.pos.y);
  pointers.update(frame, refSpace, G.session, dt);

  const actions = G.pending;
  G.pending = [];
  actions.forEach((action) => action(frame, refSpace));

  // Tracking loss, the system menu and the in-game menu all stop the game.
  const paused = G.state === 'playing' && !!panel?.visible;
  const active = G.tracked && G.session?.visibilityState === 'visible' && !paused;
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
    refreshPanel();
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

// ---------- Aiming ----------

// The ray used by a pointer, or by the head if nothing is being tracked.
function rayFor(pointer) {
  return pointer ? { origin: pointer.origin, direction: pointer.direction } : { origin: H.pos, direction: H.fwd };
}

function updateAim() {
  let hovered = null;
  for (const pointer of pointers.list) {
    const onPanel = panel?.hit(pointer.origin, pointer.direction);
    let length = room.raycast(pointer.origin, pointer.direction) ?? 4;
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
    if (onPanel.button) {
      pointers.pulse(pointer, 0.3, 30);
      runButton(onPanel.button.id);
    }
    return;
  }

  if (G.state === 'playing' && !panel?.visible) {
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
    audio.blip(180, 0.08, 'square', 0.06);
    pointers.pulse(pointer, 0.2, 20);
    return;
  }

  if (best.hit(direction)) {
    G.score += best.type.points;
    G.kills[best.typeName]++;
    audio.blip(880, 0.25);
    pointers.pulse(pointer, 0.9, 90);
  } else {
    audio.blip(520, 0.1, 'square', 0.12);
    pointers.pulse(pointer, 0.5, 40);
  }
}

// ---------- Rifts ----------

function addRift(frame, refSpace, position, normal, site) {
  const rift = createRift(position, normal, !!site);
  rift.quota = Math.round(randomBetween(CONFIG.ghostsPerRiftMin, CONFIG.ghostsPerRiftMax));
  if (site) rift.site = { surface: site.surface, hole: room.addHole(site.surface, site.x, site.z, HOLE_RADIUS) };
  scene.add(rift.group);
  anchorRift(rift, frame, refSpace);
  G.rifts.push(rift);
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
  if (!spot && desperate) spot = pickRiftSpot(spots, H.pos, taken, { minSpacing: 0.5 });

  if (spot) {
    return addRift(frame, refSpace, spot.pos, spot.normal, { surface: spot.surface, x: spot.local.x, z: spot.local.z });
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
  return addRift(frame, refSpace, position, direction.negate(), null);
}

function updateRifts(frame, refSpace, dt) {
  for (const rift of G.rifts) {
    updateRift(rift, frame, refSpace, dt);
    if (rift.phase === 'closed' && rift.site) {
      room.removeHole(rift.site.surface, rift.site.hole);
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

function nextRiftDelay() {
  return randomBetween(ramp(CONFIG.riftOpenIntervalMin), ramp(CONFIG.riftOpenIntervalMax));
}

// Decides what happens next: which rifts close, when new ones open, and which ghosts come out.
function updateDirector(frame, refSpace, dt) {
  G.playTime += dt;

  for (const rift of G.rifts) {
    if (!isOpen(rift) || rift.spawned < rift.quota) continue;
    const stillEmerging = G.ghosts.some((ghost) => ghost.rift === rift && ghost.alive && ghost.phase === 'emerge');
    if (!stillEmerging) closeRift(rift);
  }

  const openRifts = G.rifts.filter(isOpen);
  G.riftTimer -= dt;
  if (openRifts.length === 0 || (G.riftTimer <= 0 && openRifts.length < Math.round(ramp(CONFIG.maxRifts)))) {
    openRandomRift(frame, refSpace, { desperate: openRifts.length === 0 });
    G.riftTimer = nextRiftDelay();
  }

  G.spawnTimer -= dt;
  if (G.spawnTimer > 0) return;
  const alive = G.ghosts.filter((ghost) => ghost.alive).length;
  const ready = G.rifts.filter((rift) => rift.phase === 'open' && rift.spawned < rift.quota);
  if (alive >= Math.round(ramp(CONFIG.maxGhosts)) || !ready.length) return;
  spawnGhost(pickGhostType(), ready[Math.floor(Math.random() * ready.length)]);
  G.spawnTimer = ramp(CONFIG.spawnInterval);
}

// ---------- A round ----------

// Removes everything from the current round.
function clearRound() {
  audio.stopAll();
  G.ghosts.forEach((ghost) => ghost.remove());
  G.ghosts = [];
  G.rifts.forEach((rift) => {
    if (rift.site) room.removeHole(rift.site.surface, rift.site.hole);
    destroyRift(rift, scene);
  });
  G.rifts = [];
}

function startRound(frame, refSpace) {
  saveBest();
  clearRound();
  G.score = 0;
  G.newBest = false;
  G.kills = emptyKills();
  G.playTime = 0;
  G.spawnTimer = 1.5;
  G.riftTimer = nextRiftDelay();

  for (let i = 0; i < CONFIG.startingRifts; i++) {
    if (!openRandomRift(frame, refSpace, { desperate: true })) break;
  }
  panel?.hide();
  G.state = 'playing';
  say('Pull the trigger to shoot. Grip pauses the game.', 4);
}

function gameOver() {
  saveBest();
  clearRound();
  audio.blip(90, 0.5, 'sawtooth', 0.3);
  pointers.list.forEach((pointer) => pointers.pulse(pointer, 1, 200));
  G.flash = 0.45;
  G.messageUntil = 0;
  G.state = 'gameover';
  G.uiTimer = 0;
  panel?.showInFront(H.pos, H.fwd);
}

// ---------- Ghosts ----------

function pickGhostType() {
  const share = (from, maxShare) => {
    if (G.playTime < from) return 0;
    return 0.1 + (maxShare - 0.1) * Math.min(1, (G.playTime - from) / CONFIG.mixRampSeconds);
  };
  const big = share(CONFIG.bigGhostsFrom, CONFIG.bigGhostsMaxShare);
  const small = share(CONFIG.smallGhostsFrom, CONFIG.smallGhostsMaxShare);
  const roll = Math.random();
  if (roll < big) return 'big';
  if (roll < big + small) return 'small';
  return 'normal';
}

function spawnGhost(typeName, rift) {
  const type = CONFIG.ghostTypes[typeName];
  const ghost = new Ghost(rift, scene, audio.createVoice(type.voice), typeName, type);
  G.ghosts.push(ghost);
  rift.spawned++;
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

// ---------- Interface inside the headset ----------

// Grip pauses during play. Otherwise it brings the menu back in front of the player.
function togglePanel() {
  if (!panel) return;
  if (G.state === 'playing' && panel.visible) panel.hide();
  else panel.showInFront(H.pos, H.fwd);
  G.uiTimer = 0;
}

function runButton(id) {
  G.uiTimer = 0;
  switch (id) {
    case 'start': G.pending.push(startRound); break;
    case 'resume': panel.hide(); break;
    case 'capture':
      G.roomCaptureUsed = true;
      G.session.initiateRoomCapture().catch?.(() => {});
      break;
    case 'exit': G.session.end(); break;
    default: break;
  }
}

function formatTime(seconds) {
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

function refreshPanel() {
  if (!panel) return;

  if (G.state === 'title') {
    if (!H.known) return;
    G.spotCount = findRiftSpots(room.list, H.pos).length;
    if (!G.titleShown) {
      panel.showInFront(H.pos, H.fwd);
      G.titleShown = true;
    }
    const noRoom = G.sessionTime > NO_ROOM_GRACE_SECONDS && G.spotCount === 0;
    const lines = [`High score: ${G.best}`];
    const buttons = [{ id: 'start', label: 'Start game', primary: true }];
    if (noRoom) {
      lines.push('No room scan found, so rifts will float in the air. Set up your room to use your real walls and furniture.');
      if (typeof G.session.initiateRoomCapture === 'function' && !G.roomCaptureUsed) {
        buttons.push({ id: 'capture', label: 'Set up room' });
      }
    } else {
      lines.push('Listen for ghosts and shoot them before they reach you. One touch ends the game.');
    }
    buttons.push({ id: 'exit', label: 'Exit' });
    panel.setContent('Ghost Hunter', lines, buttons);
  } else if (G.state === 'gameover') {
    panel.setContent('Game over', [
      { big: String(G.score) },
      G.newBest ? 'A new high score!' : `High score: ${G.best}`,
      `Survived ${formatTime(G.playTime)}. Defeated ${G.kills.normal} ghosts, ${G.kills.small} wisps and ${G.kills.big} brutes.`,
    ], [
      { id: 'start', label: 'Play again', primary: true },
      { id: 'exit', label: 'Exit' },
    ]);
  } else if (panel.visible) {
    panel.setContent('Paused', [`Score: ${G.score}`, `Time: ${formatTime(G.playTime)}`], [
      { id: 'resume', label: 'Resume', primary: true },
      { id: 'start', label: 'Restart' },
      { id: 'exit', label: 'Exit' },
    ]);
  }
}

function updateToast() {
  if (!toast) return;
  let text = '';
  let warn = false;
  if (!G.tracked) {
    text = 'Tracking lost. Look at a well-lit area.';
    warn = true;
  } else if (performance.now() < G.messageUntil) {
    text = G.message;
  }
  toast.update(text, warn, H.pos, H.quat, H.up, H.fwd);
}

// ---------- Page ----------

function showBestOnPage() {
  $('best').textContent = G.best ? `High score: ${G.best}` : '';
}

async function checkSupport() {
  let supported = false;
  if (navigator.xr) {
    try {
      supported = await navigator.xr.isSessionSupported('immersive-ar');
    } catch { /* Treated as unsupported. */ }
  }
  $('btn-play').disabled = !supported;
  $('status').textContent = supported ? '' : 'Open this page in the Browser on a Meta Quest headset to play.';
}

$('btn-play').addEventListener('click', enterAR);
showBestOnPage();
checkSupport();
