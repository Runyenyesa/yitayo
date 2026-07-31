# Frontend Integration Guide

This guide shows you how to refactor your existing static `app.js` and HTML files to consume the live backend API.

## 1. Add a Config Module

Create `config.js` in your repo root (next to `app.js`):

```javascript
// config.js
const CONFIG = {
  API_BASE: window.location.hostname === 'localhost' 
    ? 'http://localhost:3000/api' 
    : 'https://api.yitayo.go.ug/api', // Change to your production API domain

  MAP_CENTER: [0.3136, 32.5825], // Kampala
  REFRESH_INTERVAL: 15000, // 15 seconds for live fleet
};
```

## 2. Create an API Service Layer

Create `services/api.js`:

```javascript
// services/api.js
class YitayoAPI {
  constructor() {
    this.baseUrl = CONFIG.API_BASE;
  }

  async request(endpoint, options = {}) {
    const url = `${this.baseUrl}${endpoint}`;
    const defaults = {
      headers: {
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      },
    };

    const res = await fetch(url, { ...defaults, ...options });
    const data = await res.json();

    if (!data.success) {
      throw new Error(data.error?.message || 'API Error');
    }
    return data.data;
  }

  // Passenger endpoints
  async checkin(payload) {
    return this.request('/passenger/checkin', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  async getRoutes(search, corridorType) {
    const params = new URLSearchParams();
    if (search) params.append('search', search);
    if (corridorType) params.append('corridorType', corridorType);
    return this.request(`/passenger/routes?${params}`);
  }

  async getRouteLive(routeId) {
    return this.request(`/passenger/routes/${routeId}/live`);
  }

  // Fleet endpoints
  async getLiveFleet(minConfidence = 40) {
    return this.request(`/fleet/live?minConfidence=${minConfidence}`);
  }

  async getBusHistory(assetId, limit = 100) {
    return this.request(`/fleet/buses/${assetId}/history?limit=${limit}`);
  }

  // Driver endpoints
  async startShift(payload) {
    return this.request('/driver/shift/start', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  async endShift(payload) {
    return this.request('/driver/shift/end', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  async lockdownDepot(payload) {
    return this.request('/driver/lockdown', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  // Admin endpoints
  async getAdminDashboard(apiKey) {
    return this.request('/admin/dashboard', {
      headers: { 'X-Admin-API-Key': apiKey },
    });
  }

  async provisionQR(payload, apiKey) {
    return this.request('/admin/qr-codes', {
      method: 'POST',
      headers: { 'X-Admin-API-Key': apiKey },
      body: JSON.stringify(payload),
    });
  }

  // Analytics endpoints
  async getEnergyAnalytics(period = '24h') {
    return this.request(`/analytics/energy?period=${period}`);
  }

  async getGridHealth(period = '24h') {
    return this.request(`/analytics/grid-health?period=${period}`);
  }

  async getDepotStatus() {
    return this.request('/analytics/depot-status');
  }
}

const api = new YitayoAPI();
```

## 3. Refactor index.html (Public Commuter Portal)

Replace your static route list with:

```javascript
// In your app.js or index page script
async function loadCorridors() {
  try {
    const routes = await api.getRoutes();
    const container = document.getElementById('corridor-list');
    container.innerHTML = routes.map(route => `
      <div class="corridor-card" data-route-id="${route.id}">
        <h3>${route.name}</h3>
        <p>${route.route_code} • ${route.distance_km}km • ~${route.est_duration_min}min</p>
        <div class="live-indicator" id="live-${route.id}">Loading live buses...</div>
      </div>
    `).join('');

    // Load live data for each corridor
    routes.forEach(route => loadCorridorLive(route.id));
  } catch (err) {
    console.error('Failed to load corridors:', err);
    showError('Unable to load routes. Please check your connection.');
  }
}

async function loadCorridorLive(routeId) {
  try {
    const liveBuses = await api.getRouteLive(routeId);
    const indicator = document.getElementById(`live-${routeId}`);
    if (liveBuses.length === 0) {
      indicator.innerHTML = '<span class="text-gray-500">No active buses</span>';
    } else {
      indicator.innerHTML = `
        <span class="text-green-600 font-semibold">${liveBuses.length} bus${liveBuses.length > 1 ? 'es' : ''} active</span>
        <span class="text-sm text-gray-500"> • ${liveBuses[0].passenger_beacon_count} passengers tracking</span>
      `;
    }
  } catch (err) {
    console.warn(`Failed to load live data for route ${routeId}:`, err);
  }
}

// Call on page load
document.addEventListener('DOMContentLoaded', loadCorridors);
```

