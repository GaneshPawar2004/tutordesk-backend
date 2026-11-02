const db = require('../db');
const { notFound } = require('./errors');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isId = (id) => typeof id === 'string' && UUID.test(id);

/**
 * Loads a row of [table] by id only if it belongs to the caller's institute.
 * Other institutes' data is reported as "not found". [table] is our own constant.
 */
async function findOwned(table, id, instituteId, what) {
  if (!isId(id)) throw notFound(what);
  const row = await db.one(`select * from ${table} where id = $1 and institute_id = $2`, [id, instituteId]);
  if (!row) throw notFound(what);
  return row;
}

/** Today's date as YYYY-MM-DD in India time. */
const todayIST = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());

module.exports = { findOwned, todayIST, isId, UUID };
