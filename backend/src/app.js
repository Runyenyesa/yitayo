const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

const { errorHandler } = require('./middleware/errorHandler');
const passengerRoutes = require('./routes/passenger');
const fleetRoutes = require('./routes/fleet');
const driverRoutes = require('./routes/driver');
const adminRoutes = require('./routes/admin');
const analyticsRoutes = require('./routes/analytics');

const app = express();
const PORT = process.env.PORT || 3000;

// Security middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      connectSrc: ["'self'", "ws:", "wss:"],
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'"], // Required for Leaflet
      styleSrc: ["'self'", "'unsafe-inline'", "https:"],
      imgSrc: ["'self'", "data:", "https:", "*.tile.openstreetmap.org"],
    },
  },
}));

app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Admin-API-Key'],
}));

app.use(compression());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Rate limiting
const limiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 100, // 100 requests per minute
  message: { success: false, error: { code: 'RATE_LIMIT', message: 'Too many requests, please try again later.' } },
});
app.use('/api/', limiter);

// Stricter rate limit for passenger checkins (high frequency endpoint)
const checkinLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 30,
  message: { success: false, error: { code: 'RATE_LIMIT', message: 'Check-in rate limit exceeded.' } },
});
app.use('/api/passenger/checkin', checkinLimiter);

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    service: 'yitayo-backend',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
  });
});

// API Routes
app.use('/api/passenger', passengerRoutes);
app.use('/api/fleet', fleetRoutes);
app.use('/api/driver', driverRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/analytics', analyticsRoutes);

// 404 handler
app.use((req, res, next) => {
  const err = new Error('Endpoint not found');
  err.status = 404;
  err.code = 'NOT_FOUND';
  next(err);
});

// Global error handler
app.use(errorHandler);

// Start server
app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════════════════════╗
║                                                            ║
║   YITAYO TRANSIT PLATFORM — BACKEND ONLINE                 ║
║   Zero-Hardware Crowdsourced Transit Grid                  ║
║                                                            ║
║   Port: ${PORT.toString().padEnd(52)}║
║   Environment: ${(process.env.NODE_ENV || 'development').padEnd(45)}║
║   Database: ${(process.env.DATABASE_URL ? 'Connected' : 'Not Configured').padEnd(48)}║
║                                                            ║
╚════════════════════════════════════════════════════════════╝
  `);
});

module.exports = app;
