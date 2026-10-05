export function toEventTime(value) {
  if (value == null || value === '') return null
  const time = value instanceof Date ? value.getTime() : new Date(value).getTime()
  return Number.isFinite(time) ? time : null
}

export function sortedBoxQtyEntries(source) {
  const entries = Array.isArray(source) ? source : Object.entries(source || {})
  return entries
    .filter((entry) => Array.isArray(entry) && Number(entry[1]) > 0)
    .sort((a, b) => String(a[0]).localeCompare(String(b[0]), undefined, { numeric: true }))
}

export function boxPackedUnits(box) {
  if (!box) return 0
  const fromItems = Array.isArray(box.items)
    ? box.items.reduce((sum, item) => sum + (Number(item?.qty ?? item?.quantity) || 0), 0)
    : 0
  const total = Number(box.totalQty)
  if (Number.isFinite(total) && total > 0) return total
  return fromItems
}

export function formatUnitCount(units) {
  const count = Number(units) || 0
  return `${count} ${count === 1 ? 'unit' : 'units'}`
}

function formatAdjustmentChange(audit) {
  if (audit.actionType === 'edit') return `${audit.previousQuantity} → ${audit.updatedQuantity}`
  if (audit.actionType === 'add') return `+${audit.quantity}`
  if (audit.actionType === 'remove') return `-${audit.quantity}`
  return audit.quantity == null ? '' : String(audit.quantity)
}

function pushAdjustmentEvents(events, box) {
  const rows = [
    ...(Array.isArray(box.adjustments) ? box.adjustments : []),
    ...(Array.isArray(box.auditLog) ? box.auditLog : []),
  ]
  const seen = new Set()
  rows.forEach((audit, idx) => {
    if (!audit) return
    if (audit.status && audit.status !== 'completed') return
    const when = audit.completedAt || audit.at
    const timestamp = toEventTime(when)
    if (timestamp == null) return
    const key = audit.id || `${box.boxNo}-${when}-${audit.skuId || idx}`
    if (seen.has(String(key))) return
    seen.add(String(key))
    events.push({
      id: `evt-audit-${box.boxNo}-${key}`,
      timestamp,
      type: 'audit',
      title: `Quantity Adjustment in Box #${box.boxNo}`,
      description: `${audit.internalSku || audit.skuId || 'SKU'}: ${formatAdjustmentChange(audit)} (${audit.reasonLabel || audit.reason || 'Variance adjustment'})`,
      user: audit.removedByName || audit.userName || 'Supervisor',
      badge: 'Adjustment',
      badgeColor: 'bg-rose-50 text-rose-700 border-rose-200',
    })
  })
}

