const express = require('express');

const db = require('../db');
const Student = require('../models/Student');
const validate = require('../middleware/validate');
const { requireFeeAccess } = require('../middleware/auth');
const { findOwned } = require('../utils/scope');
const { badRequest } = require('../utils/errors');
const s = require('../utils/schemas');

const router = express.Router();
// Only fee paths need fee access (this router is mounted at the API root).
router.use(['/classes/:classId/fees', '/fees', '/students/:id/fees'], requireFeeAccess);

const { round2, feesDue } = Student;

function summarize(students) {
  const total = round2(students.reduce((a, st) => a + st.total_fees, 0));
  const collected = round2(students.reduce((a, st) => a + st.fees_paid, 0));
  return { total, collected, due: round2(Math.max(0, total - collected)) };
}

/** Fees screen of a class: summary + every student's dues. */
router.get('/classes/:classId/fees', async (req, res) => {
  const c = await findOwned('classes', req.params.classId, req.instituteId, 'Class');
  const students = await db.query('select * from students where class_id = $1 order by created_at', [c.id]);
  res.json({ summary: summarize(students), students: students.map((st) => Student.toPublic(st)) });
});

/** Dashboard "Fee Dues": pending fees across all classes, earliest due first. */
router.get('/fees/dues', async (req, res) => {
  const students = await db.query(
    `select st.*, c.name as class_name from students st
     join classes c on c.id = st.class_id
     where st.institute_id = $1 order by st.created_at`,
    [req.instituteId],
  );
  const due = students
    .filter((st) => feesDue(st) > 0)
    .sort((a, b) => {
      if (!a.fees_due_date && !b.fees_due_date) return feesDue(b) - feesDue(a);
      if (!a.fees_due_date) return 1;
      if (!b.fees_due_date) return -1;
      return a.fees_due_date - b.fees_due_date;
    })
    .map((st) => ({ ...Student.toPublic(st), className: st.class_name }));
  res.json({ summary: summarize(students), students: due });
});

const paymentSchema = s.z.object({
  amount: s.z.number().positive('Enter a valid amount').max(1e9),
  note: s.z.string().trim().max(200).optional(),
  paidAt: s.nullableDate.optional(),
});

/** Records a payment. Rejected if it exceeds the pending amount. */
router.post('/students/:id/fees/payments', validate(paymentSchema), async (req, res) => {
  const st = await findOwned('students', req.params.id, req.instituteId, 'Student');
  const amount = round2(req.body.amount);
  if (st.total_fees <= 0) throw badRequest('Set total fees for this student first');

  const { payment, updated } = await db.tx(async (t) => {
    // Atomic check-and-increment so two collectors can't overpay together.
    const row = await t.one(
      `update students set fees_paid = fees_paid + $2
       where id = $1 and fees_paid + $2 <= total_fees + 0.001 returning *`,
      [st.id, amount],
    );
    if (!row) throw badRequest(`Amount exceeds due (₹${feesDue(st)})`);
    const p = await t.one(
      `insert into fee_payments (institute_id, student_id, amount, note, paid_at, collected_by)
       values ($1, $2, $3, $4, $5, $6) returning *`,
      [req.instituteId, st.id, amount, req.body.note || '', req.body.paidAt || new Date(), req.user.id],
    );
    return { payment: p, updated: row };
  });
  res.status(201).json({
    payment: {
      id: payment.id,
      student: payment.student_id,
      amount: payment.amount,
      note: payment.note,
      paidAt: payment.paid_at,
      collectedBy: payment.collected_by,
      createdAt: payment.created_at,
    },
    student: Student.toPublic(updated),
  });
});

router.get('/students/:id/fees/payments', async (req, res) => {
  const st = await findOwned('students', req.params.id, req.instituteId, 'Student');
  const payments = await db.query(
    `select p.*, u.name as collector_name from fee_payments p
     left join users u on u.id = p.collected_by
     where p.student_id = $1 order by p.paid_at desc`,
    [st.id],
  );
  res.json({
    payments: payments.map((p) => ({
      id: p.id,
      amount: p.amount,
      note: p.note,
      paidAt: p.paid_at,
      collectedBy: p.collector_name || '',
    })),
  });
});

module.exports = router;
