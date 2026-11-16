const express = require('express');

const db = require('../db');
const validate = require('../middleware/validate');
const { canAccessFees } = require('../middleware/auth');
const { findOwned, isId } = require('../utils/scope');
const { ApiError, badRequest, forbidden, notFound } = require('../utils/errors');
const { FEE_KINDS, findOrCreateBatch, addMessages, batchMessages, messageToPublic } = require('../utils/smsQueue');
const s = require('../utils/schemas');

/**
 * Parent SMS queue (all staff). The app records each "send to all" list as a
 * batch before sending from the teacher's SIM, then reports every message.
 * Messages a phone could not send (e.g. its daily SMS limit was reached) stay
 * pending, so the admin or any staff member can send them from their phone.
 *
 * Claiming reserves messages for one phone for CLAIM_MINUTES so two people
 * never send the same SMS; unsent messages expire after PENDING_DAYS.
 * Absence SMS lists are built from saved attendance (routes/attendance.js).
 * Fee reminders and receipts (FEE_KINDS) are only for users with fee access.
 */
const router = express.Router();

const CLAIM_MINUTES = 10;
const PENDING_DAYS = 2;

/** SQL condition: batch b is visible to this user (fee lists need fee access). */
const visibleKinds = (user) => (canAccessFees(user) ? 'true' : `b.kind not in ('${FEE_KINDS.join("', '")}')`);

async function findBatch(req, id) {
  const batch = await findOwned('sms_batches', id, req.instituteId, 'SMS list');
  if (FEE_KINDS.includes(batch.kind) && !canAccessFees(req.user)) throw notFound('SMS list');
  return batch;
}

// ---- Create a batch ----------------------------------------------------------
const createSchema = s.z.object({
  kind: s.z.enum(['fees', 'marks', 'birthday', 'receipt', 'other']).default('other'),
  title: s.z.string().trim().min(1).max(150),
  classId: s.objectId.nullable().optional(),
  // Same key → same list; students already in it are not added again
  // (e.g. "fees:<class>:<day>", "marks:<test>:<day>", "birthday:<day>").
  key: s.z.string().trim().min(3).max(200).optional(),
  messages: s.z
    .array(
      s.z.object({
        student: s.objectId.nullable().optional(),
        name: s.z.string().trim().min(1).max(100),
        phone: s.z.string().trim().min(5).max(20),
        body: s.z.string().trim().min(1).max(1000),
      }),
    )
    .min(1)
    .max(1000),
});

router.post('/sms/batches', async (req, res, next) => {
  // Absence SMS must come from saved attendance: POST /classes/:id/attendance/sms.
  if (req.body?.kind === 'absent') {
    return next(new ApiError(400, 'UPDATE_APP', 'Please update the Kaksha app to send absence SMS.'));
  }
  next();
});

router.post('/sms/batches', validate(createSchema), async (req, res) => {
  const { kind, title, classId, key, messages } = req.body;
  if (FEE_KINDS.includes(kind) && !canAccessFees(req.user)) throw forbidden('You do not have access to fees');
  if (classId) await findOwned('classes', classId, req.instituteId, 'Class');
  const studentIds = [...new Set(messages.map((m) => m.student).filter(Boolean))];
  if (studentIds.length) {
    const { n } = await db.one(
      'select count(*)::int as n from students where institute_id = $1 and id = any($2::uuid[])',
      [req.instituteId, studentIds],
    );
    if (n !== studentIds.length) throw badRequest('Some students were not found');
  }

  const batch = await db.tx(async (t) => {
    const b = await findOrCreateBatch(t, {
      instituteId: req.instituteId,
      classId,
      kind,
      title,
      key,
      userId: req.user.id,
    });
    await addMessages(t, b.id, messages);
    return b;
  });
  const rows = await batchMessages(db, batch.id);
  res.status(201).json({ batch: batch.id, messages: rows.map(messageToPublic) });
});

// ---- Claim / report / release --------------------------------------------------
const claimSchema = s.z.object({
  batch: s.objectId.optional(),
  ids: s.z.array(s.objectId).max(1000).optional(),
  limit: s.z.number().int().min(1).max(1000).default(100),
});

/** Reserves up to `limit` unsent messages (of a batch, or the given ids) for this phone. */
router.post('/sms/claim', validate(claimSchema), async (req, res) => {
  const { batch, ids, limit } = req.body;
  const rows = await db.query(
    `update sms_messages m
       set claimed_by = $1, claimed_until = now() + interval '${CLAIM_MINUTES} minutes'
     where m.id in (
       select m2.id from sms_messages m2 join sms_batches b on b.id = m2.batch_id
       where b.institute_id = $2
         and ${visibleKinds(req.user)}
         and m2.status in ('pending', 'failed')
         and (m2.claimed_until is null or m2.claimed_until < now() or m2.claimed_by = $1)
         and b.created_at > now() - interval '${PENDING_DAYS} days'
         and ($3::uuid is null or m2.batch_id = $3)
         and ($4::uuid[] is null or m2.id = any($4::uuid[]))
       order by b.created_at, m2.position
       limit $5
       for update of m2 skip locked
     )
     returning m.*`,
    [req.user.id, req.instituteId, batch ?? null, ids ?? null, limit],
  );
  rows.sort((a, b) => a.position - b.position);
  res.json({ messages: rows.map(messageToPublic) });
});

const reportSchema = s.z.object({
  status: s.z.enum(['sent', 'failed']),
  // For "sent": e.g. "unconfirmed" when the phone never confirmed it.
  reason: s.z.string().trim().max(300).optional(),
  channel: s.z.enum(['sms', 'whatsapp', 'sms_app']).default('sms'),
});

