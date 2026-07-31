const express = require('express');
const Joi = require('joi');
const db = require('../config/database');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const router = express.Router();

// Simple API key auth middleware for admin routes
const adminAuth = (req, res, next) => {
  const apiKey = req.headers['x-admin-api-key'];
  if (apiKey !== process.env.ADMIN_API_KEY) {
    const err = new Error('Unauthorized');
    err.status = 401;
    return next(err);
  }
  next();
};

// Apply to all admin routes
router.use(adminAuth);

/**
 * GET /api/admin/dashboard
 * Control room summary metrics
 */
router.get('/dashboard', async (req, res, next) => {
  try {
    const stats = await db.query(`
      SELECT 
        (SELECT COUNT(*) FROM buses WHERE status = 'active') as active_buses,
        (SELECT COUNT(*) FROM trips WHERE status = 'active') as active_trips,
        (SELECT COUNT(*) FROM drivers WHERE status = 'on_shift') as drivers_on_shift,
        (SELECT COUNT(*) FROM telemetry_logs WHERE recorded_at >= NOW() - INTERVAL '1 hour') as pings_last_hour,
        (SELECT COUNT(*) FROM nightly_locks WHERE handshake_state = 'charging' AND locked_at >= NOW() - INTERVAL '24 hours') as charging_now,
        (SELECT COALESCE(SUM(energy_kwh), 0) FROM charging_sessions WHERE start_time >= NOW() - INTERVAL '24 hours') as energy_24h,
        (SELECT COALESCE(AVG(confidence_score), 0) FROM telemetry_aggregates WHERE time_window >= NOW() - INTERVAL '1 hour') as avg_confidence_1h;
    `);

    const alerts = await db.query(`
      SELECT b.asset_id, b.status, b.last_updated_at,
             CASE 
               WHEN b.status = 'active' AND b.last_updated_at < NOW() - INTERVAL '15 minutes' THEN 'GPS_STALE'
               WHEN b.status = 'active' AND t.passenger_beacon_count = 0 THEN 'NO_BEACONS'
               ELSE 'OK'
             END as alert_type
      FROM buses b
      LEFT JOIN trips t ON t.id = b.current_trip_id
      WHERE b.status = 'active'
      ORDER BY b.last_updated_at;
    `);

    res.json({
      success: true,
      data: {
        metrics: stats.rows[0],
        alerts: alerts.rows.filter(a => a.alert_type !== 'OK'),
      }
    });
  } catch (err) {
    next(err);
  }
});

/**
 * CRUD: Buses
 */
router.get('/buses', async (req, res, next) => {
  try {
    const result = await db.query(`SELECT * FROM buses ORDER BY asset_id;`);
    res.json({ success: true, data: result.rows });
  } catch (err) { next(err); }
});

router.post('/buses', async (req, res, next) => {
  try {
    const { asset_id, chassis_number, vin, battery_capacity_kwh, seating_capacity } = req.body;
    const result = await db.query(`
      INSERT INTO buses (id, asset_id, chassis_number, vin, battery_capacity_kwh, seating_capacity, status, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, 'depot', NOW())
      RETURNING *;
    `, [uuidv4(), asset_id, chassis_number, vin, battery_capacity_kwh, seating_capacity]);
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (err) { next(err); }
});

router.put('/buses/:id', async (req, res, next) => {
  try {
    const { status, battery_health } = req.body;
    const result = await db.query(`
      UPDATE buses SET status = $1, battery_health = $2, updated_at = NOW()
      WHERE id = $3 RETURNING *;
    `, [status, battery_health, req.params.id]);
    res.json({ success: true, data: result.rows[0] });
  } catch (err) { next(err); }
});

/**
 * CRUD: Drivers
 */
router.get('/drivers', async (req, res, next) => {
  try {
    const result = await db.query(`SELECT id, driver_id, full_name, license_number, phone, status, current_trip_id, created_at FROM drivers ORDER BY full_name;`);
    res.json({ success: true, data: result.rows });
  } catch (err) { next(err); }
});

router.post('/drivers', async (req, res, next) => {
  try {
    const { driver_id, full_name, license_number, phone, pin } = req.body;
    const pinHash = await bcrypt.hash(pin, 10);
    const result = await db.query(`
      INSERT INTO drivers (id, driver_id, full_name, license_number, phone, pin_hash, status, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, 'off_duty', NOW())
      RETURNING id, driver_id, full_name, license_number, phone, status, created_at;
    `, [uuidv4(), driver_id, full_name, license_number, phone, pinHash]);
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (err) { next(err); }
});

/**
 * CRUD: Routes
 */
router.get('/routes', async (req, res, next) => {
  try {
    const result = await db.query(`SELECT * FROM routes ORDER BY name;`);
    res.json({ success: true, data: result.rows });
  } catch (err) { next(err); }
});

router.post('/routes', async (req, res, next) => {
  try {
    const { route_code, name, corridor_type, path_geojson, stops, distance_km, est_duration_min } = req.body;
    const result = await db.query(`
      INSERT INTO routes (id, route_code, name, corridor_type, path_geojson, stops, distance_km, est_duration_min, active, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, NOW())
      RETURNING *;
    `, [uuidv4(), route_code, name, corridor_type, JSON.stringify(path_geojson), JSON.stringify(stops), distance_km, est_duration_min]);
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (err) { next(err); }
});

/**
 * QR Code Provisioning (for qr-matrix.html)
 */
router.post('/qr-codes', async (req, res, next) => {
  try {
    const { type, bus_id, depot_id, station_id, route_id, expires_days } = req.body;
    const codeValue = `YT-${type.toUpperCase()}-${uuidv4().split('-')[0]}-${Date.now()}`;

    const result = await db.query(`
      INSERT INTO qr_codes (id, code_value, type, bus_id, depot_id, station_id, route_id, is_active, expires_at, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, true, $8, NOW())
      RETURNING *;
    `, [uuidv4(), codeValue, type, bus_id || null, depot_id || null, station_id || null, route_id || null,
        expires_days ? new Date(Date.now() + expires_days * 86400000) : null]);

    res.status(201).json({
      success: true,
      data: {
        qrCode: result.rows[0],
        printUrl: `/api/admin/qr-codes/${result.rows[0].id}/print`,
      }
    });
  } catch (err) { next(err); }
});

router.get('/qr-codes', async (req, res, next) => {
  try {
    const { type, bus_id } = req.query;
    let query = `SELECT q.*, b.asset_id, d.depot_code FROM qr_codes q LEFT JOIN buses b ON b.id = q.bus_id LEFT JOIN depots d ON d.id = q.depot_id WHERE 1=1`;
    const params = [];
    if (type) { params.push(type); query += ` AND q.type = $${params.length}`; }
    if (bus_id) { params.push(bus_id); query += ` AND q.bus_id = $${params.length}`; }
    query += ` ORDER BY q.created_at DESC;`;
    const result = await db.query(query, params);
    res.json({ success: true, data: result.rows });
  } catch (err) { next(err); }
});

module.exports = router;
