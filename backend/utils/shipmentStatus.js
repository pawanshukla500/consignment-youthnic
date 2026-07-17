/**
 * Automatic shipment / pack status transitions driven by packing-station activity.
 *
 * shipmentStatus lifecycle (auto):
 *   Planned | Scheduled  →  Under Packing  (packing started)
 *   Under Packing        →  (stays) until ground-team confirms packing_completed
 *                           then ready_for_dispatch before Ready logistics
 *
 * status lifecycle (auto):
 *   pending → in_progress (packing started / box saved)
 *   *       → completed   (all SKUs fully packed)
 */

const PRE_PACK_SHIP = new Set(['Planned', 'Scheduled', '']);

function mergeStatusUpdates(consignment, updates) {
  const merged = { ...updates, updatedAt: new Date().toISOString() };
  const changed = Object.keys(updates).some((k) => updates[k] !== consignment[k]);
  return changed ? merged : null;
}

/** Consignment loaded into packing station — marks packing as started. */
function getPackingLoadUpdates(consignment) {
  const updates = {};
  const ship = consignment.shipmentStatus || 'Planned';

  if (PRE_PACK_SHIP.has(ship)) {
    updates.shipmentStatus = 'Under Packing';
  }
  if (consignment.status === 'pending') {
    updates.status = 'in_progress';
  }

  return mergeStatusUpdates(consignment, updates);
}

/** Box saved — keeps pack + ship status in sync with physical progress.
 *  Does NOT auto-advance to Ready — ground team must confirm packing_completed,
 *  then ready_for_dispatch, before Ready / invoice / dispatch logistics. */
function getSaveBoxUpdates(consignment, allCompleted) {
  const updates = {
    status: allCompleted ? 'completed' : 'in_progress',
  };
  const ship = consignment.shipmentStatus || 'Planned';

  if (PRE_PACK_SHIP.has(ship) || (allCompleted && ship === 'Ready' && !consignment.stageConfirmations?.packing_completed?.confirmedAt)) {
    updates.shipmentStatus = 'Under Packing';
  } else if (PRE_PACK_SHIP.has(ship)) {
    updates.shipmentStatus = 'Under Packing';
  }

  return mergeStatusUpdates(consignment, updates);
}

/** Packing session finished — pack status only; Ready is gated by workflow confirmations. */
function getPackingFinishUpdates(consignment, allCompleted) {
  const updates = {
    status: allCompleted ? 'completed' : 'in_progress',
  };
  const ship = consignment.shipmentStatus || 'Planned';

  if (PRE_PACK_SHIP.has(ship) || ship === 'Ready') {
    // Keep Under Packing until ground-team packing_completed + ready_for_dispatch
    if (!consignment.stageConfirmations?.ready_for_dispatch?.confirmedAt) {
      updates.shipmentStatus = 'Under Packing';
    }
  } else if (!allCompleted && ship === 'Under Packing') {
    updates.shipmentStatus = 'Under Packing';
  }

  return mergeStatusUpdates(consignment, updates);
}

/** After quantity reduction (decrement / box edit) — never leave completed/Ready if incomplete. */
function getQuantityReductionUpdates(consignment, allCompleted) {
  const updates = {
    status: allCompleted ? 'completed' : 'in_progress',
  };
  const ship = consignment.shipmentStatus || 'Planned';

  if (allCompleted) {
    if (!consignment.stageConfirmations?.ready_for_dispatch?.confirmedAt) {
      if (ship === 'Under Packing' || PRE_PACK_SHIP.has(ship) || ship === 'Ready') {
        updates.shipmentStatus = 'Under Packing';
      }
    }
  } else if (ship === 'Ready' || ship === 'Under Packing') {
    updates.shipmentStatus = 'Under Packing';
  } else if (PRE_PACK_SHIP.has(ship)) {
    updates.shipmentStatus = 'Under Packing';
  }

  return mergeStatusUpdates(consignment, updates);
}

module.exports = {
  getPackingLoadUpdates,
  getSaveBoxUpdates,
  getPackingFinishUpdates,
  getQuantityReductionUpdates,
};
