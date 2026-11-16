const express = require('express');

const db = require('../db');
const validate = require('../middleware/validate');
const { findOwned, todayIST } = require('../utils/scope');
const { ApiError, badRequest } = require('../utils/errors');
const { findOrCreateBatch, addMessages, batchMessages, messageToPublic, dmy } = require('../utils/smsQueue');
const s = require('../utils/schemas');

const router = express.Router({ mergeParams: true });

const countOf = (records) => {
  const counts = { present: 0, absent: 0, leave: 0, others: 0, total: records.length };
  for (const r of records) counts[r.status] += 1;
  return counts;
};

const absentKey = (classId, date) => `absent:${classId}:${date}`;

/**
 * Attendance of a class for a date: every active student with their saved
 * status (unsaved students default to present, saved: false), who saved it and
 * when, its version (send it back when saving), each student's absence-SMS
 * status, and the history of changes made after the first save.
 */
async function loadDay(c, date) {
  const [doc, students, sms] = await Promise.all([
    db.one(
      `select a.*, u.name as marked_by_name from attendance a
       left join users u on u.id = a.marked_by
       where a.class_id = $1 and a.date = $2`,
      [c.id, date],
    ),
    db.query(
      `select st.id, st.name, r.status from students st
       left join attendance a on a.class_id = st.class_id and a.date = $2
       left join attendance_records r on r.attendance_id = a.id and r.student_id = st.id
       where st.class_id = $1 and not st.disabled
       order by st.created_at`,
      [c.id, date],
    ),
    db.query(
      `select m.student_id, m.status from sms_messages m
       join sms_batches b on b.id = m.batch_id
       where b.institute_id = $1 and b.dedupe_key = $2 and m.student_id is not null`,
      [c.institute_id, absentKey(c.id, date)],
    ),
  ]);
  const smsOf = new Map(sms.map((m) => [m.student_id, m.status]));
  const records = students.map((st) => ({
    student: st.id,
    status: st.status || 'present',
    saved: Boolean(st.status),
    // sent | pending | failed | dismissed | null (no absence SMS for this day)
    sms: smsOf.get(st.id) ?? null,
  }));
  const changes = doc
    ? await db.query(
        `select ch.*, st.name as student_name, u.name as changed_by_name
         from attendance_changes ch
         join students st on st.id = ch.student_id
         left join users u on u.id = ch.changed_by
         where ch.attendance_id = $1 order by ch.changed_at desc`,
        [doc.id],
      )
    : [];
  return {
    date,
    saved: Boolean(doc),
    version: doc?.version ?? null,
    savedBy: doc?.marked_by_name ?? null,
    savedAt: doc?.updated_at ?? null,
    records,
    counts: countOf(records),
    changes: changes.map((ch) => ({
      student: ch.student_id,
      name: ch.student_name,
      from: ch.old_status,
      to: ch.new_status,
      by: ch.changed_by_name ?? '',
      at: ch.changed_at,
    })),
  };
}

router.get('/', validate(s.z.object({ date: s.isoDate.optional() }), 'query'), async (req, res) => {
  const c = await findOwned('classes', req.params.classId, req.instituteId, 'Class');
  res.json(await loadDay(c, req.validQuery.date || todayIST()));
});

const saveSchema = s.z.object({
  date: s.isoDate,
  records: s.z
    .array(s.z.object({ student: s.objectId, status: s.z.enum(['present', 'absent', 'leave', 'others']) }))
    .max(1000),
  // Version the screen was loaded with (null = not saved yet). Older apps omit it.
  version: s.z.number().int().nullable().optional(),
});

