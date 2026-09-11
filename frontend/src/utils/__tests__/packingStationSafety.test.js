import { describe, expect, it } from 'vitest'
import {
  STOP_RECORDING_TIMEOUT_MS,
  boxCloseAlreadyInProgressMessage,
  boxSaveCancelledMessage,
  withTimeout,
} from '../packingStationSafety'

describe('packing station safety', () => {
  it('resolves when the work finishes in time', async () => {
    await expect(withTimeout(Promise.resolve('ok'), 50, 'too slow')).resolves.toBe('ok')
  })

  it('rejects hung recorder stops so SAVE/NEXT can recover', async () => {
    await expect(withTimeout(new Promise(() => {}), 20, 'Video recorder did not stop')).rejects.toMatchObject({
      code: 'TIMEOUT',
      message: 'Video recorder did not stop',
    })
  })

  it('ignores a late resolve after timeout so loading cannot flip twice', async () => {
    let settle
    const hung = new Promise((resolve) => { settle = resolve })
    await expect(withTimeout(hung, 15, 'too slow')).rejects.toMatchObject({ code: 'TIMEOUT' })
    settle('late')
    await new Promise((r) => setTimeout(r, 10))
  })

  it('keeps operator copy plain', () => {
    expect(STOP_RECORDING_TIMEOUT_MS).toBeGreaterThanOrEqual(10000)
    expect(boxCloseAlreadyInProgressMessage()).toMatch(/already saving/i)
    expect(boxSaveCancelledMessage()).toMatch(/not saved/i)
  })
})
