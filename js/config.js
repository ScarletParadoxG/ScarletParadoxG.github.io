// Game balance. Times are in seconds, distances in meters.
export const CONFIG = {
  startingRifts: 2,

  // Each rift lets out a random number of ghosts, then closes.
  ghostsPerRiftMin: 2,
  ghostsPerRiftMax: 5,

  // The game gets harder until this many seconds in, moving each [start, end] pair along the way.
  rampSeconds: 120,
  maxRifts: [3, 8],              // Rifts open at once.
  riftOpenIntervalMin: [5, 2],   // A new rift opens after a random wait between these two.
  riftOpenIntervalMax: [10, 4],
  spawnInterval: [4.5, 1.5],     // Seconds between ghosts.
  maxGhosts: [3, 7],             // Ghosts alive at once.

  // Each harder type joins at its "from" time at a 10% share, growing to maxShare over mixRampSeconds.
  mixRampSeconds: 90,
  smallGhostsFrom: 25,
  smallGhostsMaxShare: 0.35,
  bigGhostsFrom: 50,
  bigGhostsMaxShare: 0.25,

  // hits: shots to kill. scale: 0.4 is about 31 cm tall. hitRadius: how forgiving aiming is.
  // voice: the pitch of its sound in Hz, so each type can be told apart by ear.
  ghostTypes: {
    normal: { hits: 2, speed: 0.35, scale: 0.4, points: 100, hitRadius: 0.14, voice: 180 },
    small: { hits: 1, speed: 0.6, scale: 0.3, points: 150, hitRadius: 0.11, voice: 300 },
    big: { hits: 5, speed: 0.25, scale: 0.62, points: 300, hitRadius: 0.24, voice: 95 },
  },
};
