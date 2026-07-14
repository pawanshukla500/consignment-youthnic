const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const { generateId, now, firestoreHelpers } = require('../utils/helpers');
const pgHelpers = require('../utils/pgHelpers');
const { enrichConsignment, buildMarketplaceMap, sortByDispatchPriority } = require('../utils/dispatchPlanning');
const { requirePermission, requireAnyPermission } = require('../utils/permissions');
const { getPool, pgEnabled } = require('../config/database');
const {
  DASHBOARD_TTL_MS,
  getDashboardCache,
  setDashboardCache,
  invalidateDashboardCache,
} = require('../utils/reportingCache');

function toInt(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function buildPlanningPayload(consignments, allSkus, statusCounts = null) {
  const skusByConsignment = {};
  for (const s of allSkus) {
    if (!skusByConsignment[s.consignmentId]) skusByConsignment[s.consignmentId] = [];
    skusByConsignment[s.consignmentId].push(s);
  }

  const byConsignment = [];
  const bySkuMap = {};
  const pendingSkusByConsignmentId = {};
  let totalRequired = 0;
  let totalPacked = 0;
  let totalPending = 0;
  let pendingConsignments = 0;

  for (const c of consignments) {
    const isOpen = c.status === 'pending' || c.status === 'in_progress';
    const skus = skusByConsignment[c.id] || [];

    let cRequired = 0;
    let cPacked = 0;
    const pendingSkuRows = [];

    for (const s of skus) {
      const req = s.requiredQty || 0;
      const pkd = s.packedQty || 0;
      const pend = Math.max(0, req - pkd);
      cRequired += req;
      cPacked += pkd;

      if (isOpen && pend > 0) {
        pendingSkuRows.push({
          internalSku: s.internalSku || '',
          marketplaceSku: s.marketplaceSku || '',
          barcode: s.barcode || '',
          required: req,
          packed: pkd,
          pending: pend,
        });

        const key = s.internalSku || s.marketplaceSku || s.barcode || s.id;
        if (!bySkuMap[key]) {
          bySkuMap[key] = {
            internalSku: s.internalSku || '',
            marketplaceSku: s.marketplaceSku || '',
            barcode: s.barcode || '',
            totalRequired: 0,
            totalPacked: 0,
            totalPending: 0,
            consignments: [],
          };
        }
        const entry = bySkuMap[key];
        entry.totalRequired += req;
        entry.totalPacked += pkd;
        entry.totalPending += pend;
        entry.consignments.push({
          id: c.id,
          internalShipmentNo: c.internalShipmentNo || c.id,
          required: req,
          packed: pkd,
          pending: pend,
          status: c.status,
        });
      }
    }

    const cPending = Math.max(0, cRequired - cPacked);
    if (isOpen) {
      pendingConsignments += 1;
      totalRequired += cRequired;
      totalPacked += cPacked;
      totalPending += cPending;
      pendingSkusByConsignmentId[c.id] = pendingSkuRows;
      byConsignment.push({
        id: c.id,
        internalShipmentNo: c.internalShipmentNo || c.id,
        marketplaceId: c.marketplaceId || '',
        warehouse: c.warehouse || '',
        status: c.status,
        shipmentStatus: c.shipmentStatus || 'Planned',
        appointmentDate: c.appointmentDate || '',
        scheduledDispatchDate: c.scheduledDispatchDate || '',
        requiredDispatchDate: c.requiredDispatchDate || '',
        totalRequiredQty: cRequired,
        totalPackedQty: cPacked,
        required: cRequired,
        packed: cPacked,
        pending: cPending,
        skuCount: skus.length,
        pendingSkuCount: skus.filter((s) => (s.requiredQty || 0) - (s.packedQty || 0) > 0).length,
        expectedDate: c.expectedDate || '',
        createdAt: c.createdAt,
      });
    }
  }

  const bySku = Object.values(bySkuMap).sort((a, b) => b.totalPending - a.totalPending);
  bySku.forEach((s) => s.consignments.sort((a, b) => b.pending - a.pending));

  const sortedByConsignment = sortByDispatchPriority(byConsignment);
  const criticalCount = sortedByConsignment.filter((c) => c.isCritical).length;
  const highCount = sortedByConsignment.filter((c) => c.criticalityLevel === 'high').length;
  const delayedCount = sortedByConsignment.filter((c) => (c.daysUntilDispatch ?? 99) < 0).length;

  const totalConsignments = statusCounts
    ? toInt(statusCounts.total)
    : consignments.length;
  const completedConsignments = statusCounts
    ? toInt(statusCounts.completed)
    : consignments.filter((c) => c.status === 'completed').length;

  const openList = consignments.filter((c) => c.status === 'pending' || c.status === 'in_progress');
  const pendingStatusConsignments = openList.filter((c) => c.status === 'pending').length;
  const inProgressConsignments = openList.filter((c) => c.status === 'in_progress').length;

  return {
    summary: {
      totalConsignments,
      openConsignments: pendingConsignments,
      completedConsignments,
      pendingStatusConsignments,
      inProgressConsignments,
      totalRequiredQty: totalRequired,
      totalPackedQty: totalPacked,
      totalPendingQty: totalPending,
      uniquePendingSkus: bySku.length,
      criticalShipments: criticalCount,
      highPriorityShipments: highCount,
      delayedShipments: delayedCount,
    },
    byConsignment: sortedByConsignment,
    bySku,
    pendingSkusByConsignmentId,
  };
}

async function finalizeDashboardPayload(payload) {
  const marketplaceMap = await buildMarketplaceMap(firestoreHelpers);
  const recentConsignments = payload.recentConsignments.map((c) => enrichConsignment(c, marketplaceMap));
  const priorityQueue = sortByDispatchPriority(
    payload.openConsignments.map((c) => enrichConsignment(c, marketplaceMap))
  ).slice(0, 8);

  return {
    ...payload,
    recentConsignments,
    priorityQueue,
    openConsignments: undefined,
    cachedForSeconds: Math.round(DASHBOARD_TTL_MS / 1000),
  };
}

function getRecentDaysTrend(records = []) {
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = d.toDateString();
    const value = records.filter((r) => r.eventType === 'box_saved' && new Date(r.timestamp).toDateString() === key).length;
    days.push({ label: d.toLocaleDateString('en-US', { weekday: 'short' }), value });
  }
  return days;
}

