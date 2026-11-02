const express = require('express');

const db = require('../db');
const validate = require('../middleware/validate');
const { findOwned, todayIST } = require('../utils/scope');
const { badRequest } = require('../utils/errors');
const s = require('../utils/schemas');

const router = express.Router({ mergeParams: true });

const countOf = (records) => {
  const counts = { present: 0, absent: 0, leave: 0, others: 0, total: records.length };
  for (const r of records) counts[r.status] += 1;
  return counts;
};

/**
 * Attendance for a date. If nothing was saved yet, every active student is
 * returned as present (the app's default) with saved: false.
 */
router.get('/', validate(s.z.object({ date: s.isoDate.optional() }), 'query'), async (req, res) => {
  const c = await findOwned('classes', req.params.classId, req.instituteId, 'Class');
  const date = req.validQuery.date || todayIST();
  const [doc, students] = await Promise.all([
    db.one('select id from attendance where class_id = $1 and date = $2', [c.id, date]),
    db.query(
      `select st.id, r.status from students st
       left join attendance a on a.class_id = st.class_id and a.date = $2
       left join attendance_records r on r.attendance_id = a.id and r.student_id = st.id
       where st.class_id = $1 and not st.disabled
       order by st.created_at`,
      [c.id, date],
    ),
  ]);
  const records = students.map((st) => ({ student: st.id, status: st.status || 'present' }));
  res.json({ date, saved: Boolean(doc), records, counts: countOf(records) });
});

const saveSchema = s.z.object({
  date: s.isoDate,
  records: s.z
    .array(s.z.object({ student: s.objectId, status: s.z.enum(['present', 'absent', 'leave', 'others']) }))
    .max(1000),
});

router.put('/', validate(saveSchema), async (req, res) => {
  const c = await findOwned('classes', req.params.classId, req.instituteId, 'Class');
  const { date, records } = req.body;
  if (date > todayIST()) throw badRequest('Attendance cannot be saved for a future date');

  const ids = [...new Set(records.map((r) => r.student))];
  if (ids.length !== records.length) throw badRequest('A student appears more than once');
  const { n } = await db.one(
    'select count(*)::int as n from students where class_id = $1 and id = any($2::uuid[])',
    [c.id, ids],
  );
  if (n !== ids.length) throw badRequest('Some students do not belong to this class');

  await db.tx(async (t) => {
    const doc = await t.one(
      `insert into attendance (institute_id, class_id, date, marked_by) values ($1, $2, $3, $4)
       on conflict (class_id, date) do update set marked_by = excluded.marked_by, updated_at = now()
       returning id`,
      [req.instituteId, c.id, date, req.user.id],
    );
    await t.query('delete from attendance_records where attendance_id = $1', [doc.id]);
    if (!records.length) return;
    const params = [doc.id];
    const rows = records.map((r, i) => {
      params.push(r.student, i, r.status);
      const p = params.length;
      return `($1, $${p - 2}, $${p - 1}, $${p})`;
    });
    await t.query(
      `insert into attendance_records (attendance_id, student_id, position, status) values ${rows.join(', ')}`,
      params,
    );
  });
  const saved = records.map((r) => ({ student: r.student, status: r.status }));
  res.json({ date, saved: true, records: saved, counts: countOf(saved) });
});

module.exports = router;
