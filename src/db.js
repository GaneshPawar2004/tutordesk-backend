const fs = require('fs');
const path = require('path');
const pg = require('pg');

// BIGINT (e.g. count(*)) as numbers; our counts are small.
pg.types.setTypeParser(20, Number);

const SCHEMA = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');

/** Current backend: { query(text, params) -> rows, tx(fn), exec(sql), close() }. */
let backend = null;

function pgBackend(url) {
  // pg warns that sslmode=require is treated as verify-full; say so explicitly.
  const connectionString = url.replace(/sslmode=(require|prefer|verify-ca)/, 'sslmode=verify-full');
  const pool = new pg.Pool({ connectionString, max: 8, idleTimeoutMillis: 30000 });
  // Idle connections can be dropped by Neon; don't let that crash the process.
  pool.on('error', (err) => console.error('Postgres pool error:', err.message));
  return {
    query: async (text, params) => (await pool.query(text, params)).rows,
    exec: (sql) => pool.query(sql),
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query('begin');
        const result = await fn({ query: async (text, params) => (await client.query(text, params)).rows });
        await client.query('commit');
        return result;
      } catch (err) {
        await client.query('rollback').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

/** In-process Postgres (PGlite) for tests and `npm run dev:memory`. */
async function memoryBackend() {
  const { PGlite } = await import('@electric-sql/pglite');
  const lite = new PGlite({ parsers: { 20: Number } });
  return {
    query: async (text, params) => (await lite.query(text, params)).rows,
    exec: (sql) => lite.exec(sql),
    tx: (fn) => lite.transaction((t) => fn({ query: async (text, params) => (await t.query(text, params)).rows })),
    close: () => lite.close(),
  };
}

/** Connects to [url] ('memory' = throwaway in-process database) and creates tables. */
async function connect(url) {
  if (!url) throw new Error('NEON_DB_URL (or DATABASE_URL) is not set');
  backend = url === 'memory' ? await memoryBackend() : pgBackend(url);
  await backend.exec(SCHEMA);
}

async function disconnect() {
  if (backend) await backend.close();
  backend = null;
}

const query = (text, params) => backend.query(text, params);
const one = async (text, params) => (await backend.query(text, params))[0] ?? null;

/** Runs fn(t) in a transaction; t has query/one. Use only t inside fn. */
const tx = (fn) =>
  backend.tx((t) => fn({ query: t.query, one: async (text, params) => (await t.query(text, params))[0] ?? null }));

/**
 * Builds `insert ... returning *` from { column: value } (columns are our own
 * constants, never user input).
 */
function insertSql(table, data) {
  const cols = Object.keys(data);
  const marks = cols.map((_, i) => `$${i + 1}`);
  return [`insert into ${table} (${cols.join(', ')}) values (${marks.join(', ')}) returning *`, Object.values(data)];
}

/** Builds `update table set ... where id = $1 returning *` from { column: value }. */
function updateSql(table, id, data) {
  const cols = Object.keys(data);
  const sets = cols.map((c, i) => `${c} = $${i + 2}`);
  return [`update ${table} set ${sets.join(', ')} where id = $1 returning *`, [id, ...Object.values(data)]];
}

/** Picks fields present in [body] and renames them with [columns] ({ apiName: column }). */
function toColumns(body, columns) {
  const out = {};
  for (const [field, col] of Object.entries(columns)) if (body[field] !== undefined) out[col] = body[field];
  return out;
}

module.exports = { connect, disconnect, query, one, tx, insertSql, updateSql, toColumns };