## 4. Refactor passenger.html (QR Scan Portal)

```javascript
async function handleQRScan(qrValue) {
  // Get geolocation
  if (!navigator.geolocation) {
    showError('Geolocation is required to anchor this bus.');
    return;
  }

  navigator.geolocation.getCurrentPosition(
    async (position) => {
      try {
        const busAssetId = extractBusFromQR(qrValue); // Your existing QR parser

        const result = await api.checkin({
          busAssetId,
          lat: position.coords.latitude,
          lng: position.coords.longitude,
          accuracy: position.coords.accuracy,
          speed: position.coords.speed,
          heading: position.coords.heading,
          batteryPct: await getBatteryLevel(),
          passengerToken: getPersistentDeviceToken(), // anon fingerprint
          qrCode: qrValue,
        });

        showSuccess(result.message);
        if (result.trip) {
          updateTripDisplay(result.trip);
        }
      } catch (err) {
        showError(err.message);
      }
    },
    (err) => showError('Please enable location services to power the grid.'),
    { enableHighAccuracy: true, timeout: 10000 }
  );
}

async function getBatteryLevel() {
  if ('getBattery' in navigator) {
    const battery = await navigator.getBattery();
    return Math.round(battery.level * 100);
  }
  return null;
}

function getPersistentDeviceToken() {
  let token = localStorage.getItem('yitayo_device_token');
  if (!token) {
    token = 'dev_' + Math.random().toString(36).substr(2, 16) + Date.now();
    localStorage.setItem('yitayo_device_token', token);
  }
  return token;
}
```

## 5. Refactor driver.html (Shift Console)

```javascript
async function startShift() {
  const driverId = document.getElementById('driver-id').value;
  const pin = document.getElementById('driver-pin').value;
  const busAssetId = document.getElementById('bus-asset-id').value;
  const routeId = document.getElementById('route-select').value;

  try {
    const trip = await api.startShift({ driverId, pin, busAssetId, routeId, direction: 'outbound' });
    localStorage.setItem('yitayo_active_trip', JSON.stringify(trip));
    window.location.href = '/driver-dashboard.html';
  } catch (err) {
    showError(err.message);
  }
}

async function endShift() {
  const trip = JSON.parse(localStorage.getItem('yitayo_active_trip'));
  const driverId = document.getElementById('driver-id').value;
  const busAssetId = document.getElementById('bus-asset-id').value;

  try {
    await api.endShift({ driverId, busAssetId, energyUsedKwh: getBusEnergyUsed() });
    localStorage.removeItem('yitayo_active_trip');
    showSuccess('Shift ended. Thank you.');
  } catch (err) {
    showError(err.message);
  }
}

async function lockdownAtDepot() {
  const depotId = document.getElementById('depot-select').value;
  const stationId = document.getElementById('station-select').value;
  const qrSignature = document.getElementById('depot-qr').value;
  const driverId = document.getElementById('driver-id').value;
  const busAssetId = document.getElementById('bus-asset-id').value;

  try {
    const result = await api.lockdownDepot({
      driverId,
      busAssetId,
      depotId,
      stationId,
      qrSignature,
      odometerKm: getOdometer(),
      batteryPct: getBusBattery(),
    });

    if (result.chargingSession) {
      showSuccess(`Depot locked. Charging started at ${result.chargingSession.startSoc}% SoC.`);
    } else {
      showSuccess('Depot locked. Awaiting charging station.');
    }
  } catch (err) {
    showError(err.message);
  }
}
```

## 6. Refactor admin.html (Control Room)