async function getPgDashboardSummary() {
  const pool = getPool();
  const [
    statusResult,
    recentResult,
    openResult,
    productivityResult,
    trendResult,
  ] = await Promise.all([
    pool.query(`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE data->>'status' = 'pending')::int AS pending,
        COUNT(*) FILTER (WHERE data->>'status' = 'in_progress')::int AS in_progress,
        COUNT(*) FILTER (WHERE data->>'status' = 'completed')::int AS completed
      FROM documents
      WHERE collection = 'consignments'
    `),
    pool.query(`
      SELECT data
      FROM documents
      WHERE collection = 'consignments'
      ORDER BY updated_at DESC
      LIMIT 5
    `),
    pool.query(`
      SELECT data
      FROM documents
      WHERE collection = 'consignments'
        AND data->>'status' = ANY($1::text[])
      ORDER BY
        COALESCE(NULLIF(data->>'requiredDispatchDate', ''), NULLIF(data->>'scheduledDispatchDate', ''), '9999-12-31')::date ASC,
        updated_at DESC
      LIMIT 100
    `, [['pending', 'in_progress']]),
    pool.query(`
      SELECT
        COUNT(*) FILTER (
          WHERE data->>'eventType' = 'box_saved'
            AND COALESCE(NULLIF(data->>'timestamp', ''), NULLIF(data->>'createdAt', ''))::timestamptz >= CURRENT_DATE
        )::int AS today_boxes,
        COALESCE(SUM(CASE
          WHEN data->>'eventType' = 'box_saved'
            AND COALESCE(NULLIF(data->>'timestamp', ''), NULLIF(data->>'createdAt', ''))::timestamptz >= CURRENT_DATE
          THEN COALESCE((data->>'itemsCount')::int, 0)
          ELSE 0
        END), 0)::int AS today_items,
        COUNT(*) FILTER (WHERE data->>'eventType' = 'box_saved')::int AS total_boxes,
        COALESCE(SUM(CASE WHEN data->>'eventType' = 'box_saved' THEN COALESCE((data->>'itemsCount')::int, 0) ELSE 0 END), 0)::int AS total_items,
        COALESCE(AVG(CASE WHEN data->>'eventType' = 'box_saved' THEN COALESCE((data->>'itemsCount')::numeric, 0) END), 0)::float AS avg_items_per_box,
        COALESCE(AVG(CASE WHEN data->>'eventType' = 'box_saved' THEN COALESCE((data->>'duration')::numeric, 0) END), 0)::float AS avg_time_per_box
      FROM documents
      WHERE collection = 'productivity'
    `),
    pool.query(`
      SELECT to_char(day, 'Dy') AS label, COALESCE(counts.value, 0)::int AS value
      FROM generate_series(
        (CURRENT_DATE - INTERVAL '6 days')::timestamp,
        CURRENT_DATE::timestamp,
        INTERVAL '1 day'
      ) AS day
      LEFT JOIN (
        SELECT date_trunc('day', COALESCE(NULLIF(data->>'timestamp', ''), NULLIF(data->>'createdAt', ''))::timestamptz)::date AS d, COUNT(*)::int AS value
        FROM documents
        WHERE collection = 'productivity'
          AND data->>'eventType' = 'box_saved'
          AND COALESCE(NULLIF(data->>'timestamp', ''), NULLIF(data->>'createdAt', ''))::timestamptz >= CURRENT_DATE - INTERVAL '6 days'
        GROUP BY 1
      ) counts ON counts.d = day::date
      ORDER BY day
    `),
  ]);

  const statsRow = statusResult.rows[0] || {};
  const productivityRow = productivityResult.rows[0] || {};
  const stats = {
    total: toInt(statsRow.total),
    pending: toInt(statsRow.pending),
    inProgress: toInt(statsRow.in_progress),
    completed: toInt(statsRow.completed),
  };
  const productivity = {
    today: {
      boxes: toInt(productivityRow.today_boxes),
      items: toInt(productivityRow.today_items),
      avgItemsPerBox: Math.round((Number(productivityRow.avg_items_per_box) || 0) * 100) / 100,
      avgTimePerBox: Math.round((Number(productivityRow.avg_time_per_box) || 0) * 100) / 100,
    },
    summary: {
      totalBoxes: toInt(productivityRow.total_boxes),
      totalItems: toInt(productivityRow.total_items),
      avgItemsPerBox: Math.round((Number(productivityRow.avg_items_per_box) || 0) * 100) / 100,
      avgTimePerBoxSeconds: Math.round((Number(productivityRow.avg_time_per_box) || 0) * 100) / 100,
    },
    recentActivity: [],
  };
  return {
    stats,
    productivity,
    recentConsignments: recentResult.rows.map((row) => row.data),
    openConsignments: openResult.rows.map((row) => row.data),
    trend: trendResult.rows.map((row) => ({ label: String(row.label).trim(), value: toInt(row.value) })),
  };
}

