import express from 'express';

import { HttpError } from './lib/errors.js';
import { authenticate } from './middleware/auth.js';
import { attendanceRoutes } from './routes/attendance.js';
import { authRoutes } from './routes/auth.js';
import { coreRoutes } from './routes/core.js';
import { examRoutes } from './routes/exams.js';
import { feeRoutes } from './routes/fees.js';
import { messageRoutes } from './routes/messages.js';
import { staffRoutes } from './routes/staff.js';
import { studentRoutes } from './routes/students.js';
import { syncRoutes } from './routes/sync.js';
import { createMessaging } from './services/messaging.js';
import { rateLimit } from './middleware/rate-limit.js';

export function createApp({ db, secret, simulateSms = true, smsSpeed = 1, allowedOrigins = [] }) {
  if (!secret) throw new Error('createApp requires a token secret');
  if (!db) throw new Error('createApp requires a database');
  const messaging = createMessaging(db, { simulate: simulateSms, speed: smsSpeed });
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', 1); // behind Render's proxy: req.ip is the real client
  app.use(express.json({ limit: '300kb' }));
  // Browsers: only the listed web origins (any origin when the list is empty,
  // e.g. local dev). The mobile app sends no Origin header and is unaffected.
  app.use((req, res, next) => {
    const origin = req.get('origin');
    if (origin && allowedOrigins.length && !allowedOrigins.includes(origin)) {
      return res.status(403).json({ error: { code: 'forbidden_origin', message: 'This website may not use the API' } });
    }
    res.set('Access-Control-Allow-Origin', origin ?? '*');
    res.set('Vary', 'Origin');
    res.set('Access-Control-Allow-Headers', 'content-type, authorization');
    res.set('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  // Keep-alive for uptime pingers: never touches the database, so Neon can still sleep.
  app.get('/api/ping', (_req, res) => res.json({ ok: true }));
  app.get('/api/health', async (_req, res) => {
    await db.query('select 1');
    res.json({ ok: true, database: 'connected' });
  });
  app.use('/api/auth', rateLimit({ windowMs: 15 * 60_000, max: 30 }), authRoutes(db, secret));

  const api = express.Router();
  api.use(authenticate(db, secret));
  for (const routes of [coreRoutes, studentRoutes, attendanceRoutes, feeRoutes, staffRoutes, examRoutes, syncRoutes]) api.use(routes(db));
  api.use(messageRoutes(db, messaging));
  app.use('/api', api);

  app.use('/api', (_req, res) => res.status(404).json({ error: { code: 'not_found', message: 'No such endpoint' } }));

  app.use((err, _req, res, _next) => {
    if (err instanceof HttpError) {
      return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    }
    if (err?.type === 'entity.parse.failed') {
      return res.status(400).json({ error: { code: 'bad_request', message: 'Malformed JSON body' } });
    }
    console.error(err);
    res.status(500).json({ error: { code: 'internal', message: 'Something went wrong' } });
  });

  app.locals.close = () => messaging.close();
  return app;
}
