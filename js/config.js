// Game balance. Times are in seconds, distances in meters.
window.GH_CONFIG = {
  startingRifts: 2,

  // Each rift lets out a random number of ghosts, then closes.
  ghostsPerRiftMin: 2,
  ghostsPerRiftMax: 5,

  // How often a new rift tries to open.
  riftOpenIntervalMin: 6,
  riftOpenIntervalMax: 14,

  // The game gets harder until this many seconds in, moving each [start, end] pair along the way.
  rampSeconds: 180,
  maxRifts: [3, 5],          // Rifts open at once.
  spawnInterval: [5, 2],     // Seconds between ghosts.
  maxGhosts: [3, 6],         // Ghosts alive at once.

  // Each harder type joins at its "from" time at a 10% share, growing to maxShare over mixRampSeconds.
  mixRampSeconds: 120,
  smallGhostsFrom: 30,
  smallGhostsMaxShare: 0.35,
  bigGhostsFrom: 60,
  bigGhostsMaxShare: 0.25,

  // hits: shots to kill. scale: 0.4 is about 31 cm tall. hitRadius: how forgiving aiming is.
  // voice: the pitch of its sound in Hz, so each type can be told apart by ear.
  ghostTypes: {
    normal: { hits: 2, speed: 0.35, scale: 0.4, color: 0xbfe8ff, points: 100, hitRadius: 0.14, voice: 180 },
    small: { hits: 1, speed: 0.6, scale: 0.26, color: 0xb8ff7a, points: 150, hitRadius: 0.11, voice: 300 },
    big: { hits: 5, speed: 0.25, scale: 0.62, color: 0xff8a70, points: 300, hitRadius: 0.24, voice: 95 },
  },
};
