const SAFE_EXT = /\.(webm|mp4|mov|avi|png|jpe?g|webp|gif|pdf|xlsx?|docx?|csv|txt)$/i

function sanitizeConsignmentId(consignmentId) {
  return String(consignmentId || '').replace(/[^\w.-]/g, '_')
}

export function buildStoragePath(consignmentId, type, fileName, boxNo, options = {}) {
  const safeCid = sanitizeConsignmentId(consignmentId)
  const match = (fileName || '').match(/\.[a-z0-9]+$/i)
  const isVideo = type === 'video' || type === 'removal_video'
  const ext = match && SAFE_EXT.test(match[0]) ? match[0].toLowerCase() : (isVideo ? '.webm' : '')
  if (type === 'removal_video') {
    if (!boxNo) throw new Error('Box number is required for removal video uploads')
    const box = String(boxNo).replace(/[^\w.-]/g, '_')
    const adj = String(options.adjustmentId || Date.now()).replace(/[^\w.-]/g, '_')
    return `consignments/${safeCid}/boxes/box_${box}/removals/${adj}${ext}`
  }
  if (type === 'video') {
    if (!boxNo) throw new Error('Box number is required for video uploads')
    const box = String(boxNo).replace(/[^\w.-]/g, '_')
    // Unique key per recording so re-uploads never share a Chrome-cached identity.
    const rev = String(options.revision || options.clientUploadId || Date.now()).replace(/[^\w.-]/g, '_')
    return `consignments/${safeCid}/boxes/box_${box}/video_${rev}${ext}`
  }
  const safe = (fileName || 'file').replace(/[^\w.\-() ]/g, '_')
  return `consignments/${safeCid}/documents/${Date.now()}_${safe}`
}
