/** Marketplace consignment number shown in the list. Repeatable across shipments. */
export function displayConsignmentNo(consignment) {
  const explicit = String(consignment?.consignmentNo || '').trim()
  if (explicit) return explicit
  if (consignment?.pendingExternalId) return ''
  return String(consignment?.id || '').trim()
}