router.get('/dashboard-summary', authenticateToken, requireAnyPermission(['consignments', 'packing', 'productivity'], 'view the dashboard'), async (req, res) => {
  try {
    const forceRefresh = req.query.refresh === '1';
    if (!forceRefresh) {
      const cached = getDashboardCache();
      if (cached) {
        return res.json({ ...cached, fromCache: true });
      }
    }

    let payload;
    if (pgEnabled()) {
      try {
        payload = await getPgDashboardSummary();
      } catch (error) {
        console.warn('[Dashboard] PG summary failed, using document fallback:', error.message);
      }
    }

    if (!payload) {
      const [consignments, productivityRecords] = await Promise.all([
        firestoreHelpers.getCollection('consignments'),
        firestoreHelpers.getCollection('productivity'),
      ]);
      const sortedConsignments = [...consignments].sort((a, b) => new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0));
      const boxRecords = productivityRecords.filter((r) => r.eventType === 'box_saved');
      const today = new Date().toDateString();
      const todayRecords = boxRecords.filter((r) => new Date(r.timestamp).toDateString() === today);
      const avgItemsPerBox = boxRecords.length ? boxRecords.reduce((sum, r) => sum + toInt(r.itemsCount), 0) / boxRecords.length : 0;
      payload = {
        stats: {
          total: consignments.length,
          pending: consignments.filter((c) => c.status === 'pending').length,
          inProgress: consignments.filter((c) => c.status === 'in_progress').length,
          completed: consignments.filter((c) => c.status === 'completed').length,
        },
        productivity: {
          today: {
            boxes: todayRecords.length,
            items: todayRecords.reduce((sum, r) => sum + toInt(r.itemsCount), 0),
            avgItemsPerBox: Math.round(avgItemsPerBox * 100) / 100,
            avgTimePerBox: 0,
          },
          summary: {
            totalBoxes: boxRecords.length,
            totalItems: boxRecords.reduce((sum, r) => sum + toInt(r.itemsCount), 0),
            avgItemsPerBox: Math.round(avgItemsPerBox * 100) / 100,
            avgTimePerBoxSeconds: 0,
          },
          recentActivity: [],
        },
        recentConsignments: sortedConsignments.slice(0, 5),
        openConsignments: consignments.filter((c) => ['pending', 'in_progress'].includes(c.status)).slice(0, 100),
        trend: getRecentDaysTrend(productivityRecords),
      };
    }

    const response = await finalizeDashboardPayload(payload);
    setDashboardCache(response);
    res.json(response);
  } catch (error) {
    console.error('Error fetching dashboard summary:', error);
    res.status(500).json({ error: 'Failed to fetch dashboard summary.' });
  }
});

