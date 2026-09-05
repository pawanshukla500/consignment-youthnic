const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { BOX_STATES, transitionState, summarizeBoxes } = require('./stateMachine.cjs');

const MIGRATIONS = [
  {
    id: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS desktop_station (
        station_id TEXT PRIMARY KEY,
        station_name TEXT NOT NULL,
        warehouse TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS local_consignments (
        consignment_id TEXT PRIMARY KEY,
        internal_shipment_no TEXT,
        status TEXT NOT NULL DEFAULT 'ready_offline',
        snapshot_json TEXT NOT NULL,
        downloaded_at TEXT NOT NULL,
        last_cloud_sync_at TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS local_skus (
        consignment_id TEXT NOT NULL,
        sku_id TEXT NOT NULL,
        barcode TEXT,
        marketplace_sku TEXT,
        internal_sku TEXT,
        required_qty INTEGER NOT NULL DEFAULT 0,
        packed_qty INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending',
        PRIMARY KEY (consignment_id, sku_id),
        FOREIGN KEY (consignment_id) REFERENCES local_consignments(consignment_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS local_boxes (
        box_id TEXT PRIMARY KEY,
        consignment_id TEXT NOT NULL,
        box_no TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'OPEN',
        operation_id TEXT,
        total_qty INTEGER NOT NULL DEFAULT 0,
        weight REAL,
        weight_unit TEXT,
        weight_proof_id TEXT,
        weight_proof_path TEXT,
        video_id TEXT,
        video_state TEXT,
        created_at TEXT NOT NULL,
        closed_at TEXT,
        updated_at TEXT NOT NULL,
        UNIQUE (consignment_id, box_no),
        FOREIGN KEY (consignment_id) REFERENCES local_consignments(consignment_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS local_box_items (
        box_id TEXT NOT NULL,
        sku_id TEXT NOT NULL,
        barcode TEXT,
        marketplace_sku TEXT,
        internal_sku TEXT,
        qty INTEGER NOT NULL CHECK (qty > 0),
        PRIMARY KEY (box_id, sku_id),
        FOREIGN KEY (box_id) REFERENCES local_boxes(box_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS local_scan_events (
        scan_id TEXT PRIMARY KEY,
        consignment_id TEXT NOT NULL,
        box_no TEXT NOT NULL,
        sku_id TEXT,
        barcode TEXT NOT NULL,
        qty_delta INTEGER NOT NULL,
        result TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        captured_at TEXT NOT NULL,
        sequence_no INTEGER
      );

      CREATE TABLE IF NOT EXISTS local_weight_proofs (
        proof_id TEXT PRIMARY KEY,
        consignment_id TEXT NOT NULL,
        box_no TEXT NOT NULL,
        local_path TEXT NOT NULL,
        size_bytes INTEGER NOT NULL DEFAULT 0,
        sha256 TEXT,
        verified INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS local_videos (
        video_id TEXT PRIMARY KEY,
        consignment_id TEXT NOT NULL,
        box_no TEXT NOT NULL,
        local_path TEXT NOT NULL,
        size_bytes INTEGER NOT NULL DEFAULT 0,
        sha256 TEXT,
        mime_type TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'VIDEO_QUEUED',
        storage_path TEXT,
        verified INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sync_outbox (
        job_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        consignment_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'queued',
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sync_attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        outcome TEXT,
        error TEXT
      );

      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_local_skus_barcode
        ON local_skus(consignment_id, barcode, marketplace_sku, internal_sku);
      CREATE INDEX IF NOT EXISTS idx_local_boxes_consignment_state
        ON local_boxes(consignment_id, state, updated_at);
      CREATE INDEX IF NOT EXISTS idx_local_scan_events_consignment
        ON local_scan_events(consignment_id, captured_at);
      CREATE INDEX IF NOT EXISTS idx_local_videos_state
        ON local_videos(consignment_id, state, verified);
      CREATE INDEX IF NOT EXISTS idx_sync_outbox_ready
        ON sync_outbox(state, next_attempt_at, created_at);
    `,
  },
  { id: 2, sql: `
    CREATE TABLE local_scan_keys (
      consignment_id TEXT NOT NULL,
      scan_key TEXT NOT NULL COLLATE NOCASE,
      sku_id TEXT NOT NULL,
      PRIMARY KEY (consignment_id, scan_key, sku_id)
    );
    INSERT OR IGNORE INTO local_scan_keys SELECT consignment_id, barcode, sku_id FROM local_skus WHERE barcode IS NOT NULL;
    INSERT OR IGNORE INTO local_scan_keys SELECT consignment_id, marketplace_sku, sku_id FROM local_skus WHERE marketplace_sku IS NOT NULL;
    INSERT OR IGNORE INTO local_scan_keys SELECT consignment_id, internal_sku, sku_id FROM local_skus WHERE internal_sku IS NOT NULL;
    CREATE INDEX idx_outbox_consignment_state ON sync_outbox(consignment_id, state);
  ` },
];

function nowIso() { return new Date().toISOString(); }
function parseJson(value, fallback = null) {
  try { return value == null ? fallback : JSON.parse(value); } catch (_) { return fallback; }
}
function clean(value) { return value == null ? '' : String(value).trim(); }
function positiveQty(value) {
  const qty = Number(value);
  return Number.isInteger(qty) && qty > 0 ? qty : 0;
}
function idForBox(consignmentId, boxNo) { return `${consignmentId}::${String(boxNo)}`; }

class SqliteAdapter {
  constructor(raw) { this.raw = raw; }
  exec(sql) { return this.raw.exec(sql); }
  prepare(sql) { return this.raw.prepare(sql); }
  close() { return this.raw.close(); }
  transaction(callback) {
    return (...args) => {
      this.raw.exec('BEGIN IMMEDIATE');
      try {
        const result = callback(...args);
        this.raw.exec('COMMIT');
        return result;
      } catch (error) {
        try { this.raw.exec('ROLLBACK'); } catch (_) {}
        throw error;
      }
    };
  }
}

class DesktopDatabase {
  constructor(db, dbPath, logger) {
    this.db = db;
    this.dbPath = dbPath;
    this.logger = logger;
  }

  close() { this.db.close(); }

  getStation() {
    return this.db.prepare('SELECT * FROM desktop_station LIMIT 1').get() || null;
  }

  ensureStation({ stationId = null, stationName = 'Packing Station', warehouse = null } = {}) {
    const current = this.getStation();
    if (current) return current;
    const row = { stationId: stationId || crypto.randomUUID(), stationName, warehouse, at: nowIso() };
    this.db.prepare(`INSERT INTO desktop_station (station_id, station_name, warehouse, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`)
      .run(row.stationId, row.stationName, row.warehouse, row.at, row.at);
    this.logger?.info('station.created', { stationId: row.stationId, stationName: row.stationName });
    return this.getStation();
  }

  updateStation({ stationName, warehouse } = {}) {
    const current = this.ensureStation();
    const at = nowIso();
    this.db.prepare(`UPDATE desktop_station SET station_name = COALESCE(?, station_name), warehouse = COALESCE(?, warehouse), updated_at = ? WHERE station_id = ?`)
      .run(stationName || null, warehouse || null, at, current.station_id);
    return this.getStation();
  }

  setSetting(key, value) {
    this.db.prepare(`INSERT INTO app_settings (key, value_json, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`)
      .run(String(key), JSON.stringify(value), nowIso());
    return value;
  }

  getSetting(key, fallback = null) {
    return parseJson(this.db.prepare('SELECT value_json FROM app_settings WHERE key = ?').get(String(key))?.value_json, fallback);
  }

  saveSnapshot(snapshot, { userId = null } = {}) {
    const consignmentId = clean(snapshot?.consignment_id || snapshot?.consignmentId || snapshot?.id);
    if (!consignmentId) throw new Error('A consignment id is required for a local snapshot');
    const at = nowIso();
    const skus = Array.isArray(snapshot.skus) ? snapshot.skus : [];
    const boxes = snapshot.boxes && typeof snapshot.boxes === 'object' ? snapshot.boxes : {};
    const localWork = this.db.prepare("SELECT 1 FROM local_boxes WHERE consignment_id = ? AND state <> 'SYNCED' LIMIT 1").get(consignmentId);
    // A cloud refresh cannot overwrite an offline session or accepted scans.
    if (localWork) return this.getSnapshot(consignmentId);
    const tx = this.db.transaction(() => {
      const existing = { count: 0 };
      // No pending work exists here. Replace the cloud mirror atomically so a
      // removed/renamed server box or SKU cannot reappear in the next totals.
      // Immutable scans, outbox history and evidence files are retained.
      this.db.prepare('DELETE FROM local_boxes WHERE consignment_id = ?').run(consignmentId);
      this.db.prepare('DELETE FROM local_skus WHERE consignment_id = ?').run(consignmentId);
      this.db.prepare('DELETE FROM local_scan_keys WHERE consignment_id = ?').run(consignmentId);
      this.db.prepare(`INSERT INTO local_consignments (consignment_id, internal_shipment_no, status, snapshot_json, downloaded_at, updated_at)
        VALUES (?, ?, 'ready_offline', ?, ?, ?)
        ON CONFLICT(consignment_id) DO UPDATE SET
          internal_shipment_no = excluded.internal_shipment_no,
          snapshot_json = excluded.snapshot_json,
          updated_at = excluded.updated_at`)
        .run(consignmentId, snapshot.internalShipmentNo || snapshot.internal_shipment_no || consignmentId, JSON.stringify({ ...snapshot, localSnapshotUserId: userId || null }), at, at);

      for (const sku of skus) {
        const skuId = clean(sku.id || sku.skuId);
        if (!skuId) continue;
        this.db.prepare(`INSERT INTO local_skus (consignment_id, sku_id, barcode, marketplace_sku, internal_sku, required_qty, packed_qty, status)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(consignment_id, sku_id) DO UPDATE SET
            barcode = excluded.barcode,
            marketplace_sku = excluded.marketplace_sku,
            internal_sku = excluded.internal_sku,
            required_qty = excluded.required_qty,
            packed_qty = CASE WHEN ? > 0 THEN local_skus.packed_qty ELSE excluded.packed_qty END,
            status = CASE WHEN ? > 0 THEN local_skus.status ELSE excluded.status END`)
          .run(consignmentId, skuId, sku.marketplaceBarcode || sku.skuBarcode || sku.scanBarcode || sku.barcode || null, sku.marketplaceSku || sku.marketplace_sku || null, sku.internalSku || sku.internal_sku || null,
            Number(sku.required ?? sku.requiredQty ?? sku.required_qty) || 0, Number(sku.packed ?? sku.packedQty ?? sku.packed_qty) || 0,
            sku.status || 'pending', Number(existing.count) || 0, Number(existing.count) || 0);
        for (const key of [sku.marketplaceBarcode, sku.skuBarcode, sku.scanBarcode, sku.barcode, sku.marketplaceSku, sku.internalSku].map(clean).filter(Boolean)) {
          this.db.prepare('INSERT OR IGNORE INTO local_scan_keys (consignment_id, scan_key, sku_id) VALUES (?, ?, ?)').run(consignmentId, key, skuId);
        }
      }

      for (const [boxNoRaw, items] of Object.entries(boxes)) {
        const boxNo = clean(boxNoRaw);
        if (!boxNo || !Array.isArray(items)) continue;
        const boxId = idForBox(consignmentId, boxNo);
        const previous = this.db.prepare('SELECT state FROM local_boxes WHERE box_id = ?').get(boxId);
        if (previous && ![BOX_STATES.SYNCED, BOX_STATES.DATA_SYNCED].includes(previous.state)) continue;
        this.db.prepare(`INSERT INTO local_boxes (box_id, consignment_id, box_no, state, total_qty, video_state, created_at, updated_at)
          VALUES (?, ?, ?, 'SYNCED', ?, 'SYNCED', ?, ?)
          ON CONFLICT(consignment_id, box_no) DO UPDATE SET total_qty = excluded.total_qty, updated_at = excluded.updated_at`)
          .run(boxId, consignmentId, boxNo, (items || []).reduce((sum, item) => sum + positiveQty(item.qty), 0), at, at);
        this.db.prepare('DELETE FROM local_box_items WHERE box_id = ?').run(boxId);
        for (const item of items) {
          const qty = positiveQty(item.qty);
          const skuId = clean(item.skuId);
          if (!qty || !skuId) continue;
          this.db.prepare(`INSERT INTO local_box_items (box_id, sku_id, barcode, marketplace_sku, internal_sku, qty) VALUES (?, ?, ?, ?, ?, ?)`)
            .run(boxId, skuId, item.barcode || item.marketplaceBarcode || null, item.marketplaceSku || null, item.internalSku || item.name || null, qty);
        }
      }
    });
    tx();
    this.logger?.info('consignment.cached', { consignmentId, skuCount: skus.length, boxCount: Object.keys(boxes).length });
    return this.getSnapshot(consignmentId);
  }

  listCachedConsignments() {
    return this.db.prepare(`SELECT consignment_id AS consignmentId, internal_shipment_no AS internalShipmentNo, status, downloaded_at AS downloadedAt, updated_at AS updatedAt
      FROM local_consignments ORDER BY updated_at DESC`).all();
  }

  getSnapshot(consignmentId) {
    const key = clean(consignmentId);
    const row = this.db.prepare(`SELECT * FROM local_consignments
      WHERE consignment_id = ? OR internal_shipment_no = ?
      ORDER BY CASE WHEN consignment_id = ? THEN 0 ELSE 1 END
      LIMIT 1`).get(key, key, key);
    if (!row) return null;
    const snapshot = parseJson(row.snapshot_json, {}) || {};
    const originalSkus = new Map((snapshot.skus || []).map((sku) => [String(sku.id || sku.skuId), sku]));
    const skus = this.db.prepare('SELECT * FROM local_skus WHERE consignment_id = ? ORDER BY rowid').all(row.consignment_id).map((sku) => ({
      ...originalSkus.get(sku.sku_id),
      id: sku.sku_id,
      barcode: sku.barcode,
      marketplaceSku: sku.marketplace_sku,
      internalSku: sku.internal_sku,
      required: sku.required_qty,
      packed: sku.packed_qty,
      remaining: Math.max(0, sku.required_qty - sku.packed_qty),
      status: sku.status,
    }));
    const boxes = {};
    for (const box of this.db.prepare('SELECT * FROM local_boxes WHERE consignment_id = ? ORDER BY CAST(box_no AS INTEGER), box_no').all(row.consignment_id)) {
      boxes[box.box_no] = this.db.prepare('SELECT sku_id AS skuId, barcode, marketplace_sku AS marketplaceSku, internal_sku AS internalSku, internal_sku AS name, qty FROM local_box_items WHERE box_id = ? ORDER BY rowid').all(box.box_id);
    }
    return {
      ...snapshot,
      consignment_id: row.consignment_id,
      internalShipmentNo: snapshot.internalShipmentNo || row.internal_shipment_no,
      skus,
      boxes,
      total_skus: skus.length,
      totalPackedQty: skus.reduce((sum, sku) => sum + sku.packed, 0),
      localBoxes: this.db.prepare('SELECT box_no, state, video_id FROM local_boxes WHERE consignment_id = ?').all(row.consignment_id),
      localStatus: row.status,
    };
  }

  openBox({ consignmentId, boxNo }) {
    const cid = clean(consignmentId);
    const number = clean(boxNo);
    if (!cid || !number) throw new Error('consignmentId and boxNo are required');
    const at = nowIso();
    const boxId = idForBox(cid, number);
    const existing = this.db.prepare('SELECT * FROM local_boxes WHERE box_id = ?').get(boxId);
    if (existing && existing.state !== BOX_STATES.OPEN) throw new Error('This box is already closed. Start a new box; use the web adjustment workflow for closed boxes.');
    const other = this.db.prepare("SELECT box_no FROM local_boxes WHERE consignment_id = ? AND state = 'OPEN' AND box_id <> ?").get(cid, boxId);
    if (other) throw new Error(`Resume and close Box ${other.box_no} first`);
    this.db.prepare(`INSERT INTO local_boxes (box_id, consignment_id, box_no, state, video_state, created_at, updated_at)
      VALUES (?, ?, ?, 'OPEN', 'OPEN', ?, ?)
      ON CONFLICT(consignment_id, box_no) DO UPDATE SET state = 'OPEN', updated_at = ?`)
      .run(boxId, cid, number, at, at, at);
    return this.db.prepare('SELECT * FROM local_boxes WHERE box_id = ?').get(boxId);
  }

  recordScan({ consignmentId, boxNo, scanId, barcode, qty = 1, capturedAt = null, sequenceNo = null }) {
    const cid = clean(consignmentId);
    const number = clean(boxNo);
    const id = clean(scanId) || crypto.randomUUID();
    const code = clean(barcode);
    const delta = positiveQty(qty);
    if (!cid || !number || !code || !delta) throw new Error('A valid scan envelope is required');
    const existingEvent = this.db.prepare('SELECT * FROM local_scan_events WHERE scan_id = ?').get(id);
    if (existingEvent) {
      if (existingEvent.consignment_id !== cid || existingEvent.box_no !== number || existingEvent.barcode !== code || existingEvent.qty_delta !== delta) throw new Error('Scan ID was already used for a different event');
      return { ...parseJson(existingEvent.payload_json, {}), idempotentReplay: true };
    }
    const boxId = idForBox(cid, number);
    if (!this.db.prepare('SELECT 1 FROM local_boxes WHERE box_id = ?').get(boxId)) this.openBox({ consignmentId: cid, boxNo: number });
    const at = capturedAt || nowIso();

    const tx = this.db.transaction(() => {
      if (this.db.prepare('SELECT state FROM local_boxes WHERE box_id = ?').get(boxId)?.state !== BOX_STATES.OPEN) throw new Error('Cannot scan into a closed box');
      const matches = this.db.prepare(`SELECT s.* FROM local_skus s JOIN local_scan_keys k
        ON s.consignment_id = k.consignment_id AND s.sku_id = k.sku_id
        WHERE k.consignment_id = ? AND k.scan_key = ? COLLATE NOCASE LIMIT 2`).all(cid, code);
      const sku = matches[0];
      const rejection = (result, message, extra = {}) => {
        const payload = { ok: false, scan_id: id, barcode: code, result, message, ...extra };
        this.db.prepare(`INSERT INTO local_scan_events (scan_id, consignment_id, box_no, sku_id, barcode, qty_delta, result, payload_json, captured_at, sequence_no)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(id, cid, number, sku?.sku_id || null, code, delta, result, JSON.stringify(payload), at, sequenceNo || null);
        return payload;
      };
      if (!sku) return rejection('not_found', `Not in shipment: ${code}`);
      if (matches.length > 1) return rejection('ambiguous', 'This barcode maps to multiple SKUs. Correct the shipment mapping before scanning.');
      if (sku.packed_qty >= sku.required_qty || sku.status === 'completed') {
        return rejection('locked', `Already complete (${sku.packed_qty}/${sku.required_qty})`, { skuId: sku.sku_id, packed: sku.packed_qty, required: sku.required_qty });
      }
      if (sku.packed_qty + delta > sku.required_qty) {
        return rejection('over_limit', `Cannot exceed required qty (${sku.required_qty})`, { skuId: sku.sku_id, packed: sku.packed_qty, required: sku.required_qty });
      }
      const nextPacked = sku.packed_qty + delta;
      const nextStatus = nextPacked >= sku.required_qty ? 'completed' : 'pending';
      this.db.prepare('UPDATE local_skus SET packed_qty = ?, status = ? WHERE consignment_id = ? AND sku_id = ?')
        .run(nextPacked, nextStatus, cid, sku.sku_id);
      this.db.prepare(`INSERT INTO local_box_items (box_id, sku_id, barcode, marketplace_sku, internal_sku, qty)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(box_id, sku_id) DO UPDATE SET qty = local_box_items.qty + excluded.qty`)
        .run(boxId, sku.sku_id, sku.barcode || code, sku.marketplace_sku, sku.internal_sku, delta);
      const payload = {
        ok: true,
        scan_id: id,
        barcode: sku.barcode || code,
        marketplaceBarcode: sku.barcode || code,
        marketplaceSku: sku.marketplace_sku,
        internalSku: sku.internal_sku,
        skuId: sku.sku_id,
        packed: nextPacked,
        required: sku.required_qty,
        remaining: Math.max(0, sku.required_qty - nextPacked),
        result: 'accepted',
        localSafe: true,
      };
      this.db.prepare(`INSERT INTO local_scan_events (scan_id, consignment_id, box_no, sku_id, barcode, qty_delta, result, payload_json, captured_at, sequence_no)
        VALUES (?, ?, ?, ?, ?, ?, 'accepted', ?, ?, ?)`)
        .run(id, cid, number, sku.sku_id, code, delta, JSON.stringify(payload), at, sequenceNo || null);
      return payload;
    });
    const result = tx();
    if (!result.ok) this.logger?.warn('scan.rejected', { consignmentId: cid, boxNo: number, result: result.result });
    // Accepted events already have a FULL-durability SQLite audit record.
    // Avoid a second synchronous file write on every physical barcode.
    return result;
  }

  closeBox({ consignmentId, boxNo, operationId, items, weight = null, weightUnit = 'KG', weightProof = null, video = null }) {
    const cid = clean(consignmentId);
    const number = clean(boxNo);
    const op = clean(operationId) || `${this.ensureStation().station_id}:${cid}:${number}:${crypto.randomUUID()}`;
    const itemsBySku = new Map();
    for (const item of (Array.isArray(items) ? items : [])) {
      const skuId = clean(item.skuId);
      const qty = positiveQty(item.qty);
      if (!skuId || !qty) continue;
      const previous = itemsBySku.get(skuId);
      itemsBySku.set(skuId, previous ? { ...previous, qty: previous.qty + qty } : {
        skuId,
        barcode: item.barcode || item.marketplaceBarcode || null,
        marketplaceSku: item.marketplaceSku || null,
        internalSku: item.internalSku || item.name || null,
        qty,
      });
    }
    const normalizedItems = [...itemsBySku.values()];
    if (!cid || !number || !normalizedItems.length) throw new Error('Cannot close an empty local box');
    const at = nowIso();
    const boxId = idForBox(cid, number);
    const tx = this.db.transaction(() => {
      const existingBox = this.db.prepare('SELECT * FROM local_boxes WHERE box_id = ?').get(boxId);
      if (existingBox && existingBox.state !== BOX_STATES.OPEN) {
        if (existingBox.operation_id === op) {
          const original = parseJson(this.db.prepare('SELECT payload_json FROM sync_outbox WHERE job_id = ?').get(`box:${op}`)?.payload_json, {});
          const amounts = (list) => JSON.stringify((list || []).map((item) => [item.skuId, item.qty]).sort(([a], [b]) => a.localeCompare(b)));
          if (amounts(original.items) !== amounts(normalizedItems) || original.weight !== (weight == null ? null : Number(weight)) || original.weightUnit !== (weightUnit || 'KG') || existingBox.video_id !== (video?.videoId || null) || existingBox.weight_proof_id !== (weightProof?.proofId || null)) throw new Error('Operation ID was reused with changed box contents');
          return { boxId, operationId: op, state: existingBox.state, localSafe: true, idempotentReplay: true };
        }
        throw new Error('This box is already closed with a different operation');
      }
      if (!this.db.prepare('SELECT 1 FROM local_consignments WHERE consignment_id = ?').get(cid)) throw new Error('Consignment snapshot is not cached locally');
      if (!this.db.prepare('SELECT 1 FROM local_boxes WHERE box_id = ?').get(boxId)) {
        this.db.prepare(`INSERT INTO local_boxes (box_id, consignment_id, box_no, state, video_state, created_at, updated_at)
          VALUES (?, ?, ?, 'OPEN', 'OPEN', ?, ?)`)
          .run(boxId, cid, number, at, at);
      }
      const otherTotals = new Map(this.db.prepare(`SELECT lbi.sku_id, COALESCE(SUM(lbi.qty), 0) AS qty
        FROM local_box_items lbi
        JOIN local_boxes lb ON lb.box_id = lbi.box_id
        WHERE lb.consignment_id = ? AND lbi.box_id <> ?
        GROUP BY lbi.sku_id`).all(cid, boxId).map((row) => [row.sku_id, Number(row.qty) || 0]));
      for (const item of normalizedItems) {
        const sku = this.db.prepare('SELECT required_qty FROM local_skus WHERE consignment_id = ? AND sku_id = ?').get(cid, item.skuId);
        if (!sku) {
          const error = new Error(`SKU ${item.skuId} is not present in the local snapshot`);
          error.code = 'LOCAL_BOX_ITEM_NOT_IN_SNAPSHOT';
          throw error;
        }
        if ((otherTotals.get(item.skuId) || 0) + item.qty > Number(sku.required_qty)) {
          const error = new Error(`Box quantity exceeds required quantity for SKU ${item.skuId}`);
          error.code = 'LOCAL_BOX_OVER_LIMIT';
          throw error;
        }
      }
      // The renderer snapshot must agree with the durable scan ledger. Never
      // replace accepted scans with a stale React snapshot at close time.
      const durableItems = this.db.prepare('SELECT sku_id, qty FROM local_box_items WHERE box_id = ?').all(boxId);
      if (durableItems.length !== normalizedItems.length || durableItems.some((item) => itemsBySku.get(item.sku_id)?.qty !== item.qty)) {
        throw new Error('Box changed while saving. Wait for scans to settle and retry.');
      }
      if (weight != null && (!Number.isFinite(Number(weight)) || Number(weight) <= 0)) throw new Error('Weight must be a positive number');
      this.db.prepare('DELETE FROM local_box_items WHERE box_id = ?').run(boxId);
      for (const item of normalizedItems) {
        this.db.prepare(`INSERT INTO local_box_items (box_id, sku_id, barcode, marketplace_sku, internal_sku, qty) VALUES (?, ?, ?, ?, ?, ?)`)
          .run(boxId, item.skuId, item.barcode, item.marketplaceSku, item.internalSku, item.qty);
      }
      if (weightProof?.proofId) {
        this.db.prepare(`INSERT INTO local_weight_proofs (proof_id, consignment_id, box_no, local_path, size_bytes, sha256, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(proof_id) DO UPDATE SET local_path = excluded.local_path, size_bytes = excluded.size_bytes, sha256 = excluded.sha256`)
          .run(weightProof.proofId, cid, number, weightProof.localPath, Number(weightProof.sizeBytes) || 0, weightProof.sha256 || null, at);
      }
      if (video?.videoId) {
        this.db.prepare(`INSERT INTO local_videos (video_id, consignment_id, box_no, local_path, size_bytes, sha256, mime_type, state, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'VIDEO_QUEUED', ?, ?)
          ON CONFLICT(video_id) DO UPDATE SET local_path = excluded.local_path, size_bytes = excluded.size_bytes, sha256 = excluded.sha256, updated_at = excluded.updated_at`)
          .run(video.videoId, cid, number, video.localPath, Number(video.sizeBytes) || 0, video.sha256 || null, video.mimeType || 'video/webm', at, at);
      }
      const state = this.db.prepare('SELECT state FROM local_boxes WHERE box_id = ?').get(boxId)?.state || BOX_STATES.OPEN;
      transitionState(state, BOX_STATES.CLOSED_LOCAL);
      this.db.prepare(`UPDATE local_boxes SET state = 'QUEUED', operation_id = ?, total_qty = ?, weight = ?, weight_unit = ?, weight_proof_id = ?, weight_proof_path = ?, video_id = ?, video_state = ?, closed_at = ?, updated_at = ? WHERE box_id = ?`)
        .run(op, normalizedItems.reduce((sum, item) => sum + item.qty, 0), weight == null ? null : Number(weight), weightUnit || 'KG', weightProof?.proofId || null, weightProof?.localPath || null, video?.videoId || null, video?.videoId ? BOX_STATES.VIDEO_QUEUED : 'MISSING', at, at, boxId);
      this.recomputeSkuTotals(cid);
      const boxPayload = { consignmentId: cid, boxNo: number, operationId: op, weight: weight == null ? null : Number(weight), weightUnit: weightUnit || 'KG', weightImageId: null, weightProof: weightProof || null, items: normalizedItems };
      this.db.prepare(`INSERT INTO sync_outbox (job_id, kind, entity_id, consignment_id, payload_json, state, created_at, updated_at)
        VALUES (?, 'box_commit', ?, ?, ?, 'queued', ?, ?)
        ON CONFLICT(job_id) DO UPDATE SET payload_json = excluded.payload_json, state = CASE WHEN sync_outbox.state = 'done' THEN sync_outbox.state ELSE 'queued' END, updated_at = excluded.updated_at`)
        .run(`box:${op}`, op, cid, JSON.stringify(boxPayload), at, at);
      if (video?.videoId) {
        this.db.prepare(`INSERT INTO sync_outbox (job_id, kind, entity_id, consignment_id, payload_json, state, created_at, updated_at)
          VALUES (?, 'video_upload', ?, ?, ?, 'queued', ?, ?)
          ON CONFLICT(job_id) DO NOTHING`)
          .run(`video:${video.videoId}`, video.videoId, cid, JSON.stringify({ videoId: video.videoId, boxNo: number }), at, at);
      }
      return { boxId, operationId: op, state: BOX_STATES.QUEUED, localSafe: true };
    });
    const result = tx();
    this.logger?.info('box.closed_local', { consignmentId: cid, boxNo: number, operationId: op });
    return result;
  }

  recomputeSkuTotals(consignmentId) {
    const cid = clean(consignmentId);
    const skus = this.db.prepare('SELECT sku_id, required_qty FROM local_skus WHERE consignment_id = ?').all(cid);
    const sum = this.db.prepare('SELECT COALESCE(SUM(qty), 0) AS qty FROM local_box_items WHERE sku_id = ? AND box_id IN (SELECT box_id FROM local_boxes WHERE consignment_id = ?)');
    const update = this.db.prepare('UPDATE local_skus SET packed_qty = ?, status = ? WHERE consignment_id = ? AND sku_id = ?');
    for (const sku of skus) {
      const packed = Number(sum.get(sku.sku_id, cid).qty) || 0;
      update.run(packed, packed >= sku.required_qty && sku.required_qty > 0 ? 'completed' : 'pending', cid, sku.sku_id);
    }
  }

  undoScan({ consignmentId, boxNo, skuId, eventId }) {
    return this.db.transaction(() => {
      const old = this.db.prepare('SELECT * FROM local_scan_events WHERE scan_id = ?').get(eventId);
      if (old) {
        if (old.consignment_id !== consignmentId || old.box_no !== boxNo || old.sku_id !== skuId || old.qty_delta !== -1) throw new Error('Undo ID already used');
        return { ok: true, idempotentReplay: true };
      }
      const boxId = idForBox(consignmentId, boxNo);
      if (this.db.prepare('SELECT state FROM local_boxes WHERE box_id = ?').get(boxId)?.state !== 'OPEN') throw new Error('Only an open box can be corrected locally');
      const item = this.db.prepare('SELECT * FROM local_box_items WHERE box_id = ? AND sku_id = ?').get(boxId, skuId);
      if (!item) throw new Error('This item is no longer in the box');
      if (item.qty === 1) this.db.prepare('DELETE FROM local_box_items WHERE box_id = ? AND sku_id = ?').run(boxId, skuId);
      else this.db.prepare('UPDATE local_box_items SET qty = qty - 1 WHERE box_id = ? AND sku_id = ?').run(boxId, skuId);
      this.db.prepare(`INSERT INTO local_scan_events (scan_id, consignment_id, box_no, sku_id, barcode, qty_delta, result, payload_json, captured_at)
        VALUES (?, ?, ?, ?, ?, -1, 'undo', '{}', ?)`).run(eventId, consignmentId, boxNo, skuId, item.barcode || '', nowIso());
      this.recomputeSkuTotals(consignmentId);
      return { ok: true, localSafe: true };
    })();
  }

  discardEmptyBox({ consignmentId, boxNo }) {
    const boxId = idForBox(consignmentId, boxNo);
    this.db.prepare(`DELETE FROM local_boxes WHERE box_id = ? AND state = 'OPEN'
      AND NOT EXISTS (SELECT 1 FROM local_box_items WHERE box_id = ?)` ).run(boxId, boxId);
    return { ok: true };
  }

  claimNextOutbox() {
    const at = nowIso();
    const tx = this.db.transaction(() => {
      // Keep box commit ahead of its video upload when both jobs share an
      // event timestamp. rowid is the insertion-order tie breaker in SQLite.
      // A delayed/failed predecessor blocks later work for this consignment,
      // including its video. Other consignments can still make progress.
      const row = this.db.prepare(`SELECT job.* FROM sync_outbox job
        WHERE job.state IN ('queued', 'retry') AND (job.next_attempt_at IS NULL OR job.next_attempt_at <= ?)
        AND NOT EXISTS (SELECT 1 FROM sync_outbox earlier WHERE earlier.consignment_id = job.consignment_id
          AND earlier.rowid < job.rowid AND earlier.state <> 'done')
        ORDER BY job.created_at, job.rowid LIMIT 1`).get(at);
      if (!row) return null;
      this.db.prepare(`UPDATE sync_outbox SET state = 'working', attempts = attempts + 1, updated_at = ? WHERE job_id = ? AND state IN ('queued', 'retry')`).run(at, row.job_id);
      this.db.prepare('INSERT INTO sync_attempts (job_id, started_at) VALUES (?, ?)').run(row.job_id, at);
      return { ...row, state: 'working', attempts: row.attempts + 1, payload: parseJson(row.payload_json, {}) };
    });
    return tx();
  }

  markOutboxDone(jobId) {
    const at = nowIso();
    this.db.prepare(`UPDATE sync_outbox SET state = 'done', last_error = NULL, updated_at = ? WHERE job_id = ?`).run(at, jobId);
    this.db.prepare(`UPDATE sync_attempts SET finished_at = ?, outcome = 'done' WHERE id = (SELECT id FROM sync_attempts WHERE job_id = ? ORDER BY id DESC LIMIT 1)`).run(at, jobId);
  }

  markOutboxRetry(jobId, error, delayMs, failed = false) {
    const at = nowIso();
    const next = new Date(Date.now() + delayMs).toISOString();
    this.db.prepare(`UPDATE sync_outbox SET state = ?, last_error = ?, next_attempt_at = ?, updated_at = ? WHERE job_id = ?`)
      .run(failed ? 'failed' : 'retry', String(error || 'Sync failed').slice(0, 1000), next, at, jobId);
    this.db.prepare(`UPDATE sync_attempts SET finished_at = ?, outcome = ?, error = ? WHERE id = (SELECT id FROM sync_attempts WHERE job_id = ? ORDER BY id DESC LIMIT 1)`)
      .run(at, failed ? 'failed' : 'retry', String(error || '').slice(0, 1000), jobId);
  }

  updateOutboxPayload(jobId, payload) {
    this.db.prepare('UPDATE sync_outbox SET payload_json = ?, updated_at = ? WHERE job_id = ?').run(JSON.stringify(payload), nowIso(), jobId);
  }

  markBoxDataSynced(consignmentId, boxNo) {
    this.db.prepare(`UPDATE local_boxes SET state = 'DATA_SYNCED', video_state = CASE WHEN video_id IS NULL THEN 'MISSING' ELSE 'VIDEO_QUEUED' END, updated_at = ? WHERE consignment_id = ? AND box_no = ?`)
      .run(nowIso(), clean(consignmentId), clean(boxNo));
  }

  markVideoSynced(videoId, storagePath) {
    const at = nowIso();
    this.db.prepare(`UPDATE local_videos SET state = 'SYNCED', storage_path = ?, verified = 1, updated_at = ? WHERE video_id = ?`).run(storagePath || null, at, videoId);
    this.db.prepare(`UPDATE local_boxes SET state = CASE WHEN state = 'DATA_SYNCED' THEN 'SYNCED' ELSE state END, video_state = 'SYNCED', updated_at = ? WHERE video_id = ?`).run(at, videoId);
  }

  getVideo(videoId) { return this.db.prepare('SELECT * FROM local_videos WHERE video_id = ?').get(videoId) || null; }

  getStatus(consignmentId = null, userId = null) {
    const clauses = [];
    const params = [];
    if (consignmentId) { clauses.push('consignment_id = ?'); params.push(clean(consignmentId)); }
    if (userId) { clauses.push("consignment_id IN (SELECT consignment_id FROM local_consignments WHERE json_extract(snapshot_json, '$.localSnapshotUserId') = ?)"); params.push(userId); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const boxes = this.db.prepare(`SELECT * FROM local_boxes ${where} ORDER BY updated_at`).all(...params);
    const summary = summarizeBoxes(boxes);
    const jobs = this.db.prepare(`SELECT kind, state, count(*) AS count FROM sync_outbox ${where} GROUP BY kind, state`).all(...params);
    const failed = jobs.filter((job) => job.state === 'failed').reduce((sum, job) => sum + Number(job.count), 0);
    return {
      ...summary,
      pendingJobs: jobs.filter((job) => job.state !== 'done').reduce((sum, job) => sum + Number(job.count), 0),
      failedJobs: failed,
      jobs,
      boxes: boxes.map((box) => ({ ...box })),
    };
  }

  getFinishReadiness(consignmentId) {
    const cid = clean(consignmentId);
    const openBoxes = this.db.prepare(`SELECT box_no FROM local_boxes WHERE consignment_id = ? AND state = 'OPEN'`).all(cid).map((row) => row.box_no);
    const pendingBoxes = this.db.prepare(`SELECT box_no FROM local_boxes WHERE consignment_id = ? AND state NOT IN ('DATA_SYNCED', 'SYNCED')`).all(cid).map((row) => row.box_no);
    const missingVideos = this.db.prepare(`SELECT box_no FROM local_boxes WHERE consignment_id = ? AND video_state <> 'SYNCED'`).all(cid).map((row) => row.box_no);
    const pendingJobs = this.db.prepare(`SELECT count(*) AS count FROM sync_outbox WHERE consignment_id = ? AND state <> 'done'`).get(cid).count;
    const quantities = this.db.prepare(`SELECT count(*) AS count FROM local_skus WHERE consignment_id = ? AND packed_qty <> required_qty`).get(cid).count;
    const overScanned = this.db.prepare(`SELECT count(*) AS count FROM local_skus WHERE consignment_id = ? AND packed_qty > required_qty`).get(cid).count;
    const exists = this.db.prepare('SELECT 1 FROM local_consignments WHERE consignment_id = ?').get(cid);
    return {
      ready: Boolean(exists) && openBoxes.length === 0 && pendingBoxes.length === 0 && missingVideos.length === 0 && Number(pendingJobs) === 0 && Number(quantities) === 0,
      openBoxes,
      pendingBoxes,
      missingVideos,
      pendingJobs: Number(pendingJobs) || 0,
      overScanned: Number(overScanned) || 0,
      incompleteSkus: Number(quantities) || 0,
    };
  }
}

function openDatabase(dbPath, { logger, stationId, stationName, warehouse } = {}) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new SqliteAdapter(new DatabaseSync(dbPath));
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  for (const migration of MIGRATIONS) {
    if (!db.prepare('SELECT 1 FROM schema_migrations WHERE id = ?').get(migration.id)) {
      const tx = db.transaction(() => {
        db.exec(migration.sql);
        db.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)').run(migration.id, nowIso());
      });
      tx();
    }
  }
  const database = new DesktopDatabase(db, dbPath, logger);
  // A process may exit after claiming a job but before recording its result.
  // Immutable IDs and upload checkpoints make replay safe after restart.
  db.prepare("UPDATE sync_outbox SET state = 'retry', next_attempt_at = NULL WHERE state = 'working'").run();
  database.ensureStation({ stationId, stationName, warehouse });
  return database;
}

module.exports = { MIGRATIONS, DesktopDatabase, openDatabase };
