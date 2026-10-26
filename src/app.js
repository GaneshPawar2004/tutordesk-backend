import express from 'express';

import { Store } from './data/store.js';
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
import { createMessaging } from './services/messaging.js';

export function createApp({ secret, now, simulateSms = true, smsSpeed = 1 } = {}) {
  if (!secret) throw new Error('createApp requires a token secret');
  const store = new Store({ now });
  const messaging = createMessaging({ simulate: simulateSms, speed: smsSpeed });
  const app = express();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '200kb' }));

  app.get('/api/health', (_req, res) => res.json({ ok: true, mode: 'in-memory demo' }));
  app.use('/api/auth', authRoutes(store, secret));

  const api = express.Router();
  api.use(authenticate(store, secret));
  api.use(coreRoutes());
  api.use(studentRoutes());
  api.use(attendanceRoutes());
  api.use(feeRoutes());
  api.use(staffRoutes());
  api.use(examRoutes());
  api.use(messageRoutes(messaging));
  app.use('/api', api);

  app.use('/api', (_req, res) => res.status(404).json({ error: { code: 'not_found', message: 'No such endpoint' } }));

  // Express 5 forwards thrown and rejected errors here.
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
