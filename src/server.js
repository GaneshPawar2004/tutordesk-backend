import { randomBytes } from 'node:crypto';

import { createApp } from './app.js';

try {
  process.loadEnvFile('.env');
} catch {
  // No .env file — defaults below apply.
}
const port = Number(process.env.PORT ?? 4000);
let secret = process.env.TOKEN_SECRET;
if (!secret || secret === 'change-me') {
  // Fine for local demos: tokens simply stop working after a restart.
  secret = randomBytes(32).toString('hex');
}

const app = createApp({ secret, simulateSms: process.env.SMS_SIMULATION !== 'off' });
app.listen(port, () => {
  console.log(`Tuition API listening on http://localhost:${port} (in-memory demo data — resets on restart)`);
});