```javascript
let fleetRefreshInterval;

async function loadAdminDashboard() {
  const apiKey = sessionStorage.getItem('admin_api_key');
  if (!apiKey) {
    showLoginModal();
    return;
  }

  try {
    const dashboard = await api.getAdminDashboard(apiKey);
    updateMetrics(dashboard.metrics);
    updateAlerts(dashboard.alerts);
    startFleetRefresh(apiKey);
  } catch (err) {
    if (err.message.includes('Unauthorized')) {
      sessionStorage.removeItem('admin_api_key');
      showLoginModal();
    }
  }
}

async function refreshFleetMap() {
  try {
    const fleet = await api.getLiveFleet(40); // min 40% confidence

    // Clear old markers
    clearFleetMarkers();

    fleet.forEach(bus => {
      if (!bus.position.lat || !bus.position.lng) return;

      const color = bus.telemetry.confidenceScore >= 70 ? 'green' 
                  : bus.telemetry.confidenceScore >= 40 ? 'orange' 
                  : 'red';

      addMapMarker({
        lat: bus.position.lat,
        lng: bus.position.lng,
        label: bus.assetId,
        color,
        popup: `
          <strong>${bus.assetId}</strong><br>
          Route: ${bus.trip?.routeName || 'N/A'}<br>
          Driver: ${bus.trip?.driverName || 'N/A'}<br>
          Speed: ${bus.telemetry.computedSpeedKmh?.toFixed(1) || 0} km/h<br>
          Confidence: ${bus.telemetry.confidenceScore}%<br>
          Beacons: ${bus.trip?.passengerBeaconCount || 0}<br>
          Last update: ${new Date(bus.position.lastUpdated).toLocaleTimeString()}
        `,
      });
    });

    updateFleetCounter(fleet.length);
  } catch (err) {
    console.error('Fleet refresh failed:', err);
  }
}

function startFleetRefresh(apiKey) {
  refreshFleetMap();
  fleetRefreshInterval = setInterval(refreshFleetMap, CONFIG.REFRESH_INTERVAL);
}

// Stop refresh when leaving page
window.addEventListener('beforeunload', () => {
  if (fleetRefreshInterval) clearInterval(fleetRefreshInterval);
});
```

## 7. Refactor qr-matrix.html (QR Provisioning)

```javascript
async function generateQR() {
  const apiKey = sessionStorage.getItem('admin_api_key');
  const type = document.getElementById('qr-type').value;
  const busId = document.getElementById('qr-bus').value || null;
  const depotId = document.getElementById('qr-depot').value || null;
  const expiresDays = parseInt(document.getElementById('qr-expires').value) || 365;

  try {
    const result = await api.provisionQR({ type, bus_id: busId, depot_id: depotId, expires_days: expiresDays }, apiKey);

    // Render QR code using your existing library (e.g., qrcode.js)
    QRCode.toCanvas(document.getElementById('qr-canvas'), result.qrCode.code_value, {
      width: 256,
      margin: 2,
    });

    document.getElementById('qr-value').textContent = result.qrCode.code_value;
    document.getElementById('qr-meta').textContent = `Type: ${type} | Expires: ${expiresDays} days`;
  } catch (err) {
    showError(err.message);
  }
}
```

## 8. Refactor analytics.html (Operations Intelligence)

```javascript
async function loadEnergyAnalytics(period = '24h') {
  try {
    const data = await api.getEnergyAnalytics(period);

    // Update efficiency table
    const tbody = document.getElementById('efficiency-table');
    tbody.innerHTML = data.fleetEfficiency.map(bus => `
      <tr>
        <td>${bus.asset_id}</td>
        <td>${bus.trip_count}</td>
        <td>${bus.total_distance_km} km</td>
        <td>${bus.total_energy_kwh} kWh</td>
        <td class="${bus.kwh_per_km > 1.5 ? 'text-red-600' : 'text-green-600'}">${bus.kwh_per_km} kWh/km</td>
      </tr>
    `).join('');

    // Update station utilization
    updateStationCards(data.stationUtilization);

    // Update chart (using your existing chart library)
    updateEnergyChart(data.energyTimeseries);
  } catch (err) {
    console.error('Energy analytics failed:', err);
  }
}

async function loadGridHealth() {
  try {
    const data = await api.getGridHealth();
    updateCoverageTable(data.routeCoverage);
    updateQualityChart(data.qualityDistribution);
  } catch (err) {
    console.error('Grid health failed:', err);
  }
}
```

## 9. CORS Configuration

If your frontend is served from GitHub Pages (or any static host), update `backend/src/app.js`:

```javascript
app.use(cors({
  origin: [
    'https://runyenyesa.github.io',  // Your GitHub Pages domain
    'http://localhost:8080',          // Local dev
  ],
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Admin-API-Key'],
}));
```

## 10. WebSocket Upgrade (Optional Phase 3)

For real-time map updates without polling, add Socket.IO:

```javascript
// In backend/src/app.js
const io = require('socket.io')(server, { cors: { origin: '*' } });

// Emit fleet updates when new aggregates are computed
io.emit('fleet:update', { busId, position, confidence });

// In frontend
const socket = io('https://api.yitayo.go.ug');
socket.on('fleet:update', (data) => {
  updateMapMarker(data.busId, data.position.lat, data.position.lng);
});
```
