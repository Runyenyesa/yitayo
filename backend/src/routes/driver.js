const express = require('express');
const Joi = require('joi');
const db = require('../config/database');
const { v4: uuidv4 } = require('uuid');
const router = express.Router();

const shiftStartSchema = Joi.object({
  driverId: Joi.string().max(32).required(),
  pin: Joi.string().max(6).required(),
  busAssetId: Joi.string().max(32).required(),
  routeId: Joi.string().uuid().required(),
  direction: Joi.string().valid('outbound', 'inbound').default('outbound'),
});

const lockdownSchema = Joi.object({
  driverId: Joi.string().max(32).required(),
  busAssetId: Joi.string().max(32).required(),
  depotId: Joi.string().uuid().required(),
  stationId: Joi.string().uuid().optional(),
  qrSignature: Joi.string().max(255).optional(),
  odometerKm: Joi.number().min(0).optional(),
  batteryPct: Joi.number().min(0).max(100).optional(),
  lockType: Joi.string().valid('qr_scan', 'auto_geo', 'manual_override').default('qr_scan'),
});

/**
 * POST /api/driver/shift/start
 * Driver dashboard authentication and trip activation
 */
router.post('/shift/start', async (req, res, next) => {
  try {
    const { error, value } = shiftStartSchema.validate(req.body);
    if (error) {
      const err = new Error(error.details[0].message);
      err.status = 400;
      throw err;
    }

    const { driverId, pin, busAssetId, routeId, direction } = value;

    // 1. Authenticate driver
    const driverQuery = `SELECT id, pin_hash, status FROM drivers WHERE driver_id = $1 LIMIT 1;`;
    const driverResult = await db.query(driverQuery, [driverId]);

    if (driverResult.rows.length === 0) {
      const err = new Error('Driver not found');
      err.status = 404;
      err.code = 'DRIVER_NOT_FOUND';
      throw err;
    }

    const driver = driverResult.rows[0];

    // Simple PIN check (bcrypt in production)
    const bcrypt = require('bcryptjs');
    const pinValid = await bcrypt.compare(pin, driver.pin_hash);
    if (!pinValid) {
      const err = new Error('Invalid PIN');
      err.status = 401;
      err.code = 'INVALID_PIN';
      throw err;
    }

    if (driver.status === 'suspended') {
      const err = new Error('Driver account suspended');
      err.status = 403;
      throw err;
    }

    // 2. Resolve bus
    const busQuery = `SELECT id, status, current_trip_id FROM buses WHERE asset_id = $1 LIMIT 1;`;
    const busResult = await db.query(busQuery, [busAssetId]);

    if (busResult.rows.length === 0) {
      const err = new Error('Bus not found');
      err.status = 404;
      throw err;
    }
    const bus = busResult.rows[0];

    if (bus.status === 'maintenance' || bus.status === 'retired') {
      const err = new Error('Bus is not available for service');
      err.status = 400;
      throw err;
    }

    // 3. Check if bus already on active trip
    if (bus.current_trip_id) {
      const err = new Error('Bus is already on an active trip');
      err.status = 409;
      err.code = 'TRIP_ACTIVE';
      throw err;
    }

    // 4. Create new trip
    const tripCode = `${busAssetId}-${Date.now()}`;
    const tripQuery = `
      INSERT INTO trips (id, bus_id, driver_id, route_id, trip_code, direction, status, started_at, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, 'active', NOW(), NOW())
      RETURNING *;
    `;
    const tripResult = await db.query(tripQuery, [uuidv4(), bus.id, driver.id, routeId, tripCode, direction]);
    const trip = tripResult.rows[0];

    // 5. Update bus and driver current trip
    await db.query(`UPDATE buses SET current_trip_id = $1, status = 'active', updated_at = NOW() WHERE id = $2;`, [trip.id, bus.id]);
    await db.query(`UPDATE drivers SET current_trip_id = $1, status = 'on_shift', updated_at = NOW() WHERE id = $2;`, [trip.id, driver.id]);

    // 6. Get route details
    const routeQuery = `SELECT route_code, name, stops FROM routes WHERE id = $1;`;
    const routeResult = await db.query(routeQuery, [routeId]);

    res.json({
      success: true,
      data: {
        tripId: trip.id,
        tripCode: trip.trip_code,
        status: 'active',
        route: routeResult.rows[0],
        driverName: driver.full_name,
        message: 'Shift started. Drive safely.',
      }
    });

  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/driver/shift/end
 * End current trip (bus reaches terminus)
 */
router.post('/shift/end', async (req, res, next) => {
  try {
    const { driverId, busAssetId, energyUsedKwh } = req.body;

    const busQuery = `SELECT id, current_trip_id FROM buses WHERE asset_id = $1 LIMIT 1;`;
    const busResult = await db.query(busQuery, [busAssetId]);

    if (busResult.rows.length === 0 || !busResult.rows[0].current_trip_id) {
      const err = new Error('No active trip found for this bus');
      err.status = 404;
      throw err;
    }

    const tripId = busResult.rows[0].current_trip_id;

    await db.query(`
      UPDATE trips 
      SET status = 'completed', completed_at = NOW(), energy_used_kwh = $1, updated_at = NOW()
      WHERE id = $2;
    `, [energyUsedKwh || 0, tripId]);

    await db.query(`UPDATE buses SET current_trip_id = NULL, status = 'depot', updated_at = NOW() WHERE asset_id = $1;`, [busAssetId]);
    await db.query(`UPDATE drivers SET current_trip_id = NULL, status = 'off_duty', updated_at = NOW() WHERE driver_id = $1;`, [driverId]);

    res.json({
      success: true,
      message: 'Trip completed successfully.',
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/driver/lockdown
 * Depot arrival — QR scan + charging port handshake
 */
router.post('/lockdown', async (req, res, next) => {
  try {
    const { error, value } = lockdownSchema.validate(req.body);
    if (error) {
      const err = new Error(error.details[0].message);
      err.status = 400;
      throw err;
    }

    const { driverId, busAssetId, depotId, stationId, qrSignature, odometerKm, batteryPct, lockType } = value;

    // 1. Resolve entities
    const busQuery = `SELECT id, current_trip_id FROM buses WHERE asset_id = $1 LIMIT 1;`;
    const busResult = await db.query(busQuery, [busAssetId]);
    if (busResult.rows.length === 0) {
      const err = new Error('Bus not found');
      err.status = 404;
      throw err;
    }
    const bus = busResult.rows[0];

    const driverQuery = `SELECT id FROM drivers WHERE driver_id = $1 LIMIT 1;`;
    const driverResult = await db.query(driverQuery, [driverId]);
    const driverDbId = driverResult.rows[0]?.id || null;

    // 2. Validate QR signature if provided
    if (qrSignature) {
      const qrQuery = `
        SELECT * FROM qr_codes 
        WHERE code_value = $1 AND depot_id = $2 AND type = 'depot_lock'
        AND is_active = true LIMIT 1;
      `;
      const qrResult = await db.query(qrQuery, [qrSignature, depotId]);
      if (qrResult.rows.length === 0) {
        const err = new Error('Invalid depot lock QR code');
        err.status = 403;
        err.code = 'INVALID_LOCK_QR';
        throw err;
      }
    }

    // 3. End any active trip
    if (bus.current_trip_id) {
      await db.query(`UPDATE trips SET status = 'locked_down', completed_at = NOW() WHERE id = $1;`, [bus.current_trip_id]);
    }

    // 4. Create nightly lock record
    const lockQuery = `
      INSERT INTO nightly_locks 
        (id, bus_id, depot_id, station_id, trip_id, lock_type, qr_signature, driver_id, odometer_km, battery_pct, handshake_state, locked_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending', NOW())
      RETURNING *;
    `;
    const lockResult = await db.query(lockQuery, [
      uuidv4(), bus.id, depotId, stationId || null, bus.current_trip_id,
      lockType, qrSignature || null, driverDbId, odometerKm || 0, batteryPct || 0
    ]);
    const lockRecord = lockResult.rows[0];

    // 5. Update bus status
    await db.query(`UPDATE buses SET status = 'depot', current_trip_id = NULL, updated_at = NOW() WHERE id = $1;`, [bus.id]);
    await db.query(`UPDATE drivers SET current_trip_id = NULL, status = 'off_duty', updated_at = NOW() WHERE driver_id = $1;`, [driverId]);

    // 6. If station specified, attempt charging handshake
    let chargingSession = null;
    if (stationId) {
      const stationQuery = `SELECT * FROM charging_stations WHERE id = $1 AND status = 'available' LIMIT 1;`;
      const stationResult = await db.query(stationQuery, [stationId]);

      if (stationResult.rows.length > 0) {
        // Mark station as occupied
        await db.query(`UPDATE charging_stations SET status = 'occupied', current_bus_id = $1, current_session_id = $2 WHERE id = $3;`, 
          [bus.id, uuidv4(), stationId]);

        // Create charging session
        const sessionQuery = `
          INSERT INTO charging_sessions (id, station_id, bus_id, lock_id, start_soc_pct, status)
          VALUES ($1, $2, $3, $4, $5, 'active')
          RETURNING *;
        `;
        const sessionResult = await db.query(sessionQuery, [uuidv4(), stationId, bus.id, lockRecord.id, batteryPct || 0]);
        chargingSession = sessionResult.rows[0];

        // Update lock to confirmed
        await db.query(`UPDATE nightly_locks SET handshake_state = 'charging' WHERE id = $1;`, [lockRecord.id]);
      }
    }

    res.json({
      success: true,
      data: {
        lockId: lockRecord.id,
        handshakeState: chargingSession ? 'charging' : 'confirmed',
        chargingSession: chargingSession ? {
          sessionId: chargingSession.id,
          stationId: chargingSession.station_id,
          startSoc: chargingSession.start_soc_pct,
          startedAt: chargingSession.start_time,
        } : null,
        message: chargingSession 
          ? 'Depot lock confirmed. Charging session initiated.' 
          : 'Depot lock confirmed. Awaiting charging station assignment.',
      }
    });

  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/driver/trip/:tripId/status
 * Poll for current trip status (from driver dashboard)
 */
router.get('/trip/:tripId/status', async (req, res, next) => {
  try {
    const { tripId } = req.params;

    const query = `
      SELECT t.*, r.name as route_name, r.stops,
             b.asset_id, b.battery_capacity_kwh,
             d.full_name as driver_name
      FROM trips t
      JOIN buses b ON b.id = t.bus_id
      JOIN drivers d ON d.id = t.driver_id
      JOIN routes r ON r.id = t.route_id
      WHERE t.id = $1;
    `;
    const result = await db.query(query, [tripId]);

    if (result.rows.length === 0) {
      const err = new Error('Trip not found');
      err.status = 404;
      throw err;
    }

    res.json({
      success: true,
      data: result.rows[0]
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
