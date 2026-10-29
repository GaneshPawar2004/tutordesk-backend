import pg from 'pg';

// Return DATE columns as 'YYYY-MM-DD' strings (no timezone shifting).
pg.types.setTypeParser(1082, (v) => v);
// BIGINT counts as numbers (safe for our sizes).
pg.types.setTypeParser(20, (v) => Number(v));

/**
 * Small wrapper around a pg Pool. `schema` (optional) isolates tests in their
 * own Postgres schema so they never touch real data.
 */
export function createDb({ url, schema } = {}) {
  if (!url) throw new Error('Database URL missing: set NEON_DB_URL or DATABASE_URL in backend/.env');
  // pg warns about libpq alias semantics for sslmode=require; verify-full is what it does anyway.
  let connectionString = url.replace(/sslmode=(require|prefer|verify-ca)/, 'sslmode=verify-full');
  // Neon's pooled endpoint (PgBouncer, transaction mode) shares server
  // sessions between clients, so session state such as search_path can leak
  // in from elsewhere. We keep our own small pool, so use the direct endpoint.
  connectionString = connectionString.replace(/(@[^/.]+)-pooler\./, '$1.');
  const pool = new pg.Pool({ connectionString, max: 8, idleTimeoutMillis: 30000 });
  // With a schema (tests), set search_path inside each transaction: Neon's
  // pooler (PgBouncer, transaction mode) only keeps a connection pinned for
  // the duration of a transaction, so session-level SET would not stick.
  const pin = (client) => client.query(`set local search_path to "${schema}"`);
  async function run(text, params) {
    if (!schema) return pool.query(text, params);
    const client = await pool.connect();
    try {
      await client.query('begin');
      await pin(client);
      const result = await client.query(text, params);
      await client.query('commit');
      return result;
    } catch (e) {
      await client.query('rollback').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  const query = async (text, params) => (await run(text, params)).rows;
  const one = async (text, params) => (await run(text, params)).rows[0] ?? null;

  /** Runs fn(client) in a transaction; client has the same query/one helpers. */
  async function tx(fn) {
    const client = await pool.connect();
    const wrapped = {
      query: async (text, params) => (await client.query(text, params)).rows,
      one: async (text, params) => (await client.query(text, params)).rows[0] ?? null,
    };
    try {
      await client.query('begin');
      if (schema) await pin(client);
      const result = await fn(wrapped);
      await client.query('commit');
      return result;
    } catch (e) {
      await client.query('rollback').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  return { pool, query, one, tx, close: () => pool.end() };
}
