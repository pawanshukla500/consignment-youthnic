import { describe, it, expect, vi, beforeEach } from 'vitest';
import { scanAudio, sfx } from '../scanAudio';

describe('scanAudio', () => {
  beforeEach(() => {
    globalThis.window = {};
  });

  it('initializes context on first init call', () => {
    const mockResume = vi.fn();
    const mockContext = vi.fn(() => ({
      state: 'suspended',
      resume: mockResume,
    }));
    globalThis.window.AudioContext = mockContext;
    
    expect(scanAudio.ctx).toBeNull();
    scanAudio.init();
    expect(scanAudio.ctx).not.toBeNull();
    expect(mockResume).toHaveBeenCalled();
  });

  it('exposes expected sfx keys', () => {
    expect(typeof sfx.ok).toBe('function');
    expect(typeof sfx.err).toBe('function');
    expect(typeof sfx.warn).toBe('function');
    expect(typeof sfx.box).toBe('function');
    expect(typeof sfx.cid).toBe('function');
    expect(typeof sfx.init).toBe('function');
  });
});
