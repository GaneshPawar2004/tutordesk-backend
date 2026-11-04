const express = require('express');

const db = require('../db');
const validate = require('../middleware/validate');
const { findOwned, isId } = require('../utils/scope');
const { badRequest, notFound } = require('../utils/errors');
const s = require('../utils/schemas');

/**
 * Parent SMS queue (all staff). The app records each "send to all" list as a
 * batch before sending from the teacher's SIM, then reports every message.
 * Messages a phone could not send (e.g. its daily SMS limit was reached) stay
 * pending, so the admin or any staff member can send them from their phone.
 *
 * Claiming reserves messages for one phone for CLAIM_MINUTES so two people
 * never send the same SMS; unsent messages expire after PENDING_DAYS.
 */
const router = express.Router();

const CLAIM_MINUTES = 10;
const PENDING_DAYS = 2;

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

// ---- Create a batch ----------------------------------------------------------
const createSchema = s.z.object({
  kind: s.z.enum(['absent', 'fees', 'marks', 'birthday', 'receipt', 'other']).default('other'),
  title: s.z.string().trim().min(1).max(150),
  classId: s.objectId.nullable().optional(),
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

router.post('/sms/batches', validate(createSchema), async (req, res) => {
  const { kind, title, classId, messages } = req.body;
  if (classId) await findOwned('classes', classId, req.instituteId, 'Class');
  const studentIds = [...new Set(messages.map((m) => m.student).filter(Boolean))];
  if (studentIds.length) {
    const { n } = await db.one(
      'select count(*)::int as n from students where institute_id = $1 and id = any($2::uuid[])',
      [req.instituteId, studentIds],
    );
    if (n !== studentIds.length) throw badRequest('Some students were not found');
  }

  const result = await db.tx(async (t) => {
    const batch = await t.one(
      `insert into sms_batches (institute_id, class_id, kind, title, created_by)
       values ($1, $2, $3, $4, $5) returning *`,
      [req.instituteId, classId ?? null, kind, title, req.user.id],
    );
    const params = [batch.id];
    const rows = messages.map((m, i) => {
      params.push(m.student ?? null, i, m.name, m.phone, m.body);
      const p = params.length;
      return `($1, $${p - 4}, $${p - 3}, $${p - 2}, $${p - 1}, $${p})`;
    });
    const inserted = await t.query(
      `insert into sms_messages (batch_id, student_id, position, name, phone, body)
       values ${rows.join(', ')} returning *`,
      params,
    );
    return { batch, inserted: inserted.sort((a, b) => a.position - b.position) };
  });
  res.status(201).json({ batch: result.batch.id, messages: result.inserted.map(messageToPublic) });
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
  reason: s.z.string().trim().max(300).optional(),
  channel: s.z.enum(['sms', 'whatsapp', 'sms_app']).default('sms'),
});

/** Result of one message: sent (by this user, now) or failed (back to the unsent list). */
router.post('/sms/:id/report', validate(reportSchema), async (req, res) => {
  if (!isId(req.params.id)) throw notFound('Message');
  const { status, reason, channel } = req.body;
  const row = await db.one(
    `update sms_messages m set
       status = $3,
       reason = case when $3 = 'failed' then $4 else null end,
       channel = $5,
       sent_by = case when $3 = 'sent' then $2::uuid else m.sent_by end,
       sent_at = case when $3 = 'sent' then now() else m.sent_at end,
       claimed_by = null, claimed_until = null
     from sms_batches b
     where m.id = $1 and b.id = m.batch_id and b.institute_id = $6 and m.status <> 'sent'
     returning m.*`,
    [req.params.id, req.user.id, status, reason ?? null, channel, req.instituteId],
  );
  if (!row) throw notFound('Message');
  res.json({ message: messageToPublic(row) });
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
  const batch = await findOwned('sms_batches', req.params.id, req.instituteId, 'SMS list');
  const rows = await db.query(
    `select m.*, u.name as sent_by_name from sms_messages m
     left join users u on u.id = m.sent_by
     where m.batch_id = $1 order by m.position`,
    [batch.id],
  );
  res.json({ batch: { id: batch.id, title: batch.title, kind: batch.kind }, messages: rows.map(messageToPublic) });
});

/** Stops sending the rest of a batch (e.g. no longer needed). */
router.post('/sms/batches/:id/dismiss', async (req, res) => {
  const batch = await findOwned('sms_batches', req.params.id, req.instituteId, 'SMS list');
  await db.query(
    `update sms_messages set status = 'dismissed', claimed_by = null, claimed_until = null
     where batch_id = $1 and status in ('pending', 'failed')`,
    [batch.id],
  );
  res.status(204).end();
});

module.exports = router;
