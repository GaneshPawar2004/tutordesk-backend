/**
 * Shared helpers for the parent SMS queue (see routes/sms.js).
 *
 * A batch with a dedupe key ("absent:<class>:<date>", "fees:<class>:<day>", …)
 * exists once per institute: asking for it again returns the same batch and
 * adds only students not in it yet, so nobody is messaged twice.
 */

/** Kinds whose messages contain fee amounts (need fee access). */
const FEE_KINDS = ['fees', 'receipt'];

/** Finds the batch with [key] or creates it. Use inside a transaction. */
async function findOrCreateBatch(t, { instituteId, classId, kind, title, key, userId }) {
  if (key) {
    const existing = await t.one('select * from sms_batches where institute_id = $1 and dedupe_key = $2', [
      instituteId,
      key,
    ]);
    if (existing) return existing;
  }
  return t.one(
    `insert into sms_batches (institute_id, class_id, kind, title, created_by, dedupe_key)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (institute_id, dedupe_key) where dedupe_key is not null
       do update set title = excluded.title
     returning *`,
    [instituteId, classId ?? null, kind, title, userId, key ?? null],
  );
}

/**
 * Adds [messages] ({student?, name, phone, body}) to the batch, skipping students
 * already in it. Use inside a transaction.
 */
async function addMessages(t, batchId, messages) {
  if (!messages.length) return;
  const { n } = await t.one('select coalesce(max(position) + 1, 0)::int as n from sms_messages where batch_id = $1', [
    batchId,
  ]);
  const params = [batchId];
  const rows = messages.map((m, i) => {
    params.push(m.student ?? null, n + i, m.name, m.phone, m.body);
    const p = params.length;
    return `($1, $${p - 4}, $${p - 3}, $${p - 2}, $${p - 1}, $${p})`;
  });
  await t.query(
    `insert into sms_messages (batch_id, student_id, position, name, phone, body)
     values ${rows.join(', ')}
     on conflict (batch_id, student_id) where student_id is not null do nothing`,
    params,
  );
}

/** All messages of a batch with the sender's name, in list order. */
const batchMessages = (q, batchId) =>
  q.query(
    `select m.*, u.name as sent_by_name from sms_messages m
     left join users u on u.id = m.sent_by
     where m.batch_id = $1 order by m.position`,
    [batchId],
  );

const messageToPublic = (m) => ({
  id: m.id,
  batch: m.batch_id,
  student: m.student_id,
  name: m.name,
  phone: m.phone,
  body: m.body,
  status: m.status,
  reason: m.reason,
  channel: m.channel,
  sentBy: m.sent_by_name ?? null,
  sentAt: m.sent_at,
});

/** "2026-11-16" → "16-11-2026" (the app's date style). */
const dmy = (iso) => iso.split('-').reverse().join('-');

module.exports = { FEE_KINDS, findOrCreateBatch, addMessages, batchMessages, messageToPublic, dmy };
