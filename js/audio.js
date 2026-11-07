// Directional ghost audio using Web Audio HRTF panning. Speakers alone give weak direction cues,
// so pitch rises with height and sounds behind the player are muffled.

function setParam(param, value, ctx, smoothing = 0.05) {
  param.setTargetAtTime(value, ctx.currentTime, smoothing);
}

export class SpatialAudio {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.voices = new Set();
    this.listenerPos = null;
    this.listenerFwd = null;
  }

  // Call directly from a tap. iOS only starts audio during a user gesture.
  unlock() {
    if (!this.ctx) {
      const Context = window.AudioContext || window.webkitAudioContext;
      if (!Context) return;
      // Ask iOS to keep playing when the silent switch is on, where supported.
      try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch { /* optional */ }
      this.ctx = new Context();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.9;
      this.master.connect(this.ctx.destination);
    }
    this.resume();
    // A silent one-sample buffer finishes unlocking on older iOS versions.
    const source = this.ctx.createBufferSource();
    source.buffer = this.ctx.createBuffer(1, 1, this.ctx.sampleRate);
    source.connect(this.ctx.destination);
    source.start();
  }

  resume() {
    if (this.ctx && this.ctx.state !== 'running') this.ctx.resume().catch(() => {});
  }

  get state() {
    return this.ctx ? this.ctx.state : 'not started';
  }

  setListener(pos, fwd, up) {
    this.listenerPos = pos;
    this.listenerFwd = fwd;
    if (!this.ctx) return;
    const l = this.ctx.listener;
    if (l.positionX) {
      l.positionX.value = pos.x; l.positionY.value = pos.y; l.positionZ.value = pos.z;
      l.forwardX.value = fwd.x; l.forwardY.value = fwd.y; l.forwardZ.value = fwd.z;
      l.upX.value = up.x; l.upY.value = up.y; l.upZ.value = up.z;
    } else {
      l.setPosition(pos.x, pos.y, pos.z);
      l.setOrientation(fwd.x, fwd.y, fwd.z, up.x, up.y, up.z);
    }
  }

  makePanner() {
    const panner = this.ctx.createPanner();
    panner.panningModel = 'HRTF';
    panner.distanceModel = 'inverse';
    panner.refDistance = 0.8;
    panner.rolloffFactor = 1.2;
    panner.connect(this.master);
    return panner;
  }

  static placePanner(panner, p) {
    if (panner.positionX) {
      panner.positionX.value = p.x; panner.positionY.value = p.y; panner.positionZ.value = p.z;
    } else {
      panner.setPosition(p.x, p.y, p.z);
    }
  }

  // A wavering moan. Sawtooth keeps the high frequencies the ear uses to locate sound.
  createVoice() {
    if (!this.ctx) return null;
    const { ctx } = this;
    const panner = this.makePanner();
    const gain = ctx.createGain();
    gain.gain.value = 0;
    gain.gain.setTargetAtTime(0.32, ctx.currentTime, 0.4);
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 2400;
    gain.connect(filter);
    filter.connect(panner);

    const base = 150 + Math.random() * 60;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 3 + Math.random() * 3;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 14;
    lfo.connect(lfoGain);

    const oscillators = [0, 7].map((detune) => {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = base;
      osc.detune.value = detune;
      lfoGain.connect(osc.frequency);
      osc.connect(gain);
      osc.start();
      return osc;
    });
    lfo.start();

    const voice = {
      update: (position) => {
        SpatialAudio.placePanner(panner, position);
        if (!this.listenerPos) return;
        const height = Math.max(-1.5, Math.min(1.5, position.y - this.listenerPos.y));
        oscillators.forEach((osc) => setParam(osc.frequency, base * 2 ** height, ctx));
        const dx = position.x - this.listenerPos.x;
        const dy = position.y - this.listenerPos.y;
        const dz = position.z - this.listenerPos.z;
        const facing = dx * this.listenerFwd.x + dy * this.listenerFwd.y + dz * this.listenerFwd.z;
        setParam(filter.frequency, facing < 0 ? 750 : 2400, ctx, 0.1);
      },
      stop: () => {
        if (!this.voices.delete(voice)) return;
        gain.gain.setTargetAtTime(0, ctx.currentTime, 0.05);
        const end = ctx.currentTime + 0.3;
        oscillators.forEach((osc) => osc.stop(end));
        lfo.stop(end);
        setTimeout(() => panner.disconnect(), 500);
      },
    };
    this.voices.add(voice);
    return voice;
  }

  // A short positioned burst for the direction test.
  beepAt(position) {
    if (!this.ctx) return;
    const { ctx } = this;
    const panner = this.makePanner();
    SpatialAudio.placePanner(panner, position);
    const gain = ctx.createGain();
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = 330;
    const t = ctx.currentTime;
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(0.5, t + 0.02);
    gain.gain.setValueAtTime(0.5, t + 0.45);
    gain.gain.linearRampToValueAtTime(0, t + 0.5);
    osc.connect(gain);
    gain.connect(panner);
    osc.start(t);
    osc.stop(t + 0.52);
    setTimeout(() => panner.disconnect(), 800);
  }

  // Non-directional feedback for hits and misses.
  blip(frequency, duration, type = 'square', level = 0.15) {
    if (!this.ctx) return;
    const { ctx } = this;
    const gain = ctx.createGain();
    const osc = ctx.createOscillator();
    osc.type = type;
    const t = ctx.currentTime;
    osc.frequency.setValueAtTime(frequency, t);
    osc.frequency.exponentialRampToValueAtTime(frequency * 0.4, t + duration);
    gain.gain.setValueAtTime(level, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + duration);
    osc.connect(gain);
    gain.connect(this.master);
    osc.start(t);
    osc.stop(t + duration);
  }

  stopAll() {
    [...this.voices].forEach((voice) => voice.stop());
  }
}
