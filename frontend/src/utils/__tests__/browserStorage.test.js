import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  estimateBrowserStorage,
  isStorageInsufficient,
  requestPersistentStorage,
  formatStorageMessage,
} from '../browserStorage'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('browserStorage', () => {
  it('requests persistent storage when supported', async () => {
    vi.stubGlobal('navigator', {
      storage: {
        persisted: vi.fn(async () => false),
        persist: vi.fn(async () => true),
      },
    })
    await expect(requestPersistentStorage()).resolves.toEqual({
      supported: true,
      persisted: true,
    })
  })

  it('estimates free space and warns when insufficient', async () => {
    vi.stubGlobal('navigator', {
      storage: {
        estimate: vi.fn(async () => ({
          usage: 900 * 1024 * 1024,
          quota: 1000 * 1024 * 1024,
        })),
      },
    })
    const estimate = await estimateBrowserStorage()
    expect(estimate.freeMb).toBeCloseTo(100, 0)
    expect(isStorageInsufficient(estimate, 200)).toBe(true)
    expect(formatStorageMessage(estimate)).toMatch(/free/)
  })
})
