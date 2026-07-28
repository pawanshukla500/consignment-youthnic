/**
 * PostgreSQL-backed implementation of the firestoreHelpers interface.
 * All documents live in the JSONB `documents(collection, id, data)` table.
 * setDocument uses jsonb `||` for shallow-merge (mirrors Firestore { merge: true }).
 */
const { getPool } = require('../config/database');
const { sanitizeUserForStorage, SENSITIVE_USER_KEYS } = require('./sanitizeUser');

const productivityTimestampExpr = () =>
  `COALESCE(NULLIF(data->>'timestamp', ''), NULLIF(data->>'createdAt', ''))::timestamptz`;

// Always ensure the doc carries its own id
const withId = (id, data) => ({ ...data, id });

const isValidDocument = (doc) => Boolean(doc && typeof doc === 'object' && doc.id);

/** jsonb `-` chain that removes auth secrets even when omitted from a shallow merge. */
const USER_SECRET_STRIP_SQL = SENSITIVE_USER_KEYS.map((key) => `- '${key.replace(/'/g, "''")}'`).join(' ');

function prepareDocumentPayload(collection, id, data) {
  const docData = withId(id, data);
  if (collection === 'users') {
    return sanitizeUserForStorage(docData);
  }
  return docData;
}

const pgHelpers = {
  async getCollection(collection) {
    const { rows } = await getPool().query(
      'SELECT data FROM documents WHERE collection = $1', [collection]
    );
    const docs = rows.map((row) => row.data).filter(isValidDocument);
    return collection === 'users' ? docs.map((doc) => sanitizeUserForStorage(doc)) : docs;
  },

  async getDocument(collection, id, options = {}) {
    const runner = options.client || getPool();
    const { rows } = await runner.query(
      'SELECT data FROM documents WHERE collection = $1 AND id = $2', [collection, id]
    );
    if (!rows.length) return null;
    const doc = rows[0].data;
    return collection === 'users' ? sanitizeUserForStorage(doc) : doc;
  },

  async setDocument(collection, id, data, options = {}) {
    const docData = prepareDocumentPayload(collection, id, data);
    // Shallow-merge on conflict (existing.data || new.data → new wins per top-level key).
    // For users, always strip auth secrets from the merged result so omitted keys cannot linger.
    const mergeExpr = collection === 'users'
      ? `(documents.data || EXCLUDED.data) ${USER_SECRET_STRIP_SQL}`
      : 'documents.data || EXCLUDED.data';
    const insertExpr = collection === 'users'
      ? `($3::jsonb) ${USER_SECRET_STRIP_SQL}`
      : '$3::jsonb';
    const runner = options.client || getPool();
    const { rows } = await runner.query(
      `INSERT INTO documents (collection, id, data, updated_at)
       VALUES ($1, $2, ${insertExpr}, now())
       ON CONFLICT (collection, id)
       DO UPDATE SET data = ${mergeExpr}, updated_at = now()
       RETURNING data`,
      [collection, id, JSON.stringify(docData)]
    );
    const saved = rows[0].data;
    return collection === 'users' ? sanitizeUserForStorage(saved) : saved;
  },

  async deleteDocument(collection, id) {
    await getPool().query('DELETE FROM documents WHERE collection = $1 AND id = $2', [collection, id]);
    return true;
  },

  async queryCollection(collection, fieldPath, opStr, value) {
    let docs;
    if (opStr === '==') {
      const { rows } = await getPool().query(
        `SELECT data FROM documents WHERE collection = $1 AND data->>$2 = $3`,
        [collection, fieldPath, String(value)]
      );
      docs = rows.map((row) => row.data).filter(isValidDocument);
    } else if (opStr === 'array-contains') {
      const { rows } = await getPool().query(
        `SELECT data FROM documents WHERE collection = $1 AND (data->$2) @> $3::jsonb`,
        [collection, fieldPath, JSON.stringify(value)]
      );
      docs = rows.map((row) => row.data).filter(isValidDocument);
    } else {
      // Fallback: unsupported operator — do not return entire collection
      throw new Error(`Unsupported query operator: ${opStr}`);
    }
    return collection === 'users' ? docs.map((doc) => sanitizeUserForStorage(doc)) : docs;
  },

  async batchSet(collection, items) {
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      for (const [id, data] of items) {
        const docData = prepareDocumentPayload(collection, id, data);
        const mergeExpr = collection === 'users'
          ? `(documents.data || EXCLUDED.data) ${USER_SECRET_STRIP_SQL}`
          : 'documents.data || EXCLUDED.data';
        const insertExpr = collection === 'users'
          ? `($3::jsonb) ${USER_SECRET_STRIP_SQL}`
          : '$3::jsonb';
        await client.query(
          `INSERT INTO documents (collection, id, data, updated_at)
           VALUES ($1, $2, ${insertExpr}, now())
           ON CONFLICT (collection, id)
           DO UPDATE SET data = ${mergeExpr}, updated_at = now()`,
          [collection, id, JSON.stringify(docData)]
        );
      }
      await client.query('COMMIT');
      return true;
    } catch (e) {
      await client.query('ROLLBACK');
      console.error('[Postgres] batchSet failed:', e.message);
      throw e;
    } finally {
      client.release();
    }
  },

  async batchDelete(collection, ids) {
    if (!ids || ids.length === 0) return true;
    await getPool().query('DELETE FROM documents WHERE collection = $1 AND id = ANY($2)', [collection, ids]);
    return true;
  },

  async batchSetMulti(items) {
    // items = [[collection, id, data], ...]
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      for (const [collection, id, data] of items) {
        await client.query(
          `INSERT INTO documents (collection, id, data, updated_at)
           VALUES ($1, $2, $3::jsonb, now())
           ON CONFLICT (collection, id)
           DO UPDATE SET data = documents.data || EXCLUDED.data, updated_at = now()`,
          [collection, id, JSON.stringify(withId(id, data))]
        );
      }
      await client.query('COMMIT');
      return true;
    } catch (e) {
      await client.query('ROLLBACK');
      console.error('[Postgres] batchSetMulti failed:', e.message);
      throw e;
    } finally {
      client.release();
    }
  },

  async batchCreateMulti(items) {
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      for (const [collection, id, data] of items) {
        const { rowCount } = await client.query(
          `INSERT INTO documents (collection, id, data, updated_at)
           VALUES ($1, $2, $3::jsonb, now())
           ON CONFLICT (collection, id) DO NOTHING`,
          [collection, id, JSON.stringify(withId(id, data))]
        );
        if (rowCount === 0) {
          const error = new Error(`${collection}/${id} already exists`);
          error.code = 'DOCUMENT_ALREADY_EXISTS';
          error.statusCode = 409;
          throw error;
        }
      }
      await client.query('COMMIT');
      return true;
    } catch (e) {
      await client.query('ROLLBACK');
      console.error('[Postgres] batchCreateMulti failed:', e.message);
      throw e;
    } finally {
      client.release();
    }
  },

  async batchGetDocuments(collection, ids) {
    if (!ids?.length) return [];
    const { rows } = await getPool().query(
      'SELECT data FROM documents WHERE collection = $1 AND id = ANY($2::text[])',
      [collection, ids]
    );
    const map = new Map(rows.map((r) => [r.data.id, r.data]));
    return ids.map((id) => map.get(id)).filter(Boolean);
  },

  async getConsignmentsUpdatedSince(sinceIso) {
    const since = sinceIso || '1970-01-01T00:00:00.000Z';
    const { rows } = await getPool().query(
      `SELECT data FROM documents
       WHERE collection = 'consignments'
         AND updated_at > $1::timestamptz
       ORDER BY updated_at ASC
       LIMIT 500`,
      [since]
    );
    return rows.map((r) => r.data);
  },

  async queryConsignmentsPaginated({
    statuses,
    marketplaceId,
    search,
    sort,
    offset = 0,
    limit = 50,
    includeArchived = false,
    archivedOnly = false,
    shortPackOnly = false,
  }) {
    const params = [];
    let n = 1;
    let whereClauses = ["collection = 'consignments'"];

    if (statuses?.length) {
      whereClauses.push(`data->>'status' = ANY($${n++}::text[])`);
      params.push(statuses);
    }
    if (marketplaceId) {
      whereClauses.push(`data->>'marketplaceId' = $${n++}`);
      params.push(marketplaceId);
    }
    if (archivedOnly) {
      whereClauses.push(`(
        coalesce(data->>'operationalStatus','') = 'archived'
        OR coalesce(data->>'isArchived','') = 'true'
      )`);
    } else if (!includeArchived) {
      whereClauses.push(`(
        coalesce(data->>'operationalStatus','') <> 'archived'
        AND coalesce(data->>'isArchived','') <> 'true'
      )`);
    }
    if (shortPackOnly) {
      // Confirmed packing short OR completed packing with remaining short qty.
      whereClauses.push(`(
        coalesce((data->'packingCompletion'->>'shortQty')::int, 0) > 0
        OR (
          coalesce(data->>'status','') = 'completed'
          AND coalesce((data->>'totalRequiredQty')::int, 0)
            > coalesce((data->>'totalPackedQty')::int, 0)
        )
      )`);
    }
    if (search) {
      const term = `%${search.toLowerCase()}%`;
      whereClauses.push(`(
        lower(data->>'id') LIKE $${n}
        OR lower(coalesce(data->>'shipmentNo','')) LIKE $${n}
        OR lower(coalesce(data->>'internalShipmentNo','')) LIKE $${n}
        OR lower(coalesce(data->>'name','')) LIKE $${n}
        OR lower(coalesce(data->>'docketNo','')) LIKE $${n}
        OR lower(coalesce(data->>'forwardInvoiceNo','')) LIKE $${n}
        OR lower(coalesce(data->'invoice'->>'number','')) LIKE $${n}
      )`);
      params.push(term);
      n++;
    }

    const whereSql = whereClauses.length ? 'WHERE ' + whereClauses.join(' AND ') : '';

    const countSql = `SELECT COUNT(*)::int AS total FROM documents ${whereSql}`;
    const { rows: countRows } = await getPool().query(countSql, params);
    const total = countRows[0]?.total || 0;

    let sql = '';
    if (sort === 'dispatch') {
      sql = `
        WITH enriched AS (
          SELECT 
            id,
            data,
            updated_at,
            CASE 
              WHEN COALESCE((data->>'totalRequiredQty')::int, 0) <= 0 THEN 
                CASE WHEN data->>'status' = 'completed' THEN 100 ELSE 0 END
              ELSE 
                LEAST(100, ROUND((COALESCE((data->>'totalPackedQty')::int, 0)::float / (data->>'totalRequiredQty')::int::float) * 100))
            END AS packing_percent,
            CASE 
              WHEN COALESCE(NULLIF(data->>'requiredDispatchDate',''), NULLIF(data->>'scheduledDispatchDate','')) IS NULL THEN NULL
              ELSE (COALESCE(NULLIF(data->>'requiredDispatchDate',''), NULLIF(data->>'scheduledDispatchDate',''))::date - CURRENT_DATE)
            END AS days_until
          FROM documents
          ${whereSql}
        ),
        scored AS (
          SELECT 
            id,
            data,
            updated_at,
            days_until,
            CASE
              WHEN data->>'status' = 'completed' THEN 500
              WHEN days_until IS NULL THEN 500
              WHEN days_until < 0 OR (days_until <= 2 AND packing_percent < 100) THEN -2000
              WHEN (days_until <= 4 AND packing_percent < 80) OR (days_until <= 3 AND packing_percent < 100) THEN -500
              WHEN days_until <= 7 OR (days_until <= 5 AND packing_percent < 50) THEN 50
              ELSE 500
            END::float + COALESCE(days_until, 0)::float + (100.0 - packing_percent::float) * 0.05 AS criticality_sort
          FROM enriched
        )
        SELECT data FROM scored
        ORDER BY 
          criticality_sort ASC, 
          COALESCE(NULLIF(data->>'requiredDispatchDate',''), NULLIF(data->>'scheduledDispatchDate',''), '9999-12-31')::date ASC, 
          COALESCE(NULLIF(data->>'internalShipmentNo',''), data->>'id', '') ASC
      `;
    } else if (sort === 'appointment') {
      sql = `
        SELECT data FROM documents
        ${whereSql}
        ORDER BY 
          CASE WHEN COALESCE(data->>'appointmentDate', '') = '' THEN 1 ELSE 0 END,
          (data->>'appointmentDate') ASC, 
          COALESCE(data->>'internalShipmentNo', data->>'id', '') ASC
      `;
    } else {
      sql = `
        SELECT data FROM documents
        ${whereSql}
        ORDER BY updated_at DESC
      `;
    }

    sql += ` OFFSET $${n++}::int LIMIT $${n++}::int`;
    params.push(Math.max(0, Math.trunc(Number(offset)) || 0), Math.max(1, Math.trunc(Number(limit)) || 50));
    const { rows } = await getPool().query(sql, params);
    return { items: rows.map((r) => r.data), total };
  },

  async queryProductivityStats({ startDate, endDate, offset = 0, limit = 50 } = {}) {
    const ts = productivityTimestampExpr();
    const params = [];
    let n = 1;
    let rangeClause = '';

    if (startDate && endDate) {
      rangeClause = `AND ${ts} >= $${n++}::timestamptz AND ${ts} <= $${n++}::timestamptz`;
      params.push(startDate, endDate);
    } else if (startDate) {
      rangeClause = `AND ${ts} >= $${n++}::timestamptz`;
      params.push(startDate);
    } else if (endDate) {
      rangeClause = `AND ${ts} <= $${n++}::timestamptz`;
      params.push(endDate);
    }

    const statsSql = `
      SELECT
        COUNT(*) FILTER (
          WHERE data->>'eventType' = 'box_saved'
            AND ${ts} >= CURRENT_DATE
        )::int AS today_boxes,
        COALESCE(SUM(CASE
          WHEN data->>'eventType' = 'box_saved' AND ${ts} >= CURRENT_DATE
          THEN COALESCE((data->>'itemsCount')::int, 0)
          ELSE 0
        END), 0)::int AS today_items,
        COUNT(*) FILTER (
          WHERE data->>'eventType' = 'box_saved' ${rangeClause}
        )::int AS range_boxes,
        COALESCE(SUM(CASE
          WHEN data->>'eventType' = 'box_saved' ${rangeClause}
          THEN COALESCE((data->>'itemsCount')::int, 0)
          ELSE 0
        END), 0)::int AS range_items,
        COALESCE(AVG(CASE
          WHEN data->>'eventType' = 'box_saved' ${rangeClause}
          THEN COALESCE((data->>'itemsCount')::numeric, 0)
        END), 0)::float AS avg_items_per_box,
        COALESCE(AVG(CASE
          WHEN data->>'eventType' = 'box_saved' ${rangeClause}
          THEN COALESCE((data->>'duration')::numeric, 0)
        END), 0)::float AS avg_time_per_box
      FROM documents
      WHERE collection = 'productivity'
    `;

    const countSql = `
      SELECT COUNT(*)::int AS total
      FROM documents
      WHERE collection = 'productivity'
      ${rangeClause ? `AND ${ts} IS NOT NULL ${rangeClause}` : ''}
    `;

    const activitySql = `
      SELECT data
      FROM documents
      WHERE collection = 'productivity'
      ${rangeClause ? `AND ${ts} IS NOT NULL ${rangeClause}` : ''}
      ORDER BY ${ts} DESC NULLS LAST
      OFFSET $${n++}::int LIMIT $${n++}::int
    `;
    const activityParams = [
      ...params,
      Math.max(0, Math.trunc(Number(offset)) || 0),
      Math.max(1, Math.trunc(Number(limit)) || 50),
    ];

    const pool = getPool();
    const [statsResult, countResult, activityResult] = await Promise.all([
      pool.query(statsSql, params),
      pool.query(countSql, params),
      pool.query(activitySql, activityParams),
    ]);

    return {
      statsRow: statsResult.rows[0] || {},
      totalActivity: countResult.rows[0]?.total || 0,
      recentActivity: activityResult.rows.map((row) => row.data),
    };
  },

  async queryAuditLogs({ entityType, limit = 100 } = {}) {
    const params = [];
    let n = 1;
    let where = "collection = 'auditLogs'";
    if (entityType) {
      where += ` AND data->>'entityType' = $${n++}`;
      params.push(entityType);
    }
    params.push(Math.min(Math.max(parseInt(limit, 10) || 100, 1), 1000));

    const { rows } = await getPool().query(
      `SELECT data
       FROM documents
       WHERE ${where}
       ORDER BY COALESCE(NULLIF(data->>'timestamp', ''), NULLIF(data->>'createdAt', ''))::timestamptz DESC NULLS LAST
       LIMIT $${n}`,
      params
    );
    return rows.map((row) => row.data);
  },

  async queryPlanningSourceData() {
    const pool = getPool();
    const [statusResult, openResult] = await Promise.all([
      pool.query(`
        SELECT
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE data->>'status' = 'completed')::int AS completed
        FROM documents
        WHERE collection = 'consignments'
      `),
      pool.query(`
        SELECT data
        FROM documents
        WHERE collection = 'consignments'
          AND data->>'status' = ANY($1::text[])
      `, [['pending', 'in_progress']]),
    ]);

    const openConsignments = openResult.rows.map((row) => row.data);
    const openIds = openConsignments.map((c) => c.id).filter(Boolean);
    if (!openIds.length) {
      return {
        statusCounts: statusResult.rows[0] || { total: 0, completed: 0 },
        openConsignments: [],
        skus: [],
      };
    }

    const { rows: skuRows } = await pool.query(
      `SELECT data
       FROM documents
       WHERE collection = 'skus'
         AND data->>'consignmentId' = ANY($1::text[])`,
      [openIds]
    );

    return {
      statusCounts: statusResult.rows[0] || { total: 0, completed: 0 },
      openConsignments,
      skus: skuRows.map((row) => row.data),
    };
  },

  async getUserProfileById(id) {
    if (!id) return null;
    const { rows } = await getPool().query(
      'SELECT source_document FROM users WHERE id = $1 LIMIT 1',
      [id]
    );
    const doc = rows[0]?.source_document;
    return doc && typeof doc === 'object' ? { ...doc, id: doc.id || id } : null;
  },

  async getUserProfileByEmail(email) {
    const normalized = String(email || '').trim().toLowerCase();
    if (!normalized) return null;
    const { rows } = await getPool().query(
      'SELECT source_document FROM users WHERE lower(email) = $1 LIMIT 1',
      [normalized]
    );
    const doc = rows[0]?.source_document;
    return doc && typeof doc === 'object' ? doc : null;
  },

  async upsertUserProfile(user) {
    if (!user?.id || !user?.email) return false;

    const sourceDocument = sanitizeUserForStorage(user);
    const stripSecrets = USER_SECRET_STRIP_SQL;

    await getPool().query(
      `INSERT INTO users (
         id, firebase_uid, email, name, role, warehouse_id, permissions,
         is_active, last_login_at, source_document, password_hash, updated_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9::timestamptz, ($10::jsonb) ${stripSecrets}, NULL, now())
       ON CONFLICT (id)
       DO UPDATE SET
         firebase_uid = COALESCE(EXCLUDED.firebase_uid, users.firebase_uid),
         email = EXCLUDED.email,
         name = EXCLUDED.name,
         role = EXCLUDED.role,
         warehouse_id = EXCLUDED.warehouse_id,
         permissions = EXCLUDED.permissions,
         is_active = EXCLUDED.is_active,
         last_login_at = COALESCE(EXCLUDED.last_login_at, users.last_login_at),
         source_document = (users.source_document || EXCLUDED.source_document) ${stripSecrets},
         password_hash = NULL,
         updated_at = now()`,
      [
        user.id,
        user.firebaseUid || user.firebase_uid || null,
        user.email,
        user.name || null,
        user.role || 'packer',
        user.warehouseId || user.warehouse_id || user.warehouse || null,
        JSON.stringify(user.permissions || {}),
        user.isActive !== false,
        user.lastLoginAt || null,
        JSON.stringify(sourceDocument),
      ]
    );
    return true;
  },
};

module.exports = pgHelpers;
