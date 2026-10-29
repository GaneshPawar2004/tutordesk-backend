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

export function createApp({ db, secret, simulateSms = true, smsSpeed = 1 }) {
  if (!secret) throw new Error('createApp requires a token secret');
  if (!db) throw new Error('createApp requires a database');
  const messaging = createMessaging(db, { simulate: simulateSms, speed: smsSpeed });
  const app = express();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '300kb' }));
  // Allow the web app (dev server or another origin) and the mobile app to call the API.
  app.use((req, res, next) => {
    res.set('Access-Control-Allow-Origin', req.get('origin') ?? '*');
    res.set('Access-Control-Allow-Headers', 'content-type, authorization');
    res.set('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  app.get('/api/health', async (_req, res) => {
    await db.query('select 1');
    res.json({ ok: true, database: 'connected' });
  });
  app.use('/api/auth', authRoutes(db, secret));

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
