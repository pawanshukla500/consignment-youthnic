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

export function createDesktopOperationId(stationId, consignmentId, boxNo) {
  const uuid = typeof globalThis.crypto?.randomUUID === 'function' ? globalThis.crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`
  return `${stationId}:${consignmentId}:${boxNo}:${uuid}`
}
