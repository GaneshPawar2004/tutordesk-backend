const express = require('express');

const db = require('../db');
const { round2, feesDue, totalDue } = require('../models/Student');
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
    const [counts, fees, institute] = await Promise.all([
      db.one(
        `select
           (select count(*)::int from classes where institute_id = $1) as classes,
           (select count(*)::int from students where institute_id = $1) as students,
           (select count(*)::int from attendance_records r join attendance a on a.id = r.attendance_id
              where a.institute_id = $1 and a.date = $2 and r.status = 'present') as present_today`,
        [inst, date],
      ),
      // Dues are worked out per student (monthly fees grow every month).
      db.query(
        'select total_fees, monthly_fee, fee_start, fees_paid from students where institute_id = $1',
        [inst],
      ),
      instituteSummary(inst),
    ]);
    res.json({
      trialDaysRemaining: institute.trialDaysRemaining,
      classes: counts.classes,
      students: counts.students,
      presentToday: counts.present_today,
      feesDue: canAccessFees(req.user) ? round2(fees.reduce((a, st) => a + feesDue(st), 0)) : null,
    });
  },
);

router.get('/reports', async (req, res) => {
  const inst = req.instituteId;
  const [classes, students, attendance] = await Promise.all([
    db.query(
      `select c.id, c.name, count(st.id)::int as student_count
       from classes c left join students st on st.class_id = c.id
       where c.institute_id = $1
       group by c.id order by c.created_at`,
      [inst],
    ),
    db.query(
      'select class_id, total_fees, monthly_fee, fee_start, fees_paid from students where institute_id = $1',
      [inst],
    ),
    db.query(
      `select a.class_id, r.status, count(*)::int as n
       from attendance a join attendance_records r on r.attendance_id = a.id
       where a.institute_id = $1 group by a.class_id, r.status`,
      [inst],
    ),
  ]);

  const feeBy = new Map(classes.map((c) => [c.id, { total: 0, collected: 0 }]));
  for (const st of students) {
    const f = feeBy.get(st.class_id);
    if (!f) continue;
    f.total += totalDue(st);
    f.collected += st.fees_paid;
  }

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
        counts: t,
        presentPercent: pct(t.present),
        absentPercent: pct(t.absent),
        leavePercent: pct(t.leave),
      };
    }),
    fees: canAccessFees(req.user)
      ? classes.map((c) => {
          const f = feeBy.get(c.id);
          return {
            class: c.id,
            name: c.name,
            total: round2(f.total),
            collected: round2(f.collected),
            due: round2(Math.max(0, f.total - f.collected)),
          };
        })
      : null,
  });
});

module.exports = router;
