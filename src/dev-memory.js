// Runs the API against a throwaway in-process Postgres (PGlite; no install needed).
// Data is lost when the server stops. Use `npm run dev` with NEON_DB_URL for real data.
const { start } = require('./server');

console.log('Using in-memory Postgres (data is NOT saved)');
start('memory').catch((err) => {
  console.error(err);
  process.exit(1);
});
