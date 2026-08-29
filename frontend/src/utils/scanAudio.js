/**
 * Shared AudioContext for scanner sounds.
 * Solves the Safari/iOS issue where AudioContext must be initialized 
 * during a direct user gesture to be unlocked.
 */
class SharedAudioContext {
  constructor() {
    this.ctx = null;
    this.unlocked = false;
  }

  /**
   * Must be called during a direct user interaction (e.g., click or keypress)
   * to unlock the audio context in strict browsers like Safari.
   */
  init() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (this.ctx.state === 'suspended') {
      void this.ctx.resume();
    }
    this.unlocked = true;
  }

  async beep(freq, type, dur, vol, sd, fe) {
    if (!this.ctx) this.init();
    
    const a = this.ctx;
    
    // Safely resume before playing to fix Safari restriction issues
    if (a.state === 'suspended') {
      try {
        await a.resume();
      } catch (err) {
        console.warn('[Audio] Failed to resume context:', err);
        return; // Skip playing sound if context cannot be resumed
      }
    }
    
    const o = a.createOscillator();
    const g = a.createGain();
    
    o.connect(g);
    g.connect(a.destination);
    
    const t = Math.max(a.currentTime, a.currentTime + sd);
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    
    if (fe !== undefined) {
      o.frequency.exponentialRampToValueAtTime(fe, t + dur);
    }
    
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    
    try {
      o.start(t);
      o.stop(t + dur);
    } catch (err) {
      console.warn('[Audio] Failed to start oscillator:', err);
    }
  }
}

export const scanAudio = new SharedAudioContext();

export const sfx = {
  cid: () => { scanAudio.beep(660, 'sine', 0.12, 0.42, 0); scanAudio.beep(990, 'sine', 0.16, 0.38, 0.12); },
  box: () => { scanAudio.beep(440, 'triangle', 0.1, 0.48, 0, 500); },
  ok: () => { scanAudio.beep(920, 'sine', 0.045, 0.48, 0); scanAudio.beep(1380, 'sine', 0.065, 0.42, 0.05); },
  warn: () => { scanAudio.beep(420, 'square', 0.055, 0.52, 0); scanAudio.beep(420, 'square', 0.055, 0.52, 0.075); scanAudio.beep(300, 'sawtooth', 0.1, 0.48, 0.15); },
  err: () => { scanAudio.beep(220, 'sawtooth', 0.07, 0.58, 0); scanAudio.beep(160, 'sawtooth', 0.09, 0.52, 0.085); },
  init: () => { scanAudio.init(); }
};
