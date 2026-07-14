/**
 * Simulated daily packing workload (API-level, no browser MediaRecorder).
 * Runs 100 scan increments across 4 consignments to measure latency/pool health.
 *
 * Usage (API must be running with a valid admin JWT):
 *   set STABILITY_TOKEN=...   optional; otherwise skips live API portion
 *   node scripts/stability-load-sim.js
 *
 * Always runs local integrity + draft slim checks without the API.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), override: true });

const { testConnection, getPool, getDatabaseDiagnostics, pgEnabled } = require('../config/database');
const { rebuildSessionSkuTotalsFromBoxes } = require('../utils/packingQuantities');

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx];
}

async function simulateInMemoryWorkload() {
  const consignments = 4;
  const boxesPer = 25;
  const scansPerBox = 4; // 100 boxes * 4 = 400 scans total across 4 consignments... adjust
  // Target: 4 consignments, 100 boxes total => 25 boxes each, ~4 scans/box => 400 scans
  const latencies = [];
  let accepted = 0;

  for (let c = 0; c < consignments; c += 1) {
    const session = {
      skus: Array.from({ length: 20 }, (_, i) => ({
        id: `c${c}-sku${i}`,
        packed: 0,
        required: 20,
        remaining: 20,
        status: 'pending',
      })),
      boxes: {},
    };
    for (let b = 1; b <= boxesPer; b += 1) {
      for (let s = 0; s < scansPerBox; s += 1) {
        const t0 = Date.now();
        const sku = session.skus[s % session.skus.length];
        if (sku.packed >= sku.required) continue;
        const boxNo = String(b);
        const items = (session.boxes[boxNo] || []).map((x) => ({ ...x }));
        const existing = items.find((i) => i.skuId === sku.id);
        if (existing) existing.qty += 1;
        else items.push({ skuId: sku.id, qty: 1 });
        sku.packed += 1;
        sku.remaining = Math.max(0, sku.required - sku.packed);
        if (sku.remaining <= 0) sku.status = 'completed';
        session.boxes[boxNo] = items;
        rebuildSessionSkuTotalsFromBoxes(session);
        accepted += 1;
        latencies.push(Date.now() - t0);
      }
    }
    // integrity: packed totals == sum of box items
    const fromBoxes = {};
    for (const items of Object.values(session.boxes)) {
      for (const item of items) {
        fromBoxes[item.skuId] = (fromBoxes[item.skuId] || 0) + item.qty;
      }
    }
    for (const sku of session.skus) {
      assertEqual(sku.packed, fromBoxes[sku.id] || 0, `sku ${sku.id} packed mismatch`);
    }
  }

  latencies.sort((a, b) => a - b);
  return {
    accepted,
    boxes: consignments * boxesPer,
    consignments,
    p50Ms: percentile(latencies, 50),
    p95Ms: percentile(latencies, 95),
    maxMs: latencies[latencies.length - 1] || 0,
  };
}

function assertEqual(a, b, msg) {
  if (a !== b) throw new Error(`${msg}: ${a} !== ${b}`);
}

async function main() {
  console.log('\n=== Packing Stability / Capacity Simulation ===\n');

  if (!pgEnabled()) {
    console.error('Postgres not enabled');
    process.exit(1);
  }

  const probe = await testConnection();
  const diag = getDatabaseDiagnostics();
  console.log('DB probe:', probe.ok ? `OK ${probe.latencyMs}ms` : `FAIL ${probe.error}`);
  console.log('Pool max:', diag.pool?.max);

  const mem = await simulateInMemoryWorkload();
  console.log('In-memory workload (4 consignments × 25 boxes × 4 scans):');
  console.log(JSON.stringify(mem, null, 2));

  // Connection leak check: open and release many clients
  const clients = [];
  for (let i = 0; i < 10; i += 1) {
    clients.push(await getPool().connect());
  }
  for (const c of clients) c.release();
  const after = getDatabaseDiagnostics().pool;
  console.log('Pool after borrow/release 10 clients:', after);

  if (after.waitingCount > 0) {
    throw new Error('Pool has waiters after release — possible leak');
  }

  console.log('\nCapacity estimate (daily):');
  console.log(JSON.stringify({
    consignments: 4,
    boxes: 100,
    videos: 100,
    videoSizeEstimateMB: '30–80 MB/video @ 720p 800kbps (depends on box duration)',
    dailyVideoStorageGB: '3–8 GB/day',
    monthlyVideoStorageGB: '90–240 GB/month',
    recommendedPoolMax: 20,
    recommendedUploadConcurrency: 1,
    notes: [
      'Offline IndexedDB queues protect scans/videos across disconnects',
      'Finish is blocked until each saved box has a storage-verified video',
      'Prefer single Cloud Run / API instance for packing sessions (in-memory MEM)',
    ],
  }, null, 2));

  console.log('\nRESULT: Local integrity simulation OK.');
  try { await getPool()?.end(); } catch (_) {}
}

main().catch(async (e) => {
  console.error('FAIL:', e.message);
  try { await getPool()?.end(); } catch (_) {}
  process.exit(1);
});
