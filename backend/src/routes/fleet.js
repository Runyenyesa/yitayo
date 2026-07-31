const express = require('express');
const telemetryService = require('../services/telemetryService');
const db = require('../config/database');
const router = express.Router();

/**
 * GET /api/fleet/live
 * Deterministic Algorithmic Matching output for real-time admin map
 * Returns live coordinates, confidence scores, and vehicle metadata
 */
router.get('/live', async (req, res, next) => {
  try {
    const { routeId, minConfidence } = req.query;

    // Fetch live fleet with latest aggregates
    let fleet = await telemetryService.getLiveFleet();

    // Filter by route if specified
    if (routeId) {
      fleet = fleet.filter(v => v.route_id === routeId);
    }

    // Filter by minimum confidence threshold (default 30%)
    const minConf = parseInt(minConfidence) || 30;
    fleet = fleet.filter(v => (v.confidence_score || 0) >= minConf);

    // Enrich with next-stop ETA approximation
    const enrichedFleet = fleet.map(vehicle => {
      // Simple ETA logic: if we have route stops and position, find next stop
      let nextStop = null;
      let etaMinutes = null;

      if (vehicle.stops && vehicle.lat_avg && vehicle.lng_avg && vehicle.computed_speed_kmh > 5) {
        try {
          const stops = typeof vehicle.stops === 'string' ? JSON.parse(vehicle.stops) : vehicle.stops;
          // Find nearest upcoming stop (simplified — assumes sequential progression)
          // In production, use route-matching (map-matching) against the path_geojson
          nextStop = stops[0]; // Placeholder — real implementation needs map-matching
          const distKm = 2.5; // Placeholder distance to next stop
          etaMinutes = Math.round((distKm / vehicle.computed_speed_kmh) * 60);
        } catch (e) {
          // Ignore JSON parse errors
        }
      }

      return {
        busId: vehicle.bus_id,
        assetId: vehicle.asset_id,
        chassisNumber: vehicle.chassis_number,
        batteryKwh: vehicle.battery_capacity_kwh,
        status: vehicle.bus_status,
        position: {
          lat: parseFloat(vehicle.lat_avg || vehicle.last_known_lat),
          lng: parseFloat(vehicle.lng_avg || vehicle.last_known_lng),
          accuracyRadiusM: vehicle.accuracy_radius_m,
          lastUpdated: vehicle.last_aggregate_time || vehicle.last_updated_at,
        },
        telemetry: {
          confidenceScore: vehicle.confidence_score,
          pingCount: vehicle.ping_count,
          computedSpeedKmh: vehicle.computed_speed_kmh,
        },
        trip: vehicle.trip_id ? {
          tripId: vehicle.trip_id,
          tripCode: vehicle.trip_code,
          status: vehicle.trip_status,
          routeCode: vehicle.route_code,
          routeName: vehicle.route_name,
          driverName: vehicle.driver_name,
          driverId: vehicle.driver_id,
          startedAt: vehicle.started_at,
          passengerBeaconCount: vehicle.passenger_beacon_count,
          energyUsedKwh: vehicle.energy_used_kwh,
        } : null,
        nextStop,
        etaMinutes,
      };
    });

    res.json({
      success: true,
      timestamp: new Date().toISOString(),
      fleetSize: enrichedFleet.length,
      data: enrichedFleet,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/fleet/buses/:assetId/history
 * Position history for a specific bus (route replay)
 */
router.get('/buses/:assetId/history', async (req, res, next) => {
  try {
    const { assetId } = req.params;
    const { limit } = req.query;

    const busQuery = `SELECT id FROM buses WHERE asset_id = $1 LIMIT 1;`;
    const busResult = await db.query(busQuery, [assetId]);

    if (busResult.rows.length === 0) {
      const err = new Error('Bus not found');
      err.status = 404;
      throw err;
    }

    const history = await telemetryService.getBusHistory(busResult.rows[0].id, parseInt(limit) || 100);

    res.json({
      success: true,
      data: history.map(h => ({
        timeWindow: h.time_window,
        lat: h.lat_avg,
        lng: h.lng_avg,
        pingCount: h.ping_count,
        accuracyRadiusM: h.accuracy_radius_m,
        speedKmh: h.computed_speed_kmh,
        confidenceScore: h.confidence_score,
      }))
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/fleet/buses
 * Full fleet registry (for qr-matrix.html provisioning)
 */
router.get('/buses', async (req, res, next) => {
  try {
    const { status, search } = req.query;
    let query = `
      SELECT b.*, t.trip_code, t.status as trip_status, r.name as route_name
      FROM buses b
      LEFT JOIN trips t ON t.id = b.current_trip_id
      LEFT JOIN routes r ON r.id = t.route_id
      WHERE 1=1
    `;
    const params = [];

    if (status) {
      params.push(status);
      query += ` AND b.status = $${params.length}`;
    }
    if (search) {
      params.push(`%${search}%`);
      query += ` AND (b.asset_id ILIKE $${params.length} OR b.chassis_number ILIKE $${params.length})`;
    }

    query += ` ORDER BY b.asset_id;`;
    const result = await db.query(query, params);

    res.json({
      success: true,
      data: result.rows
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
