const express = require('express');

const db = require('../db');
const { round2 } = require('../models/Student');
const validate = require('../middleware/validate');
const { canAccessFees } = require('../middleware/auth');
const { todayIST } = require('../utils/scope');
const { instituteSummary } = require('./auth');
const s = require('../utils/schemas');

/** Dashboard tiles and the Reports screen. */
const router = express.Router();

router.get(
  '/dashboard',
  validate(s.z.object({ date: s.isoDate.optional() }), 'query'),
  async (req, res) => {
    const date = req.validQuery.date || todayIST();
    const inst = req.instituteId;
    const [counts, institute] = await Promise.all([
      db.one(
        `select
           (select count(*)::int from classes where institute_id = $1) as classes,
           (select count(*)::int from students where institute_id = $1) as students,
           (select coalesce(sum(greatest(0, total_fees - fees_paid)), 0)
              from students where institute_id = $1) as fees_due,
           (select count(*)::int from attendance_records r join attendance a on a.id = r.attendance_id
              where a.institute_id = $1 and a.date = $2 and r.status = 'present') as present_today`,
        [inst, date],
      ),
      instituteSummary(inst),
    ]);
    res.json({
      trialDaysRemaining: institute.trialDaysRemaining,
      classes: counts.classes,
      students: counts.students,
      presentToday: counts.present_today,
      feesDue: canAccessFees(req.user) ? round2(counts.fees_due) : null,
    });
  },
);

router.get('/reports', async (req, res) => {
  const inst = req.instituteId;
  const [classes, attendance] = await Promise.all([
    db.query(
      `select c.id, c.name,
         count(st.id)::int as student_count,
         coalesce(sum(st.total_fees), 0) as total,
         coalesce(sum(st.fees_paid), 0) as collected
       from classes c left join students st on st.class_id = c.id
       where c.institute_id = $1
       group by c.id order by c.created_at`,
      [inst],
    ),
    db.query(
      `select a.class_id, r.status, count(*)::int as n
       from attendance a join attendance_records r on r.attendance_id = a.id
       where a.institute_id = $1 group by a.class_id, r.status`,
      [inst],
    ),
  ]);

  const att = new Map();
  for (const a of attendance) {
    if (!att.has(a.class_id)) att.set(a.class_id, { present: 0, absent: 0, leave: 0, others: 0 });
    att.get(a.class_id)[a.status] = a.n;
  }

  res.json({
    attendance: classes.map((c) => {
      const t = att.get(c.id) || { present: 0, absent: 0, leave: 0, others: 0 };
      const total = t.present + t.absent + t.leave + t.others;
      const pct = (n) => (total ? Math.round((n * 100) / total) : 0);
      return {
        class: c.id,
        name: c.name,
        studentCount: c.student_count,
        records: total,
        presentPercent: pct(t.present),
        absentPercent: pct(t.absent),
        leavePercent: pct(t.leave),
      };
    }),
    fees: canAccessFees(req.user)
      ? classes.map((c) => ({
          class: c.id,
          name: c.name,
          total: round2(c.total),
          collected: round2(c.collected),
          due: round2(Math.max(0, c.total - c.collected)),
        }))
      : null,
  });
});

module.exports = router;
