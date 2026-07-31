# Yitayo — Backend Integration Guide

This `backend/` folder contains the complete production API for the Yitayo Transit Platform.

## Repository Structure

```
yitayo/
├── index.html          ← Your existing frontend (public commuter portal)
├── passenger.html      ← Your existing frontend
├── driver.html         ← Your existing frontend
├── admin.html          ← Your existing frontend
├── qr-matrix.html      ← Your existing frontend
├── analytics.html      ← Your existing frontend
├── app.js              ← Your existing frontend router (to be refactored)
├── backend/            ← NEW: Production Node.js API
│   ├── src/
│   │   ├── app.js                 ← Express server entry
│   │   ├── config/database.js     ← PostgreSQL pool config
│   │   ├── middleware/
│   │   │   └── errorHandler.js    ← Global error handling + Winston logging
│   │   ├── routes/
│   │   │   ├── passenger.js       ← POST /checkin, GET /routes, GET /routes/:id/live
│   │   │   ├── fleet.js           ← GET /live, GET /buses, GET /buses/:id/history
│   │   │   ├── driver.js          ← POST /shift/start, POST /shift/end, POST /lockdown
│   │   │   ├── admin.js           ← Dashboard, CRUD buses/drivers/routes, QR provisioning
│   │   │   └── analytics.js       ← Energy, grid-health, depot-status
│   │   └── services/
│   │       └── telemetryService.js ← Deterministic Algorithmic Matching Engine
│   ├── database/
│   │   └── schema.sql             ← Full PostgreSQL + PostGIS schema
│   ├── package.json
│   ├── docker-compose.yml
│   ├── Dockerfile
│   ├── .env.example
│   └── .gitignore
└── README.md
```

## Quick Start

### 1. Add backend to your repo
```bash
cd yitayo
git checkout -b backend-phase2
# Copy the backend/ folder into your repo root
git add backend/
git commit -m "feat: add production backend API (Phase 2)"
git push origin backend-phase2
```

### 2. Configure environment
```bash
cd backend
cp .env.example .env
# Edit .env with your actual database credentials and secrets
```

### 3. Start the database
```bash
docker-compose up -d postgres redis
```

### 4. Run migrations
```bash
psql $DATABASE_URL -f database/schema.sql
```

### 5. Install & run API
```bash
npm install
npm run dev   # Development with nodemon
# OR
npm start     # Production
```

### 6. Refactor your frontend `app.js`
Replace static data with dynamic API calls. See `backend/FRONTEND_INTEGRATION.md` for the full migration guide.

## API Endpoints Summary

| Endpoint | Method | Description | Used By |
|----------|--------|-------------|---------|
| `/api/passenger/checkin` | POST | Passenger QR scan + GPS anchor | passenger.html |
| `/api/passenger/routes` | GET | List active corridors | index.html |
| `/api/passenger/routes/:id/live` | GET | Live buses on a corridor | index.html |
| `/api/fleet/live` | GET | Real-time fleet positions | admin.html |
| `/api/fleet/buses` | GET | Full fleet registry | qr-matrix.html |
| `/api/driver/shift/start` | POST | Driver PIN auth + trip start | driver.html |
| `/api/driver/lockdown` | POST | Depot arrival + charging handshake | driver.html |
| `/api/admin/dashboard` | GET | Control room metrics | admin.html |
| `/api/admin/qr-codes` | POST | Generate vinyl QR stickers | qr-matrix.html |
| `/api/analytics/energy` | GET | kWh/km efficiency | analytics.html |
| `/api/analytics/grid-health` | GET | Data quality metrics | analytics.html |

## Deployment

The included `docker-compose.yml` is production-ready. For MoWT deployment:
1. Set `NODE_ENV=production`
2. Use a managed PostgreSQL instance (AWS RDS, DigitalOcean, or self-hosted)
3. Configure `DATABASE_URL` with SSL
4. Set strong `JWT_SECRET` and `ADMIN_API_KEY`
5. Run behind Nginx or Caddy with reverse proxy + SSL

## Deterministic Algorithm

The core positioning engine (`src/services/telemetryService.js`) converts raw passenger GPS pings into reliable bus positions through:
- **Weighted Moving Average**: Weights by GPS accuracy, phone battery (jitter proxy), and recency
- **Statistical Outlier Rejection**: Removes pings beyond 2.5 standard deviations
- **Confidence Scoring**: 0-100 score based on ping density, cluster tightness, and data freshness
- **Derived Speed**: Computed from position deltas between time windows

No physical GPS hardware required on the bus.
