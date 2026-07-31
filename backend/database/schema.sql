-- ============================================================
-- YITAYO TRANSIT PLATFORM — PRODUCTION DATABASE SCHEMA
-- PostgreSQL 15+ | Zero-Hardware Crowdsourced Transit Grid
-- ============================================================

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "postgis";  -- For geospatial queries on routes

-- ============================================================
-- 1. FLEET ASSET REGISTRY
-- ============================================================
CREATE TABLE buses (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    asset_id        VARCHAR(32) UNIQUE NOT NULL,           -- e.g., "KMC-EVS-001"
    chassis_number  VARCHAR(64) UNIQUE NOT NULL,           -- KMC factory chassis
    vin             VARCHAR(17) UNIQUE,                    -- Vehicle Identification Number
    battery_capacity_kwh DECIMAL(6,2) NOT NULL DEFAULT 0,  -- e.g., 250.00
    battery_health  DECIMAL(5,2) DEFAULT 100.00,           -- SoH percentage
    seating_capacity INTEGER NOT NULL DEFAULT 50,
    status          VARCHAR(20) NOT NULL DEFAULT 'active' 
                    CHECK (status IN ('active', 'maintenance', 'retired', 'depot')),
    current_trip_id UUID,
    last_known_lat  DECIMAL(10, 8),
    last_known_lng  DECIMAL(11, 8),
    last_updated_at TIMESTAMPTZ DEFAULT NOW(),
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_buses_asset_id ON buses(asset_id);
CREATE INDEX idx_buses_status ON buses(status);
CREATE INDEX idx_buses_location ON buses(last_known_lat, last_known_lng);

-- ============================================================
-- 2. OPERATOR REGISTRY
-- ============================================================
CREATE TABLE drivers (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    driver_id       VARCHAR(32) UNIQUE NOT NULL,           -- MoWT issued ID
    full_name       VARCHAR(128) NOT NULL,
    license_number  VARCHAR(64) UNIQUE NOT NULL,
    phone           VARCHAR(20),
    pin_hash        VARCHAR(255),                          -- For dashboard shift auth
    status          VARCHAR(20) NOT NULL DEFAULT 'off_duty'
                    CHECK (status IN ('off_duty', 'on_shift', 'suspended', 'leave')),
    current_trip_id UUID,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_drivers_driver_id ON drivers(driver_id);
CREATE INDEX idx_drivers_status ON drivers(status);

-- ============================================================
-- 3. ROUTE & CORRIDOR DEFINITIONS
-- ============================================================
CREATE TABLE routes (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    route_code      VARCHAR(16) UNIQUE NOT NULL,           -- e.g., "KLA-ENTEBBE"
    name            VARCHAR(128) NOT NULL,                 -- Human readable
    corridor_type   VARCHAR(32) DEFAULT 'urban',           -- urban, intercity, feeder
    path_geojson    JSONB,                                 -- GeoJSON LineString of waypoints
    stops           JSONB,                                 -- Array of stop objects {name, lat, lng, sequence}
    distance_km     DECIMAL(8,2),
    est_duration_min INTEGER,
    active          BOOLEAN DEFAULT true,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_routes_route_code ON routes(route_code);
CREATE INDEX idx_routes_active ON routes(active);

-- ============================================================
-- 4. ACTIVE TRIPS (The beating heart of the grid)
-- ============================================================
CREATE TABLE trips (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    bus_id          UUID NOT NULL REFERENCES buses(id),
    driver_id       UUID NOT NULL REFERENCES drivers(id),
    route_id        UUID NOT NULL REFERENCES routes(id),
    trip_code       VARCHAR(32) UNIQUE NOT NULL,           -- e.g., "KLA-ENT-20260730-001"
    direction       VARCHAR(10) NOT NULL DEFAULT 'outbound' 
                    CHECK (direction IN ('outbound', 'inbound')),
    status          VARCHAR(20) NOT NULL DEFAULT 'preparing'
                    CHECK (status IN ('preparing', 'active', 'completed', 'aborted', 'locked_down')),
    started_at      TIMESTAMPTZ,
    completed_at    TIMESTAMPTZ,
    passenger_beacon_count INTEGER DEFAULT 0,              -- Active scanners on board
    avg_speed_kmh   DECIMAL(5,2) DEFAULT 0,
    energy_used_kwh DECIMAL(8,2) DEFAULT 0,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_trips_bus_id ON trips(bus_id);
CREATE INDEX idx_trips_driver_id ON trips(driver_id);
CREATE INDEX idx_trips_status ON trips(status);
CREATE INDEX idx_trips_active ON trips(status, started_at) WHERE status = 'active';

-- Link buses and drivers to current trip for fast lookups
ALTER TABLE buses ADD CONSTRAINT fk_buses_current_trip 
    FOREIGN KEY (current_trip_id) REFERENCES trips(id) ON DELETE SET NULL;
ALTER TABLE drivers ADD CONSTRAINT fk_drivers_current_trip 
    FOREIGN KEY (current_trip_id) REFERENCES trips(id) ON DELETE SET NULL;

-- ============================================================
-- 5. CROWDSOURCED TELEMETRY LOGS (Raw passenger pings)
-- ============================================================
CREATE TABLE telemetry_logs (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    trip_id         UUID NOT NULL REFERENCES trips(id),
    bus_id          UUID NOT NULL REFERENCES buses(id),
    passenger_token VARCHAR(64) NOT NULL,                  -- Anonymized device fingerprint
    lat             DECIMAL(10, 8) NOT NULL,
    lng             DECIMAL(11, 8) NOT NULL,
    accuracy_m      DECIMAL(6,2),                          -- GPS accuracy radius
    speed_ms        DECIMAL(6,2),                          -- Device-reported speed
    heading         DECIMAL(5,2),                          -- Degrees
    battery_pct     DECIMAL(5,2),                          -- Phone battery (data quality signal)
    source          VARCHAR(20) DEFAULT 'qr_scan'          -- qr_scan, beacon, manual
                    CHECK (source IN ('qr_scan', 'beacon', 'manual', 'api')),
    recorded_at     TIMESTAMPTZ DEFAULT NOW(),
    -- Partitioning key for high-volume time-series data
    time_window     TIMESTAMPTZ GENERATED ALWAYS AS (date_trunc('minute', recorded_at)) STORED
);

-- Critical indexes for the real-time matching algorithm
CREATE INDEX idx_telemetry_trip_time ON telemetry_logs(trip_id, time_window DESC);
CREATE INDEX idx_telemetry_bus_time ON telemetry_logs(bus_id, time_window DESC);
CREATE INDEX idx_telemetry_time_window ON telemetry_logs(time_window DESC);

-- ============================================================
-- 6. AGGREGATED POSITION STREAMS (Deterministic Algorithm Output)
-- ============================================================
CREATE TABLE telemetry_aggregates (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    bus_id          UUID NOT NULL REFERENCES buses(id),
    trip_id         UUID NOT NULL REFERENCES trips(id),
    time_window     TIMESTAMPTZ NOT NULL,                  -- e.g., 30-second or 1-minute bucket
    lat_avg         DECIMAL(10, 8) NOT NULL,               -- Weighted average latitude
    lng_avg         DECIMAL(11, 8) NOT NULL,               -- Weighted average longitude
    ping_count      INTEGER NOT NULL DEFAULT 0,            -- Number of raw pings in window
    accuracy_radius_m DECIMAL(8,2),                        -- 95% confidence radius
    std_dev_lat     DECIMAL(10, 8),                        -- Standard deviation for outlier filtering
    std_dev_lng     DECIMAL(11, 8),
    computed_speed_kmh DECIMAL(6,2),                       -- Derived from position delta
    confidence_score DECIMAL(5,2) DEFAULT 0,               -- 0-100 algorithm confidence
    algorithm_version VARCHAR(16) DEFAULT 'v1.0',
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(bus_id, time_window)
);

CREATE INDEX idx_agg_bus_time ON telemetry_aggregates(bus_id, time_window DESC);
CREATE INDEX idx_agg_trip_time ON telemetry_aggregates(trip_id, time_window DESC);

-- ============================================================
-- 7. DEPOT & CHARGING INFRASTRUCTURE
-- ============================================================
CREATE TABLE depots (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    depot_code      VARCHAR(32) UNIQUE NOT NULL,           -- e.g., "DEPOT-NAMANVE"
    name            VARCHAR(128) NOT NULL,
    lat             DECIMAL(10, 8) NOT NULL,
    lng             DECIMAL(11, 8) NOT NULL,
    address         TEXT,
    total_bays      INTEGER DEFAULT 0,
    active_bays     INTEGER DEFAULT 0,
    status          VARCHAR(20) DEFAULT 'operational'
                    CHECK (status IN ('operational', 'maintenance', 'offline')),
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE charging_stations (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    depot_id        UUID NOT NULL REFERENCES depots(id),
    station_code    VARCHAR(32) UNIQUE NOT NULL,           -- e.g., "CHG-NAM-01"
    port_count      INTEGER DEFAULT 1,
    max_kw          DECIMAL(8,2) DEFAULT 60.00,            -- Charging capacity
    status          VARCHAR(20) DEFAULT 'available'
                    CHECK (status IN ('available', 'occupied', 'faulted', 'offline')),
    current_bus_id  UUID REFERENCES buses(id),
    current_session_id UUID,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_charging_depot ON charging_stations(depot_id);
CREATE INDEX idx_charging_bus ON charging_stations(current_bus_id);

-- ============================================================
-- 8. NIGHTLY LOCKDOWN & DIGITAL HANDSHAKE
-- ============================================================
CREATE TABLE nightly_locks (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    bus_id          UUID NOT NULL REFERENCES buses(id),
    depot_id        UUID NOT NULL REFERENCES depots(id),
    station_id      UUID REFERENCES charging_stations(id),
    trip_id         UUID REFERENCES trips(id),             -- Last trip before lockdown
    lock_type       VARCHAR(20) NOT NULL DEFAULT 'qr_scan'
                    CHECK (lock_type IN ('qr_scan', 'auto_geo', 'manual_override')),
    qr_signature    VARCHAR(255),                          -- Cryptographic vinyl QR hash
    driver_id       UUID REFERENCES drivers(id),
    odometer_km     DECIMAL(10,2),
    battery_pct     DECIMAL(5,2),
    energy_delivered_kwh DECIMAL(8,2) DEFAULT 0,
    handshake_state VARCHAR(20) DEFAULT 'pending'
                    CHECK (handshake_state IN ('pending', 'confirmed', 'charging', 'completed', 'faulted')),
    locked_at       TIMESTAMPTZ DEFAULT NOW(),
    unlocked_at     TIMESTAMPTZ,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_locks_bus ON nightly_locks(bus_id);
CREATE INDEX idx_locks_depot ON nightly_locks(depot_id);
CREATE INDEX idx_locks_handshake ON nightly_locks(handshake_state);

-- ============================================================
-- 9. QR VINYL STICKER REGISTRY
-- ============================================================
CREATE TABLE qr_codes (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    code_value      VARCHAR(255) UNIQUE NOT NULL,          -- The actual QR payload/hash
    type            VARCHAR(20) NOT NULL
                    CHECK (type IN ('vehicle_entry', 'vehicle_exit', 'depot_lock', 'charging_port', 'maintenance')),
    bus_id          UUID REFERENCES buses(id),
    depot_id        UUID REFERENCES depots(id),
    station_id      UUID REFERENCES charging_stations(id),
    route_id        UUID REFERENCES routes(id),
    is_active       BOOLEAN DEFAULT true,
    print_batch     VARCHAR(32),                           -- For vinyl production tracking
    expires_at      TIMESTAMPTZ,
    scan_count      INTEGER DEFAULT 0,
    last_scanned_at TIMESTAMPTZ,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_qr_code_value ON qr_codes(code_value);
CREATE INDEX idx_qr_bus ON qr_codes(bus_id);
CREATE INDEX idx_qr_active ON qr_codes(is_active);

-- ============================================================
-- 10. ENERGY & CHARGING SESSIONS (For analytics.html)
-- ============================================================
CREATE TABLE charging_sessions (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    station_id      UUID NOT NULL REFERENCES charging_stations(id),
    bus_id          UUID NOT NULL REFERENCES buses(id),
    lock_id         UUID REFERENCES nightly_locks(id),
    start_time      TIMESTAMPTZ DEFAULT NOW(),
    end_time        TIMESTAMPTZ,
    start_soc_pct   DECIMAL(5,2),                          -- State of Charge start
    end_soc_pct     DECIMAL(5,2),
    energy_kwh      DECIMAL(8,2) DEFAULT 0,
    peak_kw         DECIMAL(6,2),
    avg_kw          DECIMAL(6,2),
    duration_min    INTEGER,
    cost_ugx        DECIMAL(12,2),                         -- Ugandan Shillings
    status          VARCHAR(20) DEFAULT 'active'
                    CHECK (status IN ('active', 'completed', 'interrupted', 'faulted')),
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_charging_sessions_station ON charging_sessions(station_id);
CREATE INDEX idx_charging_sessions_bus ON charging_sessions(bus_id);
CREATE INDEX idx_charging_sessions_time ON charging_sessions(start_time DESC);

-- ============================================================
-- 11. AUDIT & SYSTEM LOGS
-- ============================================================
CREATE TABLE audit_logs (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    table_name      VARCHAR(64) NOT NULL,
    record_id       UUID NOT NULL,
    action          VARCHAR(20) NOT NULL CHECK (action IN ('INSERT', 'UPDATE', 'DELETE')),
    old_data        JSONB,
    new_data        JSONB,
    actor_id        UUID,                                  -- Admin/driver UUID if known
    actor_type      VARCHAR(20) DEFAULT 'system',
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_audit_table ON audit_logs(table_name, record_id);
CREATE INDEX idx_audit_created ON audit_logs(created_at DESC);

-- ============================================================
-- FUNCTIONS & TRIGGERS
-- ============================================================

-- Auto-update 'updated_at' timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_buses_updated_at BEFORE UPDATE ON buses
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_drivers_updated_at BEFORE UPDATE ON drivers
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_trips_updated_at BEFORE UPDATE ON trips
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_nightly_locks_updated_at BEFORE UPDATE ON nightly_locks
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Auto-update bus last_known location when aggregate is inserted
CREATE OR REPLACE FUNCTION update_bus_location_from_aggregate()
RETURNS TRIGGER AS $$
BEGIN
    UPDATE buses 
    SET last_known_lat = NEW.lat_avg,
        last_known_lng = NEW.lng_avg,
        last_updated_at = NOW()
    WHERE id = NEW.bus_id;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_update_bus_location
    AFTER INSERT ON telemetry_aggregates
    FOR EACH ROW EXECUTE FUNCTION update_bus_location_from_aggregate();

-- Seed sample data for Kampala corridors
INSERT INTO routes (route_code, name, corridor_type, path_geojson, stops, distance_km, est_duration_min) VALUES
('KLA-ENTEBBE', 'Kampala - Entebbe Express', 'intercity', 
 '{"type":"LineString","coordinates":[[32.5825,0.3136],[32.5600,0.2800],[32.5200,0.2200],[32.4600,0.1800],[32.4434,0.0514]]}',
 '[{"name":"Kampala City Square","lat":0.3136,"lng":32.5825,"sequence":1},{"name":"Kibuye Roundabout","lat":0.2800,"lng":32.5600,"sequence":2},{"name":"Abaita Ababiri","lat":0.2200,"lng":32.5200,"sequence":3},{"name":"Lutembe","lat":0.1800,"lng":32.4600,"sequence":4},{"name":"Entebbe Airport","lat":0.0514,"lng":32.4434,"sequence":5}]',
 42.5, 75),

('KLA-JINJA', 'Kampala - Jinja Highway', 'intercity',
 '{"type":"LineString","coordinates":[[32.5825,0.3136],[32.6500,0.3500],[32.7200,0.4000],[32.8000,0.4200],[32.9000,0.4500],[33.2000,0.4500]]}',
 '[{"name":"Kampala City Square","lat":0.3136,"lng":32.5825,"sequence":1},{"name":"Namanve Industrial Park","lat":0.3500,"lng":32.6500,"sequence":2},{"name":"Mukono","lat":0.4000,"lng":32.7200,"sequence":3},{"name":"Seeta","lat":0.4200,"lng":32.8000,"sequence":4},{"name":"Lugazi","lat":0.4500,"lng":32.9000,"sequence":5},{"name":"Jinja Town","lat":0.4500,"lng":33.2000,"sequence":6}]',
 85.0, 120),

('KLA-NAKAWA', 'Kampala - Nakawa Urban', 'urban',
 '{"type":"LineString","coordinates":[[32.5825,0.3136],[32.6000,0.3200],[32.6200,0.3300],[32.6400,0.3400]]}',
 '[{"name":"Constitution Square","lat":0.3136,"lng":32.5825,"sequence":1},{"name":"Clock Tower","lat":0.3200,"lng":32.6000,"sequence":2},{"name":"Industrial Area","lat":0.3300,"lng":32.6200,"sequence":3},{"name":"Nakawa Market","lat":0.3400,"lng":32.6400,"sequence":4}]',
 8.2, 25),

('KLA-BWEYOGERERE', 'Kampala - Bweyogerere', 'urban',
 '{"type":"LineString","coordinates":[[32.5825,0.3136],[32.6100,0.3200],[32.6500,0.3300],[32.6800,0.3400],[32.7000,0.3500]]}',
 '[{"name":"Constitution Square","lat":0.3136,"lng":32.5825,"sequence":1},{"name":"Kireka","lat":0.3200,"lng":32.6100,"sequence":2},{"name":"Banda","lat":0.3300,"lng":32.6500,"sequence":3},{"name":"Namboole","lat":0.3400,"lng":32.6800,"sequence":4},{"name":"Bweyogerere","lat":0.3500,"lng":32.7000,"sequence":5}]',
 15.5, 40);

INSERT INTO depots (depot_code, name, lat, lng, address, total_bays, active_bays) VALUES
('DEPOT-NAMANVE', 'Namanve Central Depot', 0.3500, 32.6500, 'Namanve Industrial Area, Mukono District', 12, 8),
('DEPOT-KAWEMPE', 'Kawempe North Depot', 0.3800, 32.5500, 'Kawempe Division, Kampala', 8, 6),
('DEPOT-ENTEBBE', 'Entebbe Airport Depot', 0.0514, 32.4434, 'Entebbe International Airport Grounds', 6, 4);