/**
 * Result of one message claimed by this phone: sent (by this user, now) or
 * failed (back to the unsent list). `stop: true` tells the phone to stop
 * sending this list (it was stopped from Pending SMS).
 */
router.post('/sms/:id/report', validate(reportSchema), async (req, res) => {
  if (!isId(req.params.id)) throw notFound('Message');
  const { status, reason, channel } = req.body;
  const result = await db.tx(async (t) => {
    const m = await t.one(
      `select m.*, b.kind from sms_messages m join sms_batches b on b.id = m.batch_id
       where m.id = $1 and b.institute_id = $2 for update of m`,
      [req.params.id, req.instituteId],
    );
    if (!m || (FEE_KINDS.includes(m.kind) && !canAccessFees(req.user))) throw notFound('Message');
    if (m.status === 'sent') return { row: m, alreadySent: true };
    const claimedElsewhere =
      m.claimed_by && m.claimed_by !== req.user.id && m.claimed_until && m.claimed_until > new Date();
    if (claimedElsewhere) {
      throw new ApiError(409, 'SENDING_ELSEWHERE', 'This message is being sent from another phone');
    }
    // A stopped (dismissed) message stays stopped unless this phone really sent it.
    const stop = m.status === 'dismissed';
    if (stop && status !== 'sent') return { row: m, stop };
    const row = await t.one(
      `update sms_messages set
         status = $2, reason = $3, channel = $4,
         sent_by = case when $2 = 'sent' then $5::uuid else sent_by end,
         sent_at = case when $2 = 'sent' then now() else sent_at end,
         claimed_by = null, claimed_until = null
       where id = $1 returning *`,
      [m.id, status, reason ?? null, channel, req.user.id],
    );
    return { row, stop };
  });
  res.json({
    message: messageToPublic(result.row),
    ...(result.alreadySent && { alreadySent: true }),
    ...(result.stop && { stop: true }),
  });
});

/** Gives back messages this phone claimed but did not send (e.g. its SMS limit was reached). */
router.post('/sms/release', validate(s.z.object({ ids: s.z.array(s.objectId).max(1000) })), async (req, res) => {
  await db.query(
    `update sms_messages set claimed_by = null, claimed_until = null
     where id = any($1::uuid[]) and claimed_by = $2 and status in ('pending', 'failed')`,
    [req.body.ids, req.user.id],
  );
  res.status(204).end();
});

// ---- Lists --------------------------------------------------------------------
/** Batches of the last `days` days with counts; `remaining` = unsent and still sendable. */
router.get(
  '/sms/batches',
  validate(s.z.object({ days: s.z.coerce.number().int().min(1).max(90).default(7) }), 'query'),
  async (req, res) => {
    const [batches, senders] = await Promise.all([
      db.query(
        `select b.*, u.name as created_by_name, c.name as class_name,
           b.created_at > now() - interval '${PENDING_DAYS} days' as sendable,
           count(*)::int as total,
           count(*) filter (where m.status = 'sent')::int as sent,
           count(*) filter (where m.status = 'failed')::int as failed,
           count(*) filter (where m.status = 'pending')::int as pending,
           count(*) filter (where m.status = 'dismissed')::int as dismissed
         from sms_batches b
         join sms_messages m on m.batch_id = b.id
         left join users u on u.id = b.created_by
         left join classes c on c.id = b.class_id
         where b.institute_id = $1 and b.created_at > now() - make_interval(days => $2)
           and ${visibleKinds(req.user)}
         group by b.id, u.name, c.name
         order by b.created_at desc`,
        [req.instituteId, req.validQuery.days],
      ),
      db.query(
        `select m.batch_id, coalesce(u.name, 'Deleted user') as name, count(*)::int as n
         from sms_messages m join sms_batches b on b.id = m.batch_id
         left join users u on u.id = m.sent_by
         where b.institute_id = $1 and b.created_at > now() - make_interval(days => $2)
           and m.status = 'sent'
         group by m.batch_id, u.name`,
        [req.instituteId, req.validQuery.days],
      ),
    ]);
    const byBatch = new Map();
    for (const r of senders) {
      if (!byBatch.has(r.batch_id)) byBatch.set(r.batch_id, []);
      byBatch.get(r.batch_id).push({ name: r.name, count: r.n });
    }
    res.json({
      batches: batches.map((b) => ({
        id: b.id,
        title: b.title,
        kind: b.kind,
        class: b.class_id,
        className: b.class_name,
        createdBy: b.created_by_name ?? '',
        createdAt: b.created_at,
        total: b.total,
        sent: b.sent,
        failed: b.failed,
        pending: b.pending,
        dismissed: b.dismissed,
        remaining: b.sendable ? b.pending + b.failed : 0,
        expired: !b.sendable && b.pending + b.failed > 0,
        senders: byBatch.get(b.id) || [],
      })),
    });
  },
);

/** Every message of a batch: who is still unsent, who sent what. */
router.get('/sms/batches/:id', async (req, res) => {
  const batch = await findBatch(req, req.params.id);
  const rows = await batchMessages(db, batch.id);
  res.json({ batch: { id: batch.id, title: batch.title, kind: batch.kind }, messages: rows.map(messageToPublic) });
});

/** Stops sending the rest of a batch (e.g. no longer needed). */
router.post('/sms/batches/:id/dismiss', async (req, res) => {
  const batch = await findBatch(req, req.params.id);
  await db.query(
    `update sms_messages set status = 'dismissed', claimed_by = null, claimed_until = null
     where batch_id = $1 and status in ('pending', 'failed')`,
    [batch.id],
  );
  res.status(204).end();
});

module.exports = router;
