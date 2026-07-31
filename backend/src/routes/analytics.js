const express = require('express');
const db = require('../config/database');
const router = express.Router();

/**
 * GET /api/analytics/energy
 * Energy efficiency metrics for analytics.html
 */
router.get('/energy', async (req, res, next) => {
  try {
    const { period = '24h' } = req.query;
    const intervalMap = { '24h': '1 hour', '7d': '1 day', '30d': '1 day' };
    const interval = intervalMap[period] || '1 hour';
    const limit = period === '24h' ? 24 : (period === '7d' ? 7 : 30);

    // Energy consumption per km by bus
    const efficiencyQuery = `
      SELECT 
        b.asset_id,
        b.chassis_number,
        COUNT(t.id) as trip_count,
        COALESCE(SUM(t.energy_used_kwh), 0) as total_energy_kwh,
        COALESCE(SUM(r.distance_km), 0) as total_distance_km,
        CASE 
          WHEN COALESCE(SUM(r.distance_km), 0) > 0 
          THEN ROUND(COALESCE(SUM(t.energy_used_kwh), 0) / SUM(r.distance_km), 2)
          ELSE 0 
        END as kwh_per_km
      FROM buses b
      LEFT JOIN trips t ON t.bus_id = b.id AND t.status = 'completed' 
        AND t.completed_at >= NOW() - INTERVAL '${period}'
      LEFT JOIN routes r ON r.id = t.route_id
      WHERE b.status != 'retired'
      GROUP BY b.id, b.asset_id, b.chassis_number
      ORDER BY kwh_per_km DESC;
    `;
    const efficiencyResult = await db.query(efficiencyQuery);

    // Charging station utilization
    const utilizationQuery = `
      SELECT 
        cs.station_code,
        d.name as depot_name,
        COUNT(chs.id) as session_count,
        COALESCE(SUM(chs.energy_kwh), 0) as total_energy_delivered,
        COALESCE(AVG(chs.duration_min), 0) as avg_session_min,
        COALESCE(AVG(chs.peak_kw), 0) as avg_peak_kw,
        CASE 
          WHEN cs.status = 'occupied' THEN 'IN_USE'
          WHEN cs.status = 'faulted' THEN 'FAULTED'
          ELSE 'AVAILABLE'
        END as current_status
      FROM charging_stations cs
      JOIN depots d ON d.id = cs.depot_id
      LEFT JOIN charging_sessions chs ON chs.station_id = cs.id 
        AND chs.start_time >= NOW() - INTERVAL '${period}'
      GROUP BY cs.id, cs.station_code, d.name, cs.status
      ORDER BY total_energy_delivered DESC;
    `;
    const utilizationResult = await db.query(utilizationQuery);

    // Time-series energy data
    const timeseriesQuery = `
      SELECT 
        date_trunc('${interval}', start_time) as time_bucket,
        COALESCE(SUM(energy_kwh), 0) as energy_kwh,
        COUNT(*) as session_count,
        COALESCE(AVG(duration_min), 0) as avg_duration_min
      FROM charging_sessions
      WHERE start_time >= NOW() - INTERVAL '${period}'
      GROUP BY time_bucket
      ORDER BY time_bucket DESC
      LIMIT ${limit};
    `;
    const timeseriesResult = await db.query(timeseriesQuery);

    res.json({
      success: true,
      data: {
        period,
        fleetEfficiency: efficiencyResult.rows,
        stationUtilization: utilizationResult.rows,
        energyTimeseries: timeseriesResult.rows,
      }
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/analytics/grid-health
 * Crowdsourced grid coverage and data quality metrics
 */
router.get('/grid-health', async (req, res, next) => {
  try {
    const { period = '24h' } = req.query;

    const coverageQuery = `
      SELECT 
        r.route_code,
        r.name as route_name,
        COUNT(DISTINCT t.bus_id) as buses_active,
        COUNT(DISTINCT tl.passenger_token) as unique_passengers,
        COUNT(tl.id) as total_pings,
        COALESCE(AVG(ta.confidence_score), 0) as avg_confidence,
        COALESCE(AVG(ta.ping_count), 0) as avg_pings_per_window,
        COALESCE(AVG(ta.accuracy_radius_m), 0) as avg_accuracy_m
      FROM routes r
      LEFT JOIN trips t ON t.route_id = r.id AND t.status = 'completed' 
        AND t.completed_at >= NOW() - INTERVAL '${period}'
      LEFT JOIN telemetry_logs tl ON tl.trip_id = t.id
      LEFT JOIN telemetry_aggregates ta ON ta.trip_id = t.id
      WHERE r.active = true
      GROUP BY r.id, r.route_code, r.name
      ORDER BY total_pings DESC;
    `;
    const coverageResult = await db.query(coverageQuery);

    // Data quality distribution
    const qualityQuery = `
      SELECT 
        CASE 
          WHEN confidence_score >= 80 THEN 'EXCELLENT'
          WHEN confidence_score >= 60 THEN 'GOOD'
          WHEN confidence_score >= 40 THEN 'FAIR'
          ELSE 'POOR'
        END as quality_tier,
        COUNT(*) as aggregate_count,
        ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER (), 2) as percentage
      FROM telemetry_aggregates
      WHERE time_window >= NOW() - INTERVAL '${period}'
      GROUP BY quality_tier
      ORDER BY aggregate_count DESC;
    `;
    const qualityResult = await db.query(qualityQuery);

    res.json({
      success: true,
      data: {
        routeCoverage: coverageResult.rows,
        qualityDistribution: qualityResult.rows,
      }
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/analytics/depot-status
 * Real-time depot and charging status for ops center
 */
router.get('/depot-status', async (req, res, next) => {
  try {
    const query = `
      SELECT 
        d.depot_code,
        d.name,
        d.total_bays,
        d.active_bays,
        d.status as depot_status,
        COUNT(DISTINCT nl.bus_id) as buses_locked,
        COUNT(DISTINCT CASE WHEN nl.handshake_state = 'charging' THEN nl.bus_id END) as buses_charging,
        COUNT(DISTINCT cs.id) as total_stations,
        COUNT(DISTINCT CASE WHEN cs.status = 'occupied' THEN cs.id END) as stations_occupied,
        COUNT(DISTINCT CASE WHEN cs.status = 'faulted' THEN cs.id END) as stations_faulted,
        COALESCE(SUM(chs.energy_kwh), 0) as energy_today_kwh
      FROM depots d
      LEFT JOIN nightly_locks nl ON nl.depot_id = d.id AND nl.locked_at >= CURRENT_DATE
      LEFT JOIN charging_stations cs ON cs.depot_id = d.id
      LEFT JOIN charging_sessions chs ON chs.station_id = cs.id AND chs.start_time >= CURRENT_DATE
      GROUP BY d.id, d.depot_code, d.name, d.total_bays, d.active_bays, d.status
      ORDER BY d.name;
    `;
    const result = await db.query(query);

    res.json({
      success: true,
      data: result.rows
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