router.put('/', validate(saveSchema), async (req, res) => {
  const c = await findOwned('classes', req.params.classId, req.instituteId, 'Class');
  const { date, records, version } = req.body;
  if (date > todayIST()) throw badRequest('Attendance cannot be saved for a future date');

  const ids = [...new Set(records.map((r) => r.student))];
  if (ids.length !== records.length) throw badRequest('A student appears more than once');
  const { n } = await db.one(
    'select count(*)::int as n from students where class_id = $1 and id = any($2::uuid[])',
    [c.id, ids],
  );
  if (n !== ids.length) throw badRequest('Some students do not belong to this class');

  await db.tx(async (t) => {
    const existing = await t.one(
      `select a.*, u.name as marked_by_name from attendance a
       left join users u on u.id = a.marked_by
       where a.class_id = $1 and a.date = $2 for update of a`,
      [c.id, date],
    );
    if (version !== undefined && (existing?.version ?? null) !== version) {
      throw new ApiError(
        409,
        'ATTENDANCE_CHANGED',
        existing
          ? `${existing.marked_by_name || 'Someone'} saved this attendance just now. Please check it again before saving.`
          : 'This attendance was saved from another phone. Please check it again before saving.',
      );
    }
    const doc = existing
      ? await t.one(
          'update attendance set marked_by = $2, version = version + 1 where id = $1 returning id',
          [existing.id, req.user.id],
        )
      : await t.one(
          `insert into attendance (institute_id, class_id, date, marked_by) values ($1, $2, $3, $4)
           returning id`,
          [req.instituteId, c.id, date, req.user.id],
        );

    // Record every saved status that changes (only for re-saves).
    if (existing && records.length) {
      const before = await t.query('select student_id, status from attendance_records where attendance_id = $1', [
        doc.id,
      ]);
      const old = new Map(before.map((r) => [r.student_id, r.status]));
      const changed = records.filter((r) => old.has(r.student) && old.get(r.student) !== r.status);
      if (changed.length) {
        const params = [doc.id, req.user.id];
        const rows = changed.map((r) => {
          params.push(r.student, old.get(r.student), r.status);
          const p = params.length;
          return `($1, $${p - 2}, $${p - 1}, $${p}, $2)`;
        });
        await t.query(
          `insert into attendance_changes (attendance_id, student_id, old_status, new_status, changed_by)
           values ${rows.join(', ')}`,
          params,
        );
      }
    }

    // Upsert: records of students not in this save (e.g. disabled since) are kept.
    if (records.length) {
      const params = [doc.id];
      const rows = records.map((r, i) => {
        params.push(r.student, i, r.status);
        const p = params.length;
        return `($1, $${p - 2}, $${p - 1}, $${p})`;
      });
      await t.query(
        `insert into attendance_records (attendance_id, student_id, position, status) values ${rows.join(', ')}
         on conflict (attendance_id, student_id) do update set status = excluded.status, position = excluded.position`,
        params,
      );
    }

    // Students no longer absent must not get the absence SMS that is still waiting.
    const notAbsent = records.filter((r) => r.status !== 'absent').map((r) => r.student);
    if (notAbsent.length) {
      await t.query(
        `update sms_messages m set status = 'dismissed', claimed_by = null, claimed_until = null
         from sms_batches b
         where b.id = m.batch_id and b.institute_id = $1 and b.dedupe_key = $2
           and m.status in ('pending', 'failed') and m.student_id = any($3::uuid[])`,
        [req.instituteId, absentKey(c.id, date), notAbsent],
      );
    }
  });
  res.json(await loadDay(c, date));
});

/**
 * The absence-SMS list of a class and day, built from the SAVED attendance:
 * every saved-absent student gets one message (added once — asking again adds
 * only students newly marked absent). Returns the whole list with each
 * message's status, plus absent students without a mobile number.
 */
router.post('/sms', validate(s.z.object({ date: s.isoDate })), async (req, res) => {
  const c = await findOwned('classes', req.params.classId, req.instituteId, 'Class');
  const { date } = req.body;
  const absent = await db.query(
    `select st.id, st.name, coalesce(nullif(st.parent_mobile, ''), st.contact) as phone
     from attendance a
     join attendance_records r on r.attendance_id = a.id and r.status = 'absent'
     join students st on st.id = r.student_id and not st.disabled
     where a.class_id = $1 and a.date = $2
     order by r.position`,
    [c.id, date],
  );
  const withPhone = absent.filter((st) => st.phone);
  const batch = await db.tx(async (t) => {
    const b = await findOrCreateBatch(t, {
      instituteId: req.instituteId,
      classId: c.id,
      kind: 'absent',
      title: `${c.name} · Absent on ${dmy(date)}`,
      key: absentKey(c.id, date),
      userId: req.user.id,
    });
    await addMessages(
      t,
      b.id,
      withPhone.map((st) => ({
        student: st.id,
        name: st.name,
        phone: st.phone,
        body: `Dear Parent, ${st.name} (${c.name}) was absent on ${dmy(date)}.`,
      })),
    );
    return b;
  });
  const absentIds = new Set(absent.map((st) => st.id));
  const messages = (await batchMessages(db, batch.id)).filter(
    // Keep sent ones for the record; hide waiting ones whose student is no longer absent.
    (m) => m.status === 'sent' || absentIds.has(m.student_id),
  );
  res.json({
    batch: batch.id,
    title: batch.title,
    messages: messages.map(messageToPublic),
    noNumber: absent.filter((st) => !st.phone).map((st) => st.name),
  });
});

module.exports = router;
