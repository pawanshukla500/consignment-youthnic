/**
 * Shared save-box sync logic — used by Packing Station and global packingSyncService.
 * Ensures weight images, box items snapshot, and session recovery are never dropped.
 */
import { packingAPI } from '../services/api'
import { uploadFileToStorage } from '../hooks/useStorageUpload'
import { enqueueSaveBoxJob } from './packingSyncQueue'
import { getPendingScanCountForConsignment } from './scanQueue'

export function isMissingPackingSession(error) {
  const message = error?.response?.data?.error || error?.message || ''
  return error?.response?.status === 400 && /No consignment loaded|Invalid session/i.test(message)
}

export async function ensurePackingSession(consignmentId) {
  if (!consignmentId) return
  await packingAPI.load({ consignment_id: consignmentId })
}

/**
 * Process one save_box job from IndexedDB — uploads weight proof, persists box + items.
 */
export async function processSaveBoxJob(job) {
  if (job.type !== 'save_box') return null

  const pendingScans = await getPendingScanCountForConsignment(job.consignmentId)
  if (pendingScans > 0) {
    const defer = new Error('PENDING_SCANS')
    defer.code = 'PENDING_SCANS'
    throw defer
  }

  let uploadedImageId = job.weightImageId || null

  if (job.weightImageBlob && !uploadedImageId) {
    const file = new File([job.weightImageBlob], `weight_box_${job.boxNo}.jpg`, { type: 'image/jpeg' })
    const uploadRes = await uploadFileToStorage(file, job.consignmentId, 'weight_image', job.boxNo)
    if (uploadRes?.id) {
      uploadedImageId = uploadRes.id
      await enqueueSaveBoxJob({ ...job, weightImageId: uploadedImageId })
    }
  }

  const payload = {
    consignment_id: job.consignmentId,
    box_no: job.boxNo,
    weight: job.weight,
    weight_unit: job.weightUnit,
    weight_image_id: uploadedImageId,
  }
  if (Array.isArray(job.items) && job.items.length) {
    payload.items = job.items
  }

  try {
    await packingAPI.saveBox(payload)
  } catch (error) {
    if (!isMissingPackingSession(error)) throw error
    await ensurePackingSession(job.consignmentId)
    await packingAPI.saveBox(payload)
  }

  await packingAPI.generateLabel({ consignment_id: job.consignmentId, box_no: job.boxNo })
  return { ok: true }
}
