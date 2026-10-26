import { Router } from 'express';

import { nextId } from '../data/store.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { date, int, isoDate, oneOf, str } from '../lib/util.js';
import { adminOnly } from '../middleware/auth.js';
import { currentYear, fullName } from '../services/access.js';
import {
  FREQUENCIES,
  PAYMENT_METHODS,
  addSummaries,
  installmentProgress,
  paymentsFor,
  planFor,
  summaryFor,
} from '../services/fees.js';

/** Every route here is admin-only; staff receive 403 from the API itself. */
export function feeRoutes() {
  const r = Router();
  r.use('/fees', adminOnly);

  const rows = (t, yearId, classId) => {
    const today = isoDate(new Date());
    return t.enrollments
      .filter((e) => e.academicYearId === yearId && (!classId || e.classId === classId))
      .map((e) => {
        const s = t.students.find((x) => x.id === e.studentId);
        return {
          enrollmentId: e.id,
          studentId: s.id,
          studentName: fullName(s),
          classId: e.classId,
          className: t.classes.find((c) => c.id === e.classId).name,
          active: s.isActive && e.status !== 'withdrawn',
          ...summaryFor(t, e.id, today),
        };
      })
      .filter((row) => row.hasPlan || row.active)
      .sort((a, b) => a.studentName.localeCompare(b.studentName));
  };

  r.get('/fees/summary', (req, res) => {
    const t = req.tenant;
    const yearId = req.query.yearId ?? currentYear(t).id;
    const list = rows(t, yearId, req.query.classId);
    const ids = new Set(list.map((x) => x.enrollmentId));
    const today = new Date();
    const monthStart = isoDate(new Date(today.getFullYear(), today.getMonth(), 1));
    const recent = t.payments
      .filter((p) => ids.has(p.enrollmentId))
      .sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id));
    res.json({
      totals: addSummaries(list),
      collectedThisMonth: recent.filter((p) => p.date >= monthStart).reduce((s, p) => s + p.amount, 0),
      statusCounts: {
        paid: list.filter((x) => x.hasPlan && x.status === 'paid').length,
        partial: list.filter((x) => x.hasPlan && x.status === 'partial').length,
        unpaid: list.filter((x) => x.hasPlan && x.status === 'unpaid').length,
        noPlan: list.filter((x) => !x.hasPlan).length,
        overdue: list.filter((x) => x.overdue > 0).length,
      },
      recentPayments: recent.slice(0, 10).map((p) => {
        const e = t.enrollments.find((x) => x.id === p.enrollmentId);
        const s = t.students.find((x) => x.id === e.studentId);
        return { ...p, studentName: fullName(s), studentId: s.id };
      }),
    });
  });

  r.get('/fees/students', (req, res) => {
    const t = req.tenant;
    let list = rows(t, req.query.yearId ?? currentYear(t).id, req.query.classId);
    const { status, q } = req.query;
    if (status === 'overdue') list = list.filter((x) => x.overdue > 0);
    else if (status === 'none') list = list.filter((x) => !x.hasPlan);
    else if (status) list = list.filter((x) => x.hasPlan && x.status === status);
    if (q) {
      const needle = String(q).toLowerCase();
      list = list.filter((x) => x.studentName.toLowerCase().includes(needle) || x.studentId.toLowerCase().includes(needle));
    }
    res.json(list);
  });

  r.get('/fees/enrollments/:id', (req, res) => {
    const t = req.tenant;
    const e = t.enrollments.find((x) => x.id === req.params.id);
    if (!e) throw notFound('Enrollment');
    const s = t.students.find((x) => x.id === e.studentId);
    const today = isoDate(new Date());
    res.json({
      enrollment: e,
      student: { id: s.id, name: fullName(s) },
      className: t.classes.find((c) => c.id === e.classId).name,
      yearLabel: t.years.find((y) => y.id === e.academicYearId).label,
      plan: planFor(t, e.id) ?? null,
      summary: summaryFor(t, e.id, today),
      installments: installmentProgress(t, e.id, today),
      payments: paymentsFor(t, e.id),
      otherYears: t.enrollments
        .filter((x) => x.studentId === s.id && x.id !== e.id)
        .map((x) => ({
          enrollmentId: x.id,
          yearLabel: t.years.find((y) => y.id === x.academicYearId).label,
          className: t.classes.find((c) => c.id === x.classId).name,
          ...summaryFor(t, x.id, today),
        })),
    });
  });

  /** One fee agreement per enrollment; a new year never overwrites an old one. */
  r.post('/fees/enrollments/:id/plan', (req, res) => {
    const t = req.tenant;
    const e = t.enrollments.find((x) => x.id === req.params.id);
    if (!e) throw notFound('Enrollment');
    if (planFor(t, e.id)) throw conflict('A fee agreement already exists for this enrollment');
    const plan = {
      id: nextId(t, 'fee', 'fee'),
      enrollmentId: e.id,
      annualFee: int(req.body, 'annualFee', { min: 1, max: 10_000_000 }),
      installmentCount: int(req.body, 'installmentCount', { min: 1, max: 36 }),
      frequency: oneOf(req.body, 'frequency', Object.keys(FREQUENCIES)),
      firstDueDate: date(req.body, 'firstDueDate'),
      note: str(req.body, 'note', { optional: true, max: 300 }) ?? null,
    };
    t.feePlans.push(plan);
    res.status(201).json(plan);
  });

  /** Append-only: a payment is never edited or deleted to change a balance. */
  r.post('/fees/payments', (req, res) => {
    const t = req.tenant;
    const enrollmentId = str(req.body, 'enrollmentId');
    const e = t.enrollments.find((x) => x.id === enrollmentId);
    if (!e) throw notFound('Enrollment');
    const today = isoDate(new Date());
    const summary = summaryFor(t, e.id, today);
    if (!summary.hasPlan) throw badRequest('Set up a fee agreement before recording payments');
    const amount = int(req.body, 'amount', { min: 1, max: 10_000_000 });
    if (amount > summary.outstanding) {
      throw badRequest(`Amount exceeds the outstanding balance of ₹${summary.outstanding.toLocaleString('en-IN')}`, { field: 'amount' });
    }
    const paymentDate = date(req.body, 'date', { optional: true }) ?? today;
    if (paymentDate > today) throw badRequest('Payment date cannot be in the future', { field: 'date' });
    const payment = {
      id: nextId(t, 'payment', 'pay'),
      enrollmentId: e.id,
      amount,
      date: paymentDate,
      method: oneOf(req.body, 'method', PAYMENT_METHODS),
      reference: str(req.body, 'reference', { optional: true, max: 80 }) ?? null,
      note: str(req.body, 'note', { optional: true, max: 300 }) ?? null,
      recordedBy: req.user.name,
    };
    t.payments.push(payment);
    const s = t.students.find((x) => x.id === e.studentId);
    t.activity.push({ type: 'payment', title: `Payment recorded · ₹${amount.toLocaleString('en-IN')}`, subtitle: `${fullName(s)} · ${payment.method}`, at: new Date().toISOString(), adminOnly: true });
    res.status(201).json({ payment, summary: summaryFor(t, e.id, today) });
  });

  return r;
}
