import { randomBytes } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';

import { createApp } from './app.js';
import { createDb } from './db/index.js';
import { migrate } from './db/schema.js';

try {
  process.loadEnvFile('.env');
} catch {
  // No .env file — environment variables must be set another way.
}

const port = Number(process.env.PORT ?? 4000);
let secret = process.env.TOKEN_SECRET;
const hosted = process.env.NODE_ENV === 'production' || Boolean(process.env.RENDER);
if ((!secret || secret === 'change-me') && hosted) {
  // A generated secret would be lost on every redeploy and log everyone out.
  console.error('TOKEN_SECRET must be set in the hosting environment.');
  process.exit(1);
}
if (!secret || secret === 'change-me') {
  // Persist a random secret so logins survive restarts.
  secret = randomBytes(32).toString('hex');
  try {
    appendFileSync('.env', `\nTOKEN_SECRET=${secret}\n`);
  } catch {
    console.warn('Could not save TOKEN_SECRET to .env; logins will reset on restart.');
  }
}

const db = createDb({ url: process.env.DATABASE_URL ?? process.env.NEON_DB_URL });
await migrate(db);

const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? '').split(',').map((o) => o.trim().replace(/\/+$/, '')).filter(Boolean);
const app = createApp({ db, secret, simulateSms: process.env.SMS_SIMULATION !== 'off', allowedOrigins });
app.listen(port, '0.0.0.0', () => {
  const lan = Object.values(networkInterfaces()).flat().filter((i) => i?.family === 'IPv4' && !i.internal).map((i) => i.address);
  console.log(`Tuition API on http://localhost:${port}`);
  for (const ip of lan) console.log(`  on your network: http://${ip}:${port}`);
  console.log(`Database connected · CORS: ${allowedOrigins.length ? allowedOrigins.join(', ') : 'any origin'}`);
});
