const { getWarehouseNames } = require('./marketplaceHelpers');

function normalizeFieldValue(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'boolean') return value;
  return String(value).trim();
}

function valuesDiffer(fromValue, toValue) {
  const from = normalizeFieldValue(fromValue);
  const to = normalizeFieldValue(toValue);
  if (typeof from === 'boolean' || typeof to === 'boolean') return Boolean(from) !== Boolean(to);
  return from !== to;
}

function collectChangedFields(existing = {}, updateData = {}, fields = []) {
  const changes = {};
  for (const field of fields) {
    if (updateData[field] === undefined) continue;
    if (!valuesDiffer(existing[field], updateData[field])) continue;
    const from = existing[field];
    const to = updateData[field];
    changes[field] = {
      from: from === undefined || from === '' ? null : from,
      to: to === undefined || to === '' ? null : to,
    };
  }
  return changes;
}

function resolveWarehouseForMarketplace(marketplace, warehouseName) {
  const requested = String(warehouseName || '').trim();
  if (!marketplace) return { warehouse: requested, cleared: false, invalid: false };
  const names = getWarehouseNames(marketplace.warehouses);
  if (!names.length) return { warehouse: requested, cleared: false, invalid: false };
  if (!requested) return { warehouse: '', cleared: false, invalid: false };
  if (names.includes(requested)) return { warehouse: requested, cleared: false, invalid: false };
  return { warehouse: '', cleared: true, invalid: true };
}

function actorIdentity(user = {}) {
  return {
    id: user.id || null,
    name: user.name || null,
    email: user.email || null,
  };
}

function buildConsignmentUpdateAuditDetails(existing, updateData, user, extra = {}) {
  const trackedFields = extra.fields || Object.keys(updateData || {}).filter((key) => key !== 'updatedAt');
  const changes = collectChangedFields(existing, updateData, trackedFields);
  return {
    changedBy: actorIdentity(user),
    changes,
    marketplaceId: changes.marketplaceId || undefined,
    warehouse: changes.warehouse || undefined,
    warehouseClearedAsInvalid: extra.warehouseClearedAsInvalid || undefined,
  };
}

module.exports = {
  normalizeFieldValue,
  valuesDiffer,
  collectChangedFields,
  resolveWarehouseForMarketplace,
  actorIdentity,
  buildConsignmentUpdateAuditDetails,
};
