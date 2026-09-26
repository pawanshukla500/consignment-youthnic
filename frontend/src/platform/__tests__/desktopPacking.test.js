import { describe, it, expect } from 'vitest'
import { describeDesktopError, createLocalEvidenceId } from '../desktopPacking'

describe('describeDesktopError', () => {
  it('strips the Electron IPC wrapper so a packer sees the actual reason', () => {
    const raw = new Error("Error invoking remote method 'desktop:packing-open-box': Error: Resume and close Box 5 first")
    expect(describeDesktopError(raw)).toBe('Resume and close Box 5 first')
  })

  it('strips the wrapper even when the inner Error prefix is missing', () => {
    const raw = new Error("Error invoking remote method 'desktop:sync-retry': Sign in to use this station")
    expect(describeDesktopError(raw)).toBe('Sign in to use this station')
  })

  it('leaves ordinary error messages untouched', () => {
    expect(describeDesktopError(new Error('Box changed while saving. Wait for scans to settle and retry.')))
      .toBe('Box changed while saving. Wait for scans to settle and retry.')
  })

  it('falls back when the message is empty after cleaning', () => {
    expect(describeDesktopError(new Error("Error invoking remote method 'desktop:packing-open-box': Error:"), 'Could not open the local box'))
      .toBe('Could not open the local box')
    expect(describeDesktopError(null, 'Scan could not be saved locally')).toBe('Scan could not be saved locally')
    expect(describeDesktopError(undefined)).toBe('Desktop action failed')
  })
})

describe('createLocalEvidenceId', () => {
  it('produces filesystem-safe unique IDs for any consignment naming', () => {
    const a = createLocalEvidenceId()
    const b = createLocalEvidenceId()
    expect(a).not.toBe(b)
    expect(a).toMatch(/^[\w.-]+$/)
  })
})