// Log productivity event
router.post('/', authenticateToken, requireAnyPermission(['packing', 'productivity'], 'log productivity events'), async (req, res) => {
  try {
    const { consignmentId, boxNo, eventType, itemsCount, duration } = req.body;

    const record = {
      id: generateId(),
      consignmentId: consignmentId || '',
      boxNo: boxNo || '',
      eventType: eventType || 'box_saved', // box_saved, consignment_finished, scan
      itemsCount: parseInt(itemsCount) || 0,
      duration: parseInt(duration) || 0,
      timestamp: now(),
      userId: req.user.id,
      userName: req.user.name || req.user.email
    };

    await firestoreHelpers.setDocument('productivity', record.id, record);
    invalidateDashboardCache();

    res.status(201).json({ record });
  } catch (error) {
    console.error('Error logging productivity:', error);
    res.status(500).json({ error: 'Failed to log productivity.' });
  }
});

// Get productivity stats
router.get('/', authenticateToken, requirePermission('productivity', 'view productivity reports'), async (req, res) => {
  try {
    const { date, startDate, endDate } = req.query;
    const pageSize = Math.min(parseInt(req.query.limit, 10) || 50, 500);
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const offset = Math.max(parseInt(req.query.offset, 10) || ((page - 1) * pageSize), 0);

    if (pgEnabled()) {
      try {
        let rangeStart = startDate;
        let rangeEnd = endDate;
        if (date) {
          const target = new Date(date);
          rangeStart = target.toISOString();
          const endOfDay = new Date(target);
          endOfDay.setHours(23, 59, 59, 999);
          rangeEnd = endOfDay.toISOString();
        } else if (startDate && !endDate) {
          rangeEnd = new Date().toISOString();
        } else if (!startDate && endDate) {
          rangeStart = '1970-01-01T00:00:00.000Z';
        }

        const { statsRow, totalActivity, recentActivity } = await pgHelpers.queryProductivityStats({
          startDate: rangeStart,
          endDate: rangeEnd,
          offset,
          limit: pageSize,
        });

        const avgItemsPerBox = Number(statsRow.avg_items_per_box) || 0;
        const avgTimePerBox = Number(statsRow.avg_time_per_box) || 0;

        return res.json({
          today: {
            boxes: toInt(statsRow.today_boxes),
            items: toInt(statsRow.today_items),
            avgItemsPerBox: Math.round(avgItemsPerBox * 100) / 100,
            avgTimePerBox: Math.round(avgTimePerBox * 100) / 100,
          },
          summary: {
            totalBoxes: toInt(statsRow.range_boxes),
            totalItems: toInt(statsRow.range_items),
            avgItemsPerBox: Math.round(avgItemsPerBox * 100) / 100,
            avgTimePerBoxSeconds: Math.round(avgTimePerBox * 100) / 100,
          },
          recentActivity,
          pagination: {
            count: recentActivity.length,
            total: totalActivity,
            page,
            pageSize,
            hasMore: offset + recentActivity.length < totalActivity,
          },
        });
      } catch (error) {
        console.warn('[Productivity] PG stats failed, using document fallback:', error.message);
      }
    }

    let records = await firestoreHelpers.getCollection('productivity');
    
    // Filter by date range
    if (date) {
      const targetDate = new Date(date).toDateString();
      records = records.filter(r => new Date(r.timestamp).toDateString() === targetDate);
    } else if (startDate && endDate) {
      const start = new Date(startDate);
      const end = new Date(endDate);
      records = records.filter(r => {
        const d = new Date(r.timestamp);
        return d >= start && d <= end;
      });
    }

    // Today's stats
    const today = new Date().toDateString();
    const todayRecords = records.filter(r => new Date(r.timestamp).toDateString() === today);
    
    const todayBoxes = todayRecords.filter(r => r.eventType === 'box_saved').length;
    const todayItems = todayRecords.filter(r => r.eventType === 'box_saved').reduce((sum, r) => sum + (r.itemsCount || 0), 0);
    
    // Calculate averages
    const allBoxRecords = records.filter(r => r.eventType === 'box_saved');
    const avgItemsPerBox = allBoxRecords.length > 0 
      ? allBoxRecords.reduce((sum, r) => sum + (r.itemsCount || 0), 0) / allBoxRecords.length 
      : 0;
    const avgTimePerBox = allBoxRecords.length > 0
      ? allBoxRecords.reduce((sum, r) => sum + (r.duration || 0), 0) / allBoxRecords.length
      : 0;

    // Recent activity
    records.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    const totalActivity = records.length;
    const recentActivity = records.slice(offset, offset + pageSize);

    res.json({
      today: {
        boxes: todayBoxes,
        items: todayItems,
        avgItemsPerBox: Math.round(avgItemsPerBox * 100) / 100,
        avgTimePerBox: Math.round(avgTimePerBox * 100) / 100
      },
      summary: {
        totalBoxes: allBoxRecords.length,
        totalItems: allBoxRecords.reduce((sum, r) => sum + (r.itemsCount || 0), 0),
        avgItemsPerBox: Math.round(avgItemsPerBox * 100) / 100,
        avgTimePerBoxSeconds: Math.round(avgTimePerBox * 100) / 100
      },
      recentActivity,
      pagination: {
        count: recentActivity.length,
        total: totalActivity,
        page,
        pageSize,
        hasMore: offset + recentActivity.length < totalActivity,
      }
    });
  } catch (error) {
    console.error('Error fetching productivity:', error);
    res.status(500).json({ error: 'Failed to fetch productivity data.' });
  }
});

