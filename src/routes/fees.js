import { Router } from 'express';

import { COLS, currentYear, feeContext, logActivity, newId, notify, today } from '../data/repo.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { date, int, oneOf, str } from '../lib/util.js';
import { adminOnly } from '../middleware/auth.js';
import { FREQUENCIES, PAYMENT_METHODS, addSummaries, installmentProgress, paymentsFor, summaryFor } from '../services/fees.js';

/** Every route here is admin-only; staff receive 403 from the API itself. */
export function feeRoutes(db) {
  const r = Router();
  r.use('/fees', adminOnly);

  async function rows(t, yearId, classId) {
    const list = await db.query(
      `select e.id "enrollmentId", s.id "studentId", s.first_name || ' ' || s.last_name "studentName",
              e.class_id "classId", c.name "className", (s.is_active and e.status <> 'withdrawn') active
         from enrollments e join students s on s.tenant_id = e.tenant_id and s.id = e.student_id join classes c on c.id = e.class_id
        where e.tenant_id = $1 and e.academic_year_id = $2 and ($3::text is null or e.class_id = $3)
        order by s.first_name, s.last_name`,
      [t, yearId, classId || null],
    );
    const ctx = await feeContext(db, t, list.map((x) => x.enrollmentId));
    const d = today();
    return { ctx, list: list.map((x) => ({ ...x, ...summaryFor(ctx, x.enrollmentId, d) })).filter((x) => x.hasPlan || x.active) };
  }

  r.get('/fees/summary', async (req, res) => {
    const t = req.tenantId;
    const yearId = req.query.yearId ?? (await currentYear(db, t)).id;
    const { ctx, list } = await rows(t, yearId, req.query.classId);
    const now = new Date();
    const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
    const names = Object.fromEntries(list.map((x) => [x.enrollmentId, x]));
    res.json({
      totals: addSummaries(list),
      collectedThisMonth: ctx.payments.filter((p) => p.date >= monthStart).reduce((s, p) => s + p.amount, 0),
      statusCounts: {
        paid: list.filter((x) => x.hasPlan && x.status === 'paid').length,
        partial: list.filter((x) => x.hasPlan && x.status === 'partial').length,
        unpaid: list.filter((x) => x.hasPlan && x.status === 'unpaid').length,
        noPlan: list.filter((x) => !x.hasPlan).length,
        overdue: list.filter((x) => x.overdue > 0).length,
      },
      recentPayments: ctx.payments
        .filter((p) => names[p.enrollmentId])
        .slice(0, 10)
        .map((p) => ({ ...p, studentName: names[p.enrollmentId].studentName, studentId: names[p.enrollmentId].studentId })),
    });
  });

  r.get('/fees/students', async (req, res) => {
    const t = req.tenantId;
    let { list } = await rows(t, req.query.yearId ?? (await currentYear(db, t)).id, req.query.classId);
    const { status, q } = req.query;
    if (status === 'overdue') list = list.filter((x) => x.overdue > 0);
    else if (status === 'none') list = list.filter((x) => !x.hasPlan);
    else if (status) list = list.filter((x) => x.hasPlan && x.status === status);
    if (q) {
      const n = String(q).toLowerCase();
      list = list.filter((x) => x.studentName.toLowerCase().includes(n) || x.studentId.toLowerCase().includes(n));
    }
    res.json(list);
  });

  r.get('/fees/enrollments/:id', async (req, res) => {
    const t = req.tenantId;
    const e = await db.one(
      `select ${COLS.enrollment.replace(/(^|,\s*)(\w+)/g, '$1e.$2')}, c.name "className", y.label "yearLabel",
              s.first_name || ' ' || s.last_name "studentName"
         from enrollments e join classes c on c.id = e.class_id join academic_years y on y.id = e.academic_year_id
         join students s on s.tenant_id = e.tenant_id and s.id = e.student_id
        where e.id = $1 and e.tenant_id = $2`,
      [req.params.id, t],
    );
    if (!e) throw notFound('Enrollment');
    const others = await db.query(
      `select e.id, y.label "yearLabel", c.name "className" from enrollments e
         join academic_years y on y.id = e.academic_year_id join classes c on c.id = e.class_id
        where e.tenant_id = $1 and e.student_id = $2 and e.id <> $3 order by y.start_date`,
      [t, e.studentId, e.id],
    );
    const ctx = await feeContext(db, t, [e.id, ...others.map((o) => o.id)]);
    const d = today();
    res.json({
      enrollment: e,
      student: { id: e.studentId, name: e.studentName },
      className: e.className,
      yearLabel: e.yearLabel,
      plan: ctx.feePlans.find((p) => p.enrollmentId === e.id) ?? null,
      summary: summaryFor(ctx, e.id, d),
      installments: installmentProgress(ctx, e.id, d),
      payments: paymentsFor(ctx, e.id),
      otherYears: others.map((o) => ({ enrollmentId: o.id, yearLabel: o.yearLabel, className: o.className, ...summaryFor(ctx, o.id, d) })),
    });
  });

  /** One fee agreement per enrollment (unique in the database). */
  r.post('/fees/enrollments/:id/plan', async (req, res) => {
    const t = req.tenantId;
    const e = await db.one('select id from enrollments where id = $1 and tenant_id = $2', [req.params.id, t]);
    if (!e) throw notFound('Enrollment');
    const p = {
      annualFee: int(req.body, 'annualFee', { min: 1, max: 10_000_000 }),
      installmentCount: int(req.body, 'installmentCount', { min: 1, max: 36 }),
      frequency: oneOf(req.body, 'frequency', Object.keys(FREQUENCIES)),
      firstDueDate: date(req.body, 'firstDueDate'),
      note: str(req.body, 'note', { optional: true, max: 300 }) ?? null,
    };
    try {
      res.status(201).json(
        await db.one(
          `insert into fee_plans (id, tenant_id, enrollment_id, annual_fee, installment_count, frequency, first_due_date, note)
           values ($1, $2, $3, $4, $5, $6, $7, $8) returning ${COLS.feePlan}`,
          [newId(), t, e.id, p.annualFee, p.installmentCount, p.frequency, p.firstDueDate, p.note],
        ),
      );
    } catch (err) {
      if (err.code === '23505') throw conflict('A fee agreement already exists for this enrollment');
      throw err;
    }
  });

  /** Append-only: payments are never edited or deleted to change a balance. */
  r.post('/fees/payments', async (req, res) => {
    const t = req.tenantId;
    const enrollmentId = str(req.body, 'enrollmentId');
    const e = await db.one(
      `select e.id, s.first_name || ' ' || s.last_name name from enrollments e
         join students s on s.tenant_id = e.tenant_id and s.id = e.student_id where e.id = $1 and e.tenant_id = $2`,
      [enrollmentId, t],
    );
    if (!e) throw notFound('Enrollment');
    const d = today();
    const amount = int(req.body, 'amount', { min: 1, max: 10_000_000 });
    const paymentDate = date(req.body, 'date', { optional: true }) ?? d;
    if (paymentDate > d) throw badRequest('Payment date cannot be in the future', { field: 'date' });
    const method = oneOf(req.body, 'method', PAYMENT_METHODS);
    const payment = await db.tx(async (tx) => {
      // Lock the plan row so two simultaneous payments cannot overshoot the balance.
      const plan = await tx.one('select annual_fee from fee_plans where enrollment_id = $1 for update', [e.id]);
      if (!plan) throw badRequest('Set up a fee agreement before recording payments');
      const { paid } = await tx.one('select coalesce(sum(amount), 0)::int paid from payments where enrollment_id = $1', [e.id]);
      const outstanding = Math.max(0, plan.annual_fee - paid);
      if (amount > outstanding) {
        throw badRequest(`Amount exceeds the outstanding balance of ₹${outstanding.toLocaleString('en-IN')}`, { field: 'amount' });
      }
      return tx.one(
        `insert into payments (id, tenant_id, enrollment_id, amount, date, method, reference, note, recorded_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning ${COLS.payment}`,
        [newId(), t, e.id, amount, paymentDate, method, str(req.body, 'reference', { optional: true, max: 80 }) ?? null,
          str(req.body, 'note', { optional: true, max: 300 }) ?? null, req.user.name],
      );
    });
    const label = `₹${amount.toLocaleString('en-IN')}`;
    await logActivity(db, t, { type: 'payment', title: `Payment recorded · ${label}`, subtitle: `${e.name} · ${method}`, adminOnly: true });
    await notify(db, t, { type: 'payment', title: `Payment recorded · ${label}`, body: e.name, adminOnly: true });
    const ctx = await feeContext(db, t, [e.id]);
    res.status(201).json({ payment, summary: summaryFor(ctx, e.id, d) });
  });

  return r;
}
