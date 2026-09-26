export const isDesktopPacking = typeof window !== 'undefined'
  && Boolean(window.youthnicDesktop?.packing)

export function getDesktopPacking() {
  if (!isDesktopPacking) return null
  return window.youthnicDesktop
}

export async function blobToArrayBuffer(blob) {
  if (!blob) return null
  if (blob instanceof ArrayBuffer) return blob
  if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer()
  return blob
}

// Local evidence IDs become filenames in the station's data directory, so they
// must stay filesystem-safe regardless of how the consignment ID is written.
export function createLocalEvidenceId() {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID()
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

export function createDesktopOperationId(stationId, consignmentId, boxNo) {
  return `${stationId}:${consignmentId}:${boxNo}:${createLocalEvidenceId()}`
}

// Electron wraps every main-process throw as
// "Error invoking remote method 'desktop:…': Error: <message>". Packers should
// read the reason, not the IPC plumbing.
export function describeDesktopError(error, fallback = 'Desktop action failed') {
  const raw = String(error?.message || error || '')
  const cleaned = raw.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '').trim()
  return cleaned || fallback
}
