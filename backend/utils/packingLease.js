const { pgEnabled, getPool } = require('../config/database');

async function assertPackingStationAccess(consignmentId, stationId = null, userId = null, queryable = null) {
  if (!pgEnabled() || !consignmentId) return;
  const db = queryable || getPool();
  // Web-only deployments can be upgraded before the desktop migration runs.
  const { rows: schema } = await db.query("SELECT to_regclass('public.packing_station_leases') AS relation");
  if (!schema[0]?.relation) return;
  const { rows } = await db.query(`SELECT station_id, station_name, user_id FROM packing_station_leases
    WHERE consignment_id = $1 AND status = 'active' LIMIT 1`, [consignmentId]);
  const lease = rows[0];
  if (lease && (lease.station_id !== String(stationId || '') || lease.user_id !== String(userId || ''))) {
    const error = new Error(`Consignment is assigned to ${lease.station_name || lease.station_id}. Sync and release that station before making changes.`);
    error.statusCode = 409;
    error.code = 'PACKING_STATION_CONFLICT';
    throw error;
  }
}

module.exports = { assertPackingStationAccess };
