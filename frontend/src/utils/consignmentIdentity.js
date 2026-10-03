export function displayConsignmentNo(consignment) {
  return String(consignment?.consignmentNo || consignment?.id || '').trim()
}

export function displayInternalShipmentNo(consignment) {
  return String(consignment?.internalShipmentNo || '').trim()
}
