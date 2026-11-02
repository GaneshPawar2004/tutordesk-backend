const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const morgan = require('morgan');

const config = require('./config');
const db = require('./db');
const { requireAuth, requireOwner } = require('./middleware/auth');
const { notFoundHandler, errorHandler } = require('./middleware/error');

function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(helmet());
  app.use(cors({ origin: config.corsOrigins.length ? config.corsOrigins : false }));
  app.use(express.json({ limit: '1mb' }));
  if (!config.isTest) app.use(morgan(config.isProd ? 'combined' : 'dev'));

  // Keep-alive for uptime pingers: never touches the database, so Neon can still sleep.
  app.get(['/health', '/api/ping'], (_req, res) => res.json({ ok: true }));
  // Render's health check: also confirms the database answers.
  app.get('/api/health', async (_req, res) => {
    await db.query('select 1');
    res.json({ ok: true, database: 'connected' });
  });

  const api = express.Router();
  api.use('/auth', require('./routes/auth'));
  api.use('/admin', require('./routes/admin'));

  // Everything below needs a signed-in user.
  api.use(requireAuth);
  api.use('/', require('./routes/overview'));
  api.use('/classes', require('./routes/classes'));
  api.use('/classes/:classId/attendance', require('./routes/attendance'));
  api.use('/', require('./routes/students'));
  api.use('/', require('./routes/tests'));
  api.use('/', require('./routes/fees'));
  api.use('/users', requireOwner, require('./routes/users'));

  app.use('/api/v1', api);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
