import { useState } from 'react'
import api from '../services/api'
import { uploadFileToStorageDirect } from '../utils/r2StorageUpload'
import { buildStoragePath } from '../utils/storagePaths'

export { buildStoragePath }

/** Upload a file — direct to Cloudflare R2 to avoid server payload limits. */
export async function uploadFileToStorage(file, consignmentId, type = 'document', boxNo = '', onProgress, options = {}) {
  if (!file || !consignmentId) return null
  if ((type === 'video' || type === 'removal_video') && !boxNo) {
    throw new Error('Box number is required for video uploads')
  }

  const direct = await uploadFileToStorageDirect(file, consignmentId, type, boxNo, onProgress, options)
  const response = await api.post('/uploads/metadata', {
    consignmentId,
    type,
    originalName: file.name,
    storageUrl: direct.url,
    storagePath: direct.path,
    size: file.size,
    mimeType: file.type,
    boxNo: boxNo ? String(boxNo) : '',
    description: options.description
      || (type === 'removal_video'
        ? `Box ${boxNo} quantity removal video`
        : (type === 'video' ? `Box ${boxNo} packing video` : undefined)),
    adjustmentId: options.adjustmentId || undefined,
    purpose: options.purpose || (type === 'removal_video' ? 'quantity_removal' : undefined),
    clientUploadId: options.clientUploadId || undefined,
  })

  const fileRecord = response.data?.file
  return {
    id: fileRecord?.id,
    url: fileRecord?.playUrl || fileRecord?.url || direct.url,
    path: direct.path,
    name: file.name,
    size: file.size,
    type: file.type,
    boxNo: boxNo ? String(boxNo) : '',
  }
}

/** Upload files directly to Cloudflare R2. */
export function useStorageUpload() {
  const [progress, setProgress] = useState(0)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState(null)

  const uploadFile = async (file, consignmentId, type = 'document', boxNo = '', options = {}) => {
    setUploading(true)
    setError(null)
    setProgress(0)
    try {
      return await uploadFileToStorage(file, consignmentId, type, boxNo, setProgress, options)
    } catch (err) {
      setError(err)
      throw err
    } finally {
      setUploading(false)
    }
  }

  return { uploadFile, upload: uploadFile, progress, uploading, error }
}

/** @deprecated Use useStorageUpload */
export const useFirebaseUpload = useStorageUpload
