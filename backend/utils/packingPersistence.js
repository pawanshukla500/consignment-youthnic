const { getPool, pgEnabled } = require('../config/database');
const { getMarketplaceBarcode } = require('./skuIdentity');

function withId(id, data) {
  return { ...data, id };
}

function cleanKey(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function indexByValue(map, value, sku) {
  const key = cleanKey(value);
  if (!key || map.has(key)) return;
  map.set(key, sku);
}

function findSkuForItem(item, indexes) {
  const skuId = cleanKey(item?.skuId);
  if (skuId && indexes.bySkuId.has(skuId)) return indexes.bySkuId.get(skuId);

  const marketplaceBarcode = cleanKey(getMarketplaceBarcode(item));
  if (marketplaceBarcode && indexes.byMarketplaceBarcode.has(marketplaceBarcode)) {
    return indexes.byMarketplaceBarcode.get(marketplaceBarcode);
  }

  const marketplaceSku = cleanKey(item?.marketplaceSku);
  if (marketplaceSku && indexes.byMarketplaceSku.has(marketplaceSku)) return indexes.byMarketplaceSku.get(marketplaceSku);

  const internalSku = cleanKey(item?.internalSku || item?.name);
  if (internalSku && indexes.byInternalSku.has(internalSku)) return indexes.byInternalSku.get(internalSku);

  const barcode = cleanKey(item?.barcode);
  if (barcode && indexes.byBarcode.has(barcode)) return indexes.byBarcode.get(barcode);

  return null;
}

async function upsertDocument(client, collection, id, data) {
  const { rows } = await client.query(
    `INSERT INTO documents (collection, id, data, updated_at)
     VALUES ($1, $2, $3::jsonb, now())
     ON CONFLICT (collection, id)
     DO UPDATE SET data = documents.data || EXCLUDED.data, updated_at = now()
     RETURNING data`,
    [collection, id, JSON.stringify(withId(id, data))]
  );
  return rows[0].data;
}

async function saveBoxWithPostgresTransaction({
  consignmentId,
  boxId,
  boxData,
  userId,
  timestamp,
  getStatusUpdates,
  auditLog,
  productivityEvent,
}) {
  if (!pgEnabled()) {
    const error = new Error('Postgres packing transaction requested while Postgres is disabled.');
    error.statusCode = 503;
    error.code = 'DATASTORE_UNAVAILABLE';
    throw error;
  }

  const client = await getPool().connect();

  try {
    await client.query('BEGIN');

    const { rows: consignmentRows } = await client.query(
      `SELECT data
       FROM documents
       WHERE collection = 'consignments' AND id = $1
       FOR UPDATE`,
      [consignmentId]
    );

    if (!consignmentRows.length) {
      const error = new Error('Consignment not found');
      error.statusCode = 404;
      throw error;
    }

    const consignment = consignmentRows[0].data;
    await upsertDocument(client, 'boxes', boxId, boxData);

    const existingBoxIds = Array.isArray(consignment.boxIds) ? consignment.boxIds : [];
    const boxIdsForRead = Array.from(new Set([...existingBoxIds, boxId]));
    const { rows: boxRows } = await client.query(
      `SELECT id, data
       FROM documents
       WHERE collection = 'boxes'
         AND (id = ANY($1::text[]) OR data->>'consignmentId' = $2)
       FOR UPDATE`,
      [boxIdsForRead, consignmentId]
    );

    const boxes = boxRows.map((row) => ({ ...row.data, id: row.data.id || row.id }));
    const skuIds = Array.isArray(consignment.skuIds) ? consignment.skuIds : [];
    const { rows: skuRows } = skuIds.length
      ? await client.query(
        `SELECT id, data
         FROM documents
         WHERE collection = 'skus' AND id = ANY($1::text[])
         FOR UPDATE`,
        [skuIds]
      )
      : { rows: [] };

    const skuMap = new Map(skuRows.map((row) => [row.id, { ...row.data, id: row.data.id || row.id }]));
    const skus = skuIds.map((skuId) => skuMap.get(skuId)).filter(Boolean);
    const indexes = {
      bySkuId: new Map(),
      byMarketplaceBarcode: new Map(),
      byMarketplaceSku: new Map(),
      byInternalSku: new Map(),
      byBarcode: new Map(),
    };

    for (const sku of skus) {
      indexByValue(indexes.bySkuId, sku.id, sku);
      indexByValue(indexes.byMarketplaceBarcode, getMarketplaceBarcode(sku), sku);
      indexByValue(indexes.byMarketplaceSku, sku.marketplaceSku, sku);
      indexByValue(indexes.byInternalSku, sku.internalSku, sku);
      indexByValue(indexes.byBarcode, sku.barcode, sku);
    }

    const boxQuantitiesBySku = new Map();
    for (const box of boxes) {
      const boxNo = cleanKey(box.boxNo || box.box_no || box.id);
      if (!boxNo) continue;
      for (const item of box.items || []) {
        const qty = toNumber(item.qty ?? item.quantity);
        if (qty <= 0) continue;
        const sku = findSkuForItem(item, indexes);
        if (!sku) continue;

        if (!boxQuantitiesBySku.has(sku.id)) boxQuantitiesBySku.set(sku.id, {});
        const boxQuantities = boxQuantitiesBySku.get(sku.id);
        boxQuantities[boxNo] = (boxQuantities[boxNo] || 0) + qty;
      }
    }

    const skuResults = [];
    for (const sku of skus) {
      const requiredQty = toNumber(sku.requiredQty);
      const boxQuantities = boxQuantitiesBySku.get(sku.id) || {};
      const packedQty = Object.values(boxQuantities).reduce((sum, qty) => sum + toNumber(qty), 0);
      if (packedQty > requiredQty) {
        const error = new Error(
          `Cannot save box: ${sku.internalSku || sku.marketplaceSku || sku.id} is over-scanned (${packedQty}/${requiredQty}).`
        );
        error.statusCode = 409;
        error.code = 'PACKING_OVER_SCAN';
        throw error;
      }
      const status = requiredQty > 0 && packedQty >= requiredQty ? 'completed' : 'pending';
      const updatedSku = await upsertDocument(client, 'skus', sku.id, {
        packedQty,
        boxQuantities,
        status,
        updatedAt: timestamp,
      });
      skuResults.push({
        id: sku.id,
        requiredQty,
        packedQty,
        status,
        boxQuantities,
        data: updatedSku,
      });
    }

    const totalRequiredQty = skuResults.reduce((sum, sku) => sum + sku.requiredQty, 0);
    const totalPackedQty = skuResults.reduce((sum, sku) => sum + sku.packedQty, 0);
    const allCompleted = skuResults.length > 0 && skuResults.every(
      (sku) => sku.requiredQty > 0 && sku.packedQty >= sku.requiredQty
    );
    const statusUpdates = getStatusUpdates
      ? getStatusUpdates({ consignment, allCompleted, totalPackedQty, totalRequiredQty, timestamp })
      : null;
    const finalStatusUpdates = statusUpdates || {
      status: allCompleted ? 'completed' : totalPackedQty > 0 ? 'in_progress' : 'pending',
      updatedAt: timestamp,
    };
    if (!finalStatusUpdates.updatedAt) finalStatusUpdates.updatedAt = timestamp;

    const boxMap = new Map(boxes.map(b => [b.boxNo || b.id || b.box_no, b]));
    if (boxData) {
      boxMap.set(String(boxData.boxNo), boxData);
    }
    const totalWeight = Array.from(boxMap.values()).reduce((sum, b) => sum + toNumber(b.weight || 0), 0);

    const mergedBoxIds = Array.from(new Set([...boxIdsForRead, ...boxes.map((box) => box.id).filter(Boolean)]));
    const updatedConsignment = await upsertDocument(client, 'consignments', consignmentId, {
      boxIds: mergedBoxIds,
      totalPackedQty,
      totalRequiredQty,
      totalWeight,
      weightUnit: boxData?.weightUnit || Array.from(boxMap.values()).find(b => b.weightUnit)?.weightUnit || 'KG',
      ...finalStatusUpdates,
    });

    if (auditLog?.id) {
      await upsertDocument(client, 'auditLogs', auditLog.id, auditLog);
    }
    if (productivityEvent?.id) {
      await upsertDocument(client, 'productivity', productivityEvent.id, productivityEvent);
    }

    await client.query('COMMIT');

    return {
      consignment: updatedConsignment,
      box: boxData,
      boxIds: mergedBoxIds,
      skuResults,
      totalPackedQty,
      totalRequiredQty,
      allCompleted,
      statusUpdates: finalStatusUpdates,
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (!error.statusCode) {
      const wrapped = new Error('Durable datastore unavailable while trying to save packing box.');
      wrapped.statusCode = 503;
      wrapped.code = 'DATASTORE_UNAVAILABLE';
      wrapped.cause = error;
      throw wrapped;
    }
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  saveBoxWithPostgresTransaction,
};