export function buildConsignmentTimeline(consignment) {
  if (!consignment) return []
  const events = []

  const createdAt = toEventTime(consignment.createdAt)
  if (createdAt != null) {
    events.push({
      id: 'evt-created',
      timestamp: createdAt,
      type: 'creation',
      title: 'Consignment Inward Registered',
      description: `Shipment inward registered for ${consignment.marketplace || 'Marketplace'} (${consignment.marketplaceConsignmentId || consignment.internalShipmentNo || 'ID'})`,
      user: consignment.createdByName || consignment.createdBy || 'System',
      badge: 'Inward Created',
      badgeColor: 'bg-blue-50 text-blue-700 border-blue-200/80',
    })
  }

  if (consignment.stageConfirmations && typeof consignment.stageConfirmations === 'object') {
    const stageMeta = {
      packing_completed: { title: 'Packing Station Completed', badge: 'Stage: Packed', color: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
      ready_for_invoice: { title: 'Ready for Invoice', badge: 'Stage: Invoice', color: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
      invoice_created: { title: 'Invoice Generated & Confirmed', badge: 'Stage: Invoiced', color: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
      ready_for_dispatch: { title: 'Ready to Dispatch Sign-off', badge: 'Stage: Ready', color: 'bg-teal-50 text-teal-700 border-teal-200' },
      dispatched: { title: 'Consignment Dispatched', badge: 'Stage: Dispatched', color: 'bg-purple-50 text-purple-700 border-purple-200' },
      inward_completed: { title: 'Warehouse Inward Completed', badge: 'Stage: Inward', color: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
    }

    Object.entries(consignment.stageConfirmations).forEach(([stageKey, data]) => {
      const timestamp = toEventTime(data?.confirmedAt)
      if (timestamp == null) return
      const meta = stageMeta[stageKey] || { title: `Stage Milestone: ${stageKey}`, badge: 'Milestone', color: 'bg-slate-50 text-slate-700 border-slate-200' }
      events.push({
        id: `evt-stage-${stageKey}`,
        timestamp,
        type: 'stage',
        title: meta.title,
        description: (data.note || data.notes) ? `Note: "${data.note || data.notes}"` : 'Stage milestone successfully approved and signed off.',
        user: data.confirmedByName || data.confirmedBy || 'Warehouse Team',
        badge: meta.badge,
        badgeColor: meta.color,
      })
    })
  }

  if (Array.isArray(consignment.boxes)) {
    consignment.boxes.forEach((box) => {
      const timestamp = toEventTime(box.createdAt || box.updatedAt || box.scannedAt)
      if (timestamp != null) {
        const units = boxPackedUnits(box)
        events.push({
          id: `evt-box-${box.boxNo}`,
          timestamp,
          type: 'box',
          title: `Box #${box.boxNo} Finalized`,
          description: `Box sealed with ${formatUnitCount(units)}${box.weight ? ` · Weight: ${box.weight} kg` : ''}`,
          user: box.packedByName || box.packedBy || 'Packing Station',
          badge: `Box #${box.boxNo}`,
          badgeColor: 'bg-amber-50 text-amber-700 border-amber-200',
        })
      }
      pushAdjustmentEvents(events, box)
    })
  }

  if (Array.isArray(consignment.videos)) {
    consignment.videos.forEach((vid) => {
      const timestamp = toEventTime(vid.uploadedAt)
      if (timestamp == null) return
      events.push({
        id: `evt-vid-${vid.id}`,
        timestamp,
        type: 'video',
        title: 'Surveillance Video Attached',
        description: `Box #${vid.boxNo || '—'}: "${vid.originalName}" (${vid.size ? `${(vid.size / 1024 / 1024).toFixed(1)} MB` : 'Stream recorded'})`,
        user: vid.uploadedByName || 'CCTV Station',
        badge: 'Video Proof',
        badgeColor: 'bg-indigo-50 text-indigo-700 border-indigo-200',
      })
    })
  }

  if (Array.isArray(consignment.documents)) {
    consignment.documents.forEach((doc) => {
      const timestamp = toEventTime(doc.uploadedAt)
      if (timestamp == null) return
      events.push({
        id: `evt-doc-${doc.id}`,
        timestamp,
        type: 'document',
        title: `Document Uploaded: ${doc.originalName}`,
        description: `Type: ${doc.purpose || 'Shipment Document'} (${doc.size ? `${(doc.size / 1024).toFixed(1)} KB` : 'Cloud Vault'})`,
        user: doc.uploadedByName || 'Operations Team',
        badge: doc.purpose === 'invoice' ? 'Invoice Doc' : doc.purpose === 'docket' ? 'Docket Doc' : 'Document',
        badgeColor: 'bg-emerald-50 text-emerald-700 border-emerald-200',
      })
    })
  }

  if (consignment.marketplaceTicketId) {
    events.push({
      id: 'evt-dispute-ticket',
      timestamp: toEventTime(consignment.updatedAt) ?? Date.now(),
      type: 'dispute',
      title: 'Marketplace Claim / Dispute Logged',
      description: `Ticket Reference: ${consignment.marketplaceTicketId}`,
      user: 'Marketplace Operations',
      badge: 'Claim Filed',
      badgeColor: 'bg-red-50 text-red-700 border-red-200',
    })
  }

  return events.sort((a, b) => {
    const left = Number.isFinite(a.timestamp) ? a.timestamp : Number.NEGATIVE_INFINITY
    const right = Number.isFinite(b.timestamp) ? b.timestamp : Number.NEGATIVE_INFINITY
    if (right !== left) return right - left
    return String(a.id).localeCompare(String(b.id))
  })
}
