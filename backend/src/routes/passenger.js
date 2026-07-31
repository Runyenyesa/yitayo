const express = require('express');
const Joi = require('joi');
const db = require('../config/database');
const telemetryService = require('../services/telemetryService');
const router = express.Router();

const checkinSchema = Joi.object({
  busAssetId: Joi.string().max(32).required(),
  lat: Joi.number().min(-90).max(90).required(),
  lng: Joi.number().min(-180).max(180).required(),
  accuracy: Joi.number().min(0).max(5000).optional(),
  speed: Joi.number().min(0).optional(),
  heading: Joi.number().min(0).max(360).optional(),
  batteryPct: Joi.number().min(0).max(100).optional(),
  passengerToken: Joi.string().max(128).required(), // Anonymized device ID
  qrCode: Joi.string().max(255).optional(),
});

/**
 * POST /api/passenger/checkin
 * Crowdsourced GPS anchor — passenger scans QR in vehicle
 */
router.post('/checkin', async (req, res, next) => {
  try {
    const { error, value } = checkinSchema.validate(req.body);
    if (error) {
      const err = new Error(error.details[0].message);
      err.status = 400;
      err.code = 'VALIDATION_ERROR';
      throw err;
    }

    const { busAssetId, lat, lng, accuracy, speed, heading, batteryPct, passengerToken, qrCode } = value;

    // 1. Resolve bus by asset_id
    const busQuery = `SELECT id, status, current_trip_id FROM buses WHERE asset_id = $1 LIMIT 1;`;
    const busResult = await db.query(busQuery, [busAssetId]);

    if (busResult.rows.length === 0) {
      const err = new Error('Bus not found');
      err.status = 404;
      err.code = 'BUS_NOT_FOUND';
      throw err;
    }

    const bus = busResult.rows[0];
    if (bus.status === 'retired') {
      const err = new Error('This vehicle has been retired from service');
      err.status = 400;
      err.code = 'BUS_RETIRED';
      throw err;
    }

    // 2. Validate QR code if provided (anti-spoofing)
    if (qrCode) {
      const qrQuery = `
        SELECT * FROM qr_codes 
        WHERE code_value = $1 AND bus_id = $2 AND is_active = true
        AND (expires_at IS NULL OR expires_at > NOW())
        LIMIT 1;
      `;
      const qrResult = await db.query(qrQuery, [qrCode, bus.id]);
      if (qrResult.rows.length === 0) {
        const err = new Error('Invalid or expired QR code');
        err.status = 403;
        err.code = 'INVALID_QR';
        throw err;
      }
      // Increment scan count
      await db.query(`UPDATE qr_codes SET scan_count = scan_count + 1, last_scanned_at = NOW() WHERE code_value = $1;`, [qrCode]);
    }

    // 3. Find or validate active trip
    let tripId = bus.current_trip_id;
    if (!tripId) {
      // Bus is not on an active trip — still accept ping but mark as orphan
      // This helps detect unauthorized route deviations
      tripId = null;
    }

    // 4. Ingest telemetry ping
    const ping = await telemetryService.ingestPing({
      tripId,
      busId: bus.id,
      lat,
      lng,
      accuracy,
      speed,
      heading,
      batteryPct,
      passengerToken,
      source: qrCode ? 'qr_scan' : 'manual'
    });

    // 5. Increment beacon count on trip if active
    if (tripId) {
      await db.query(`
        UPDATE trips 
        SET passenger_beacon_count = passenger_beacon_count + 1,
            updated_at = NOW()
        WHERE id = $1;
      `, [tripId]);
    }

    // 6. Return contextual response
    const tripQuery = `
      SELECT t.trip_code, t.status, r.name as route_name, r.stops,
             d.full_name as driver_name
      FROM trips t
      LEFT JOIN routes r ON r.id = t.route_id
      LEFT JOIN drivers d ON d.id = t.driver_id
      WHERE t.id = $1;
    `;
    const tripResult = tripId ? await db.query(tripQuery, [tripId]) : { rows: [] };

    res.status(201).json({
      success: true,
      data: {
        pingId: ping.id,
        busAssetId,
        trip: tripResult.rows[0] || null,
        message: tripId 
          ? 'Location anchored. Thank you for powering the grid.' 
          : 'Location recorded. Bus is currently not on an active scheduled trip.',
        estimatedEta: null, // Computed separately by ETA service
      }
    });

  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/passenger/routes
 * Public route listing for index.html corridor search
 */
router.get('/routes', async (req, res, next) => {
  try {
    const { search, corridorType } = req.query;
    let query = `SELECT id, route_code, name, corridor_type, distance_km, est_duration_min, stops FROM routes WHERE active = true`;
    const params = [];

    if (search) {
      params.push(`%${search}%`);
      query += ` AND (name ILIKE $${params.length} OR route_code ILIKE $${params.length})`;
    }
    if (corridorType) {
      params.push(corridorType);
      query += ` AND corridor_type = $${params.length}`;
    }

    query += ` ORDER BY name;`;
    const result = await db.query(query, params);

    res.json({
      success: true,
      data: result.rows
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/passenger/routes/:routeId/live
 * Live buses on a specific corridor with ETAs
 */
router.get('/routes/:routeId/live', async (req, res, next) => {
  try {
    const { routeId } = req.params;

    const query = `
      SELECT 
        b.asset_id,
        b.battery_capacity_kwh,
        t.trip_code,
        t.passenger_beacon_count,
        t.started_at,
        d.full_name as driver_name,
        ta.lat_avg as lat,
        ta.lng_avg as lng,
        ta.computed_speed_kmh as speed,
        ta.confidence_score,
        ta.time_window as last_seen
      FROM trips t
      JOIN buses b ON b.id = t.bus_id
      LEFT JOIN drivers d ON d.id = t.driver_id
      LEFT JOIN telemetry_aggregates ta ON ta.bus_id = b.id
        AND ta.time_window = (SELECT MAX(time_window) FROM telemetry_aggregates WHERE bus_id = b.id)
      WHERE t.route_id = $1 AND t.status = 'active'
      ORDER BY t.started_at;
    `;

    const result = await db.query(query, [routeId]);

    res.json({
      success: true,
      data: result.rows
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
