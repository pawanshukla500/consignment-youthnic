/**
 * One-time data migration: canonicalize legacy box numbers saved with leading
 * zeros (e.g. "01", "007") before box-number normalization existed. Reuses
 * renameBoxNo() so the full cascade — box id/boxNo, videos, scan_events,
 * packing_adjustments — stays consistent and gets the same audit trail as an
 * operator-triggered rename.
 *
 * A box whose canonical number already collides with another box on the same
 * consignment is SKIPPED and reported — this script never merges two boxes
 * automatically; that's a business decision for a human, not this script.
 *
 * Run: node backend/scripts/migrate-canonicalize-box-numbers.js [--dry-run]
 * (config/database.js reads SUPABASE_DB_URL / DATABASE_URL from backend/.env)
 */
const { getPool, pgEnabled } = require('../config/database');
const { renameBoxNo } = require('../utils/packingAdjustments');

function canonicalBoxNo(value) {
  return String(value ?? '').trim().replace(/^0+(?=\d)/, '');
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');

  if (!pgEnabled()) {
    console.error('FAIL: Postgres is not configured (set SUPABASE_DB_URL or DATABASE_URL).');
    process.exit(1);
  }

  const { rows } = await getPool().query(
    `SELECT id, data->>'consignmentId' AS consignment_id, data->>'boxNo' AS box_no
     FROM documents
     WHERE collection = 'boxes' AND data->>'boxNo' ~ '^[0-9]+$'`
  );

  const nonCanonical = rows.filter((row) => canonicalBoxNo(row.box_no) !== row.box_no);
  console.log(`Found ${nonCanonical.length} box(es) with a non-canonical boxNo (out of ${rows.length} total).`);

  let renamed = 0;
  let skipped = 0;
  for (const row of nonCanonical) {
    const canon = canonicalBoxNo(row.box_no);
    const collision = rows.find(
      (other) => other.id !== row.id
        && other.consignment_id === row.consignment_id
        && canonicalBoxNo(other.box_no) === canon
    );
    if (collision) {
      skipped++;
      console.warn(
        `SKIP (needs manual reconciliation): consignment ${row.consignment_id} — `
        + `box "${row.box_no}" (${row.id}) canonicalizes to "${canon}", which collides with `
        + `box "${collision.box_no}" (${collision.id}).`
      );
      continue;
    }
    if (dryRun) {
      console.log(`[dry-run] Would rename consignment ${row.consignment_id}: box "${row.box_no}" -> "${canon}"`);
      renamed++;
      continue;
    }
    try {
      await renameBoxNo({
        consignmentId: row.consignment_id,
        oldBoxNo: row.box_no,
        newBoxNo: canon,
        reason: 'Automated migration: normalize legacy leading-zero box number',
        remarks: '',
        user: null,
      });
      renamed++;
      console.log(`Renamed consignment ${row.consignment_id}: box "${row.box_no}" -> "${canon}"`);
    } catch (err) {
      skipped++;
      console.error(`FAILED consignment ${row.consignment_id} box "${row.box_no}" -> "${canon}": ${err.message}`);
    }
  }

  console.log(`\nDone. ${renamed} renamed${dryRun ? ' (dry-run, no changes made)' : ''}, ${skipped} skipped.`);
  await getPool().end();
  process.exit(skipped > 0 && !dryRun ? 1 : 0);
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
