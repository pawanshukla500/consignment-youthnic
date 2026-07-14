/** Resolve public/play URL from a file record (prefers fresh signed URL from API). */
export function getFileUrl(file) {
  if (!file) return null
  return file.playUrl || file.url || file.storageUrl || file.firebaseUrl || null
}

export function getFilePath(file) {
  if (!file) return null
  return file.storagePath || file.firebasePath || file.path || null
}
