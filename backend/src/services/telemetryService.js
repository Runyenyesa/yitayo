const db = require('../config/database');
const { v4: uuidv4 } = require('uuid');

/**
 * YITAYO DETERMINISTIC ALGORITHMIC MATCHING ENGINE
 * =================================================
 * Converts raw crowdsourced passenger GPS pings into reliable
 * bus position estimates using weighted moving averages and
 * statistical outlier rejection. No hardware GPS required.
 */

class TelemetryService {
  constructor() {
    this.AGGREGATION_WINDOW_MS = (parseInt(process.env.TELEMETRY_AGGREGATION_WINDOW_SEC) || 30) * 1000;
    this.MIN_PINGS = parseInt(process.env.MIN_PINGS_FOR_AGGREGATE) || 3;
    this.MAX_AGE_MIN = parseInt(process.env.MAX_GPS_AGE_MINUTES) || 10;
    this.STD_DEV_THRESHOLD = parseFloat(process.env.OUTLIER_STD_DEV_THRESHOLD) || 2.5;
  }

  /**
   * Ingest a raw passenger check-in ping
   */
  async ingestPing({ tripId, busId, lat, lng, accuracy, speed, heading, batteryPct, passengerToken, source = 'qr_scan' }) {
    const query = `
      INSERT INTO telemetry_logs 
        (id, trip_id, bus_id, passenger_token, lat, lng, accuracy_m, speed_ms, heading, battery_pct, source, recorded_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
      RETURNING *;
    `;
    const values = [
      uuidv4(), tripId, busId, passengerToken, lat, lng,
      accuracy || 50, speed || 0, heading || 0, batteryPct || 100, source
    ];
    const result = await db.query(query, values);

    // Trigger async aggregation for this bus
    this.aggregateBusPosition(busId).catch(err => {
      console.error(`Aggregation failed for bus ${busId}:`, err.message);
    });

    return result.rows[0];
  }

  /**
   * Core Algorithm: Compute weighted moving average with outlier rejection
   */
  async aggregateBusPosition(busId) {
    const windowStart = new Date(Date.now() - this.AGGREGATION_WINDOW_MS);
    const maxAge = new Date(Date.now() - this.MAX_AGE_MIN * 60000);

    // 1. Fetch recent raw pings for this bus
    const rawQuery = `
      SELECT lat, lng, accuracy_m, battery_pct, speed_ms, recorded_at
      FROM telemetry_logs
      WHERE bus_id = $1 
        AND recorded_at >= $2
        AND recorded_at >= $3
      ORDER BY recorded_at DESC
      LIMIT 100;
    `;
    const rawResult = await db.query(rawQuery, [busId, windowStart, maxAge]);
    const pings = rawResult.rows;

    if (pings.length < this.MIN_PINGS) {
      return null; // Not enough data for statistical significance
    }

    // 2. Compute initial mean and standard deviation
    const stats = this.computeStats(pings);

    // 3. Outlier rejection: Remove pings beyond N standard deviations
    const filtered = pings.filter(p => {
      const zLat = Math.abs(p.lat - stats.meanLat) / (stats.stdLat || 0.0001);
      const zLng = Math.abs(p.lng - stats.meanLng) / (stats.stdLng || 0.0001);
      return zLat <= this.STD_DEV_THRESHOLD && zLng <= this.STD_DEV_THRESHOLD;
    });

    if (filtered.length < this.MIN_PINGS) {
      return null; // Too many outliers, data unreliable
    }

    // 4. Weighted average: Higher weight for better accuracy and fresher data
    let weightSum = 0;
    let latSum = 0;
    let lngSum = 0;
    const now = Date.now();

    filtered.forEach(p => {
      const ageMs = now - new Date(p.recorded_at).getTime();
      const recencyWeight = Math.exp(-ageMs / (this.AGGREGATION_WINDOW_MS * 2)); // Exponential decay
      const accuracyWeight = 1 / (p.accuracy_m || 50); // Better accuracy = higher weight
      const batteryWeight = (p.battery_pct || 50) / 100; // Low battery = jittery GPS
      const weight = recencyWeight * accuracyWeight * batteryWeight;

      latSum += p.lat * weight;
      lngSum += p.lng * weight;
      weightSum += weight;
    });

    const latAvg = latSum / weightSum;
    const lngAvg = lngSum / weightSum;

    // 5. Compute confidence radius (95% CI approximation)
    const distances = filtered.map(p => this.haversine(p.lat, p.lng, latAvg, lngAvg));
    distances.sort((a, b) => a - b);
    const accuracyRadius = distances[Math.floor(distances.length * 0.95)] || distances[distances.length - 1];

    // 6. Compute derived speed from position delta (if previous aggregate exists)
    const prevAggQuery = `
      SELECT lat_avg, lng_avg, time_window 
      FROM telemetry_aggregates 
      WHERE bus_id = $1 
      ORDER BY time_window DESC 
      LIMIT 1;
    `;
    const prevResult = await db.query(prevAggQuery, [busId]);
    let computedSpeed = 0;

    if (prevResult.rows.length > 0) {
      const prev = prevResult.rows[0];
      const distM = this.haversine(prev.lat_avg, prev.lng_avg, latAvg, lngAvg);
      const timeH = (Date.now() - new Date(prev.time_window).getTime()) / 3600000;
      computedSpeed = timeH > 0 ? (distM / 1000) / timeH : 0;
    }

    // 7. Confidence score (0-100)
    const pingDensity = Math.min(filtered.length / 10, 1) * 40; // Up to 40 pts for density
    const accuracyScore = Math.max(0, 1 - (accuracyRadius / 200)) * 30; // Up to 30 pts for tight cluster
    const freshnessScore = Math.max(0, 1 - ((now - new Date(filtered[0].recorded_at).getTime()) / 300000)) * 30; // Up to 30 pts for freshness
    const confidenceScore = Math.min(100, pingDensity + accuracyScore + freshnessScore);

    // 8. Persist aggregate
    const timeWindow = new Date(Math.floor(Date.now() / this.AGGREGATION_WINDOW_MS) * this.AGGREGATION_WINDOW_MS);
    const insertQuery = `
      INSERT INTO telemetry_aggregates 
        (id, bus_id, trip_id, time_window, lat_avg, lng_avg, ping_count, 
         accuracy_radius_m, std_dev_lat, std_dev_lng, computed_speed_kmh, confidence_score)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      ON CONFLICT (bus_id, time_window) 
      DO UPDATE SET
        lat_avg = EXCLUDED.lat_avg,
        lng_avg = EXCLUDED.lng_avg,
        ping_count = EXCLUDED.ping_count,
        accuracy_radius_m = EXCLUDED.accuracy_radius_m,
        std_dev_lat = EXCLUDED.std_dev_lat,
        std_dev_lng = EXCLUDED.std_dev_lng,
        computed_speed_kmh = EXCLUDED.computed_speed_kmh,
        confidence_score = EXCLUDED.confidence_score,
        created_at = NOW()
      RETURNING *;
    `;

    // Get active trip for this bus
    const tripQuery = `SELECT id FROM trips WHERE bus_id = $1 AND status = 'active' LIMIT 1;`;
    const tripResult = await db.query(tripQuery, [busId]);
    const tripId = tripResult.rows[0]?.id || null;

    const aggResult = await db.query(insertQuery, [
      uuidv4(), busId, tripId, timeWindow, latAvg, lngAvg, filtered.length,
      accuracyRadius, stats.stdLat, stats.stdLng, computedSpeed, confidenceScore
    ]);

    return aggResult.rows[0];
  }

