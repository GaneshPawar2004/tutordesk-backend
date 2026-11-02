const config = require('./config');
const db = require('./db');
const { createApp } = require('./app');

async function start(databaseUrl = config.databaseUrl) {
  await db.connect(databaseUrl);
  const server = createApp().listen(config.port, () => {
    console.log(`Kaksha API listening on http://localhost:${config.port}/api/v1`);
  });

  const shutdown = async () => {
    server.close();
    await db.disconnect();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return server;
}

if (require.main === module) {
  start().catch((err) => {
    console.error('Failed to start:', err.message);
    process.exit(1);
  });
}

module.exports = { start };