// Get audit logs
router.get('/audit', authenticateToken, requirePermission('auditLogs', 'view audit logs'), async (req, res) => {
  try {
    const { entityType, limit = 100 } = req.query;
    const parsedLimit = Math.min(parseInt(limit, 10) || 100, 1000);

    if (pgEnabled()) {
      try {
        const logs = await pgHelpers.queryAuditLogs({ entityType, limit: parsedLimit });
        return res.json({ logs });
      } catch (error) {
        console.warn('[Productivity] PG audit query failed, using document fallback:', error.message);
      }
    }

    let logs = await firestoreHelpers.getCollection('auditLogs');
    
    if (entityType) {
      logs = logs.filter(l => l.entityType === entityType);
    }

    logs.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    logs = logs.slice(0, parseInt(limit));

    res.json({ logs });
  } catch (error) {
    console.error('Error fetching audit logs:', error);
    res.status(500).json({ error: 'Failed to fetch audit logs.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Production Planning Report
// Aggregates all open consignments + their SKUs so the production team can plan.
// Returns: summary, per-consignment pending/packed, and per-internal-SKU pending
//          (with the list of consignments each SKU is pending in).
// ─────────────────────────────────────────────────────────────────────────────
router.get('/planning', authenticateToken, requirePermission('productivity', 'view production planning'), async (req, res) => {
  try {
    let planningBase;
    if (pgEnabled()) {
      try {
        const { statusCounts, openConsignments, skus } = await pgHelpers.queryPlanningSourceData();
        planningBase = buildPlanningPayload(openConsignments, skus, statusCounts);
      } catch (error) {
        console.warn('[Planning] PG query failed, using document fallback:', error.message);
      }
    }

    if (!planningBase) {
      const [consignments, allSkus] = await Promise.all([
        firestoreHelpers.getCollection('consignments'),
        firestoreHelpers.getCollection('skus'),
      ]);
      planningBase = buildPlanningPayload(consignments, allSkus);
    }

    const marketplaceMap = await buildMarketplaceMap(firestoreHelpers);
    const byConsignment = planningBase.byConsignment.map((c) => enrichConsignment(c, marketplaceMap));

    res.json({
      summary: planningBase.summary,
      byConsignment: sortByDispatchPriority(byConsignment),
      bySku: planningBase.bySku,
      pendingSkusByConsignmentId: planningBase.pendingSkusByConsignmentId,
    });
  } catch (error) {
    console.error('Error building planning report:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