  /**
   * Compute mean and standard deviation for lat/lng arrays
   */
  computeStats(pings) {
    const n = pings.length;
    const meanLat = pings.reduce((s, p) => s + p.lat, 0) / n;
    const meanLng = pings.reduce((s, p) => s + p.lng, 0) / n;

    const varianceLat = pings.reduce((s, p) => s + Math.pow(p.lat - meanLat, 2), 0) / n;
    const varianceLng = pings.reduce((s, p) => s + Math.pow(p.lng - meanLng, 2), 0) / n;

    return {
      meanLat,
      meanLng,
      stdLat: Math.sqrt(varianceLat),
      stdLng: Math.sqrt(varianceLng)
    };
  }

  /**
   * Haversine distance in meters between two coordinates
   */
  haversine(lat1, lng1, lat2, lng2) {
    const R = 6371000; // Earth radius in meters
    const toRad = deg => deg * (Math.PI / 180);
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  /**
   * Get live fleet positions for admin dashboard
   */
  async getLiveFleet() {
    const query = `
      SELECT 
        b.id as bus_id,
        b.asset_id,
        b.chassis_number,
        b.battery_capacity_kwh,
        b.status as bus_status,
        b.last_known_lat,
        b.last_known_lng,
        b.last_updated_at,
        t.id as trip_id,
        t.trip_code,
        t.status as trip_status,
        t.passenger_beacon_count,
        t.avg_speed_kmh,
        t.energy_used_kwh,
        t.started_at,
        d.driver_id,
        d.full_name as driver_name,
        r.route_code,
        r.name as route_name,
        ta.lat_avg,
        ta.lng_avg,
        ta.ping_count,
        ta.accuracy_radius_m,
        ta.computed_speed_kmh,
        ta.confidence_score,
        ta.time_window as last_aggregate_time
      FROM buses b
      LEFT JOIN trips t ON t.id = b.current_trip_id AND t.status = 'active'
      LEFT JOIN drivers d ON d.id = t.driver_id
      LEFT JOIN routes r ON r.id = t.route_id
      LEFT JOIN LATERAL (
        SELECT * FROM telemetry_aggregates 
        WHERE bus_id = b.id 
        ORDER BY time_window DESC 
        LIMIT 1
      ) ta ON true
      WHERE b.status IN ('active', 'depot')
      ORDER BY b.asset_id;
    `;
    const result = await db.query(query);
    return result.rows;
  }

  /**
   * Get position history for a specific bus (for route replay/debug)
   */
  async getBusHistory(busId, limit = 100) {
    const query = `
      SELECT * FROM telemetry_aggregates
      WHERE bus_id = $1
      ORDER BY time_window DESC
      LIMIT $2;
    `;
    const result = await db.query(query, [busId, limit]);
    return result.rows;
  }
}

module.exports = new TelemetryService();
