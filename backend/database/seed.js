const db = require('./src/config/database');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

async function seed() {
  console.log('Seeding demo data...');

  // Seed buses
  const buses = [
    { asset_id: 'KMC-EVS-001', chassis: 'KMC2024CH001', vin: 'KMC001EV202400001', battery: 250, seats: 90 },
    { asset_id: 'KMC-EVS-002', chassis: 'KMC2024CH002', vin: 'KMC001EV202400002', battery: 250, seats: 90 },
    { asset_id: 'KMC-EVS-003', chassis: 'KMC2024CH003', vin: 'KMC001EV202400003', battery: 250, seats: 90 },
    { asset_id: 'KMC-EVS-004', chassis: 'KMC2024CH004', vin: 'KMC001EV202400004', battery: 250, seats: 90 },
  ];

  for (const b of buses) {
    await db.query(`
      INSERT INTO buses (id, asset_id, chassis_number, vin, battery_capacity_kwh, seating_capacity, status, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, 'depot', NOW())
      ON CONFLICT (asset_id) DO NOTHING;
    `, [uuidv4(), b.asset_id, b.chassis, b.vin, b.battery, b.seats]);
  }

  // Seed drivers
  const pinHash = await bcrypt.hash('1234', 10);
  const drivers = [
    { driver_id: 'MOWT-DRV-001', name: 'John Okello', license: 'UG-DRV-001', phone: '+256701234567' },
    { driver_id: 'MOWT-DRV-002', name: 'Sarah Auma', license: 'UG-DRV-002', phone: '+256702345678' },
    { driver_id: 'MOWT-DRV-003', name: 'Peter Ochola', license: 'UG-DRV-003', phone: '+256703456789' },
  ];

  for (const d of drivers) {
    await db.query(`
      INSERT INTO drivers (id, driver_id, full_name, license_number, phone, pin_hash, status, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, 'off_duty', NOW())
      ON CONFLICT (driver_id) DO NOTHING;
    `, [uuidv4(), d.driver_id, d.name, d.license, d.phone, pinHash]);
  }

  // Seed charging stations
  const stations = [
    { depot: 'DEPOT-NAMANVE', code: 'CHG-NAM-01', kw: 120 },
    { depot: 'DEPOT-NAMANVE', code: 'CHG-NAM-02', kw: 120 },
    { depot: 'DEPOT-NAMANVE', code: 'CHG-NAM-03', kw: 60 },
    { depot: 'DEPOT-KAWEMPE', code: 'CHG-KAW-01', kw: 120 },
    { depot: 'DEPOT-KAWEMPE', code: 'CHG-KAW-02', kw: 60 },
    { depot: 'DEPOT-ENTEBBE', code: 'CHG-ENT-01', kw: 120 },
  ];

  for (const s of stations) {
    const depotRes = await db.query(`SELECT id FROM depots WHERE depot_code = $1`, [s.depot]);
    if (depotRes.rows.length > 0) {
      await db.query(`
        INSERT INTO charging_stations (id, depot_id, station_code, max_kw, status, created_at)
        VALUES ($1, $2, $3, $4, 'available', NOW())
        ON CONFLICT (station_code) DO NOTHING;
      `, [uuidv4(), depotRes.rows[0].id, s.code, s.kw]);
    }
  }

  console.log('✓ Seed complete!');
  process.exit(0);
}

seed().catch(err => {
  console.error('Seed failed:', err);
  process.exit(1);
});
