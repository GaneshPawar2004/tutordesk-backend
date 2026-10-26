import { Router } from 'express';

import { nextId } from '../data/store.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { date, int, isoDate, oneOf, phone, str } from '../lib/util.js';
import { adminOnly } from '../middleware/auth.js';
import { can, canAccessClass, currentYear, fullName, requirePermission } from '../services/access.js';
import { FREQUENCIES, PAYMENT_METHODS, installmentProgress, paymentsFor, planFor, summaryFor } from '../services/fees.js';
import { resultFor } from '../services/results.js';

export function studentRoutes() {
  const r = Router();
  const className = (t, id) => t.classes.find((c) => c.id === id)?.name ?? '—';

  /** Staff may only see students enrolled in their classes (in any year). */
  function assertStudentAccess(req, studentId) {
    requirePermission(req.user, 'viewStudents');
    if (req.user.role === 'admin') return;
    const ok = req.tenant.enrollments.some((e) => e.studentId === studentId && canAccessClass(req.user, e.classId));
    if (!ok) throw forbidden('This student is not in your classes');
  }

  r.get('/students', (req, res) => {
    requirePermission(req.user, 'viewStudents');
    const t = req.tenant;
    const yearId = req.query.yearId ?? currentYear(t).id;
    const q = String(req.query.q ?? '').trim().toLowerCase();
    const status = req.query.status ?? 'active';
    const rows = [];
    for (const e of t.enrollments) {
      if (e.academicYearId !== yearId || !canAccessClass(req.user, e.classId)) continue;
      if (req.query.classId && e.classId !== req.query.classId) continue;
      const s = t.students.find((x) => x.id === e.studentId);
      const active = s.isActive && e.status !== 'withdrawn';
      if (status === 'active' && !active) continue;
      if (status === 'inactive' && active) continue;
      if (q && !(fullName(s).toLowerCase().includes(q) || s.id.toLowerCase().includes(q) || s.parentName.toLowerCase().includes(q) || (q.replace(/\D/g, '').length >= 3 && s.parentPhone.includes(q.replace(/\D/g, ''))))) continue;
      rows.push({
        id: s.id, firstName: s.firstName, lastName: s.lastName, parentName: s.parentName,
        parentPhoneSuffix: s.parentPhone.slice(-4), classId: e.classId, className: className(t, e.classId),
        enrollmentId: e.id, active,
      });
    }
    rows.sort((a, b) => `${a.firstName} ${a.lastName}`.localeCompare(`${b.firstName} ${b.lastName}`));
    res.json(rows);
  });

  r.get('/students/next-id', adminOnly, (req, res) => {
    res.json({ id: `STU-${String(req.tenant.counters.student + 1).padStart(4, '0')}` });
  });

  r.get('/students/:id', (req, res) => {
    const t = req.tenant;
    const s = t.students.find((x) => x.id === req.params.id);
    if (!s) throw notFound('Student');
    assertStudentAccess(req, s.id);
    const today = isoDate(new Date());
    const yearOrder = Object.fromEntries(t.years.map((y) => [y.id, y.startDate]));
    const enrollments = t.enrollments
      .filter((e) => e.studentId === s.id)
      .sort((a, b) => yearOrder[a.academicYearId].localeCompare(yearOrder[b.academicYearId]))
      .map((e) => ({
        ...e,
        className: className(t, e.classId),
        yearLabel: t.years.find((y) => y.id === e.academicYearId).label,
        // Fee figures are attached only for the admin.
        ...(req.user.role === 'admin' ? { fees: summaryFor(t, e.id, today) } : {}),
      }));

    const year = currentYear(t);
    const history = t.sessions
      .filter((x) => x.academicYearId === year.id && x.records[s.id])
      .map((x) => ({ date: x.date, status: x.records[s.id] }))
      .sort((a, b) => b.date.localeCompare(a.date));
    const count = (st) => history.filter((h) => h.status === st).length;
    const attended = count('present') + count('late');

    const exams = can(req.user, 'viewExamResults')
      ? t.exams
          .filter((ex) => enrollments.some((e) => e.academicYearId === ex.academicYearId && e.classId === ex.classId))
          .filter((ex) => ex.resultsPublished || (req.user.role === 'admin' && Object.keys(ex.marks).length))
          .sort((a, b) => b.date.localeCompare(a.date))
          .map((ex) => ({ id: ex.id, name: ex.name, date: ex.date, published: ex.resultsPublished, result: resultFor(t, ex, s.id) }))
      : [];

    res.json({
      student: s,
      enrollments,
      attendance: {
        yearLabel: year.label,
        present: count('present'), absent: count('absent'), late: count('late'), leave: count('leave'),
        total: history.length,
        percent: history.length ? Math.round((attended * 1000) / history.length) / 10 : 0,
        history,
      },
      exams,
    });
  });

  r.post('/students', adminOnly, (req, res) => {
    const t = req.tenant;
    const b = req.body ?? {};
    const yearId = str(b, 'yearId');
    const classId = str(b, 'classId');
    if (!t.years.some((y) => y.id === yearId)) throw badRequest('Unknown academic year', { field: 'yearId' });
    if (!t.classes.some((c) => c.id === classId && c.isActive)) throw badRequest('Unknown class', { field: 'classId' });
    const student = {
      id: null, // assigned after validation so rejected requests don't consume IDs
      firstName: str(b, 'firstName', { max: 60 }),
      lastName: str(b, 'lastName', { max: 60 }),
      dateOfBirth: date(b, 'dateOfBirth'),
      gender: oneOf(b, 'gender', ['female', 'male', 'other'], { optional: true }) ?? null,
      parentName: str(b, 'parentName', { max: 100 }),
      parentPhone: phone(b, 'parentPhone'),
      altPhone: phone(b, 'altPhone', { optional: true }) ?? null,
      address: str(b, 'address', { optional: true, max: 300 }) ?? null,
      admittedOn: date(b, 'enrolledOn', { optional: true }) ?? isoDate(new Date()),
      isActive: b.active !== false,
    };
    const enrollment = {
      id: null, studentId: null, academicYearId: yearId, classId,
      enrolledOn: student.admittedOn, status: student.isActive ? 'active' : 'withdrawn', promotedFromId: null,
    };

    let plan = null;
    let payment = null;
    if (b.fee) {
      const f = b.fee;
      const annualFee = int(f, 'annualFee', { min: 1, max: 10_000_000 });
      const initial = int(f, 'initialAmount', { optional: true, min: 0, max: annualFee }) ?? 0;
      plan = {
        id: null, enrollmentId: null, annualFee,
        installmentCount: int(f, 'installmentCount', { min: 1, max: 36 }),
        frequency: oneOf(f, 'frequency', Object.keys(FREQUENCIES)),
        firstDueDate: date(f, 'firstDueDate'),
        note: str(f, 'note', { optional: true, max: 300 }) ?? null,
      };
      if (initial > 0) {
        payment = {
          id: null, enrollmentId: null, amount: initial,
          date: date(f, 'paymentDate', { optional: true }) ?? isoDate(new Date()),
          method: oneOf(f, 'method', PAYMENT_METHODS), reference: null,
          note: 'Initial payment at admission', recordedBy: req.user.name,
        };
      }
    }
    // Validation done — allocate IDs and commit everything together.
    student.id = `STU-${String(++t.counters.student).padStart(4, '0')}`;
    enrollment.id = nextId(t, 'enrollment', 'enr');
    enrollment.studentId = student.id;
    if (plan) Object.assign(plan, { id: nextId(t, 'fee', 'fee'), enrollmentId: enrollment.id });
    if (payment) Object.assign(payment, { id: nextId(t, 'payment', 'pay'), enrollmentId: enrollment.id });
    t.students.push(student);
    t.enrollments.push(enrollment);
    if (plan) t.feePlans.push(plan);
    if (payment) t.payments.push(payment);
    t.activity.push({ type: 'student', title: 'Student admitted', subtitle: `${fullName(student)} · ${className(t, classId)}`, at: new Date().toISOString(), adminOnly: false });
    res.status(201).json({ student, enrollment });
  });

  r.patch('/students/:id', (req, res) => {
    const t = req.tenant;
    const s = t.students.find((x) => x.id === req.params.id);
    if (!s) throw notFound('Student');
    if (req.user.role !== 'admin') {
      requirePermission(req.user, 'editStudents');
      assertStudentAccess(req, s.id);
    }
    const b = { ...s, ...req.body };
    const updates = {
      firstName: str(b, 'firstName', { max: 60 }),
      lastName: str(b, 'lastName', { max: 60 }),
      dateOfBirth: date(b, 'dateOfBirth'),
      parentName: str(b, 'parentName', { max: 100 }),
      parentPhone: phone(b, 'parentPhone'),
      altPhone: phone(b, 'altPhone', { optional: true }) ?? null,
      address: str(b, 'address', { optional: true, max: 300 }) ?? null,
    };
    Object.assign(s, updates);
    if (req.user.role === 'admin' && typeof req.body.isActive === 'boolean') s.isActive = req.body.isActive;
    res.json(s);
  });

  // ------------------------------------------------------------ promotion
  /**
   * Creates a new enrollment per student in the destination year. The
   * permanent student record is reused; previous enrollments, fee plans and
   * payments are untouched (only the old enrollment's status changes).
   */
  r.post('/promotions', adminOnly, (req, res) => {
    const t = req.tenant;
    const b = req.body ?? {};
    const from = t.years.find((y) => y.id === b.fromYearId);
    const to = t.years.find((y) => y.id === b.toYearId);
    const toClass = t.classes.find((c) => c.id === b.toClassId);
    if (!from || !to || !toClass) throw badRequest('fromYearId, toYearId and toClassId are required');
    if (to.startDate <= from.startDate) throw badRequest('Destination year must come after the source year');
    if (!Array.isArray(b.studentIds) || !b.studentIds.length) throw badRequest('Select at least one student');
    const annualFee = int(b, 'annualFee', { optional: true, min: 1, max: 10_000_000 });
    const installments = int(b, 'installments', { optional: true, min: 1, max: 36 }) ?? 1;

    const promoted = [];
    const skipped = [];
    for (const id of b.studentIds) {
      if (!t.students.some((s) => s.id === id) || t.enrollments.some((e) => e.studentId === id && e.academicYearId === to.id)) {
        skipped.push(id);
        continue;
      }
      const source = t.enrollments.find((e) => e.studentId === id && e.academicYearId === from.id);
      if (source) source.status = 'promoted';
      const e = { id: nextId(t, 'enrollment', 'enr'), studentId: id, academicYearId: to.id, classId: toClass.id, enrolledOn: to.startDate, status: 'active', promotedFromId: source?.id ?? null };
      t.enrollments.push(e);
      if (annualFee) {
        t.feePlans.push({ id: nextId(t, 'fee', 'fee'), enrollmentId: e.id, annualFee, installmentCount: installments, frequency: installments === 1 ? 'custom' : 'monthly', firstDueDate: `${to.startDate.slice(0, 7)}-10`, note: null });
      }
      promoted.push(e);
    }
    if (promoted.length) {
      t.activity.push({ type: 'student', title: 'Students promoted', subtitle: `${promoted.length} → ${toClass.name}, ${to.label}`, at: new Date().toISOString(), adminOnly: true });
    }
    res.status(201).json({ promoted, skipped });
  });

  // Admin-only fee view embedded in the student area for convenience.
  r.get('/students/:id/fees', adminOnly, (req, res) => {
    const t = req.tenant;
    const today = isoDate(new Date());
    const list = t.enrollments.filter((e) => e.studentId === req.params.id);
    if (!list.length) throw notFound('Student');
    res.json(
      list.map((e) => ({
        enrollmentId: e.id,
        yearLabel: t.years.find((y) => y.id === e.academicYearId).label,
        className: className(t, e.classId),
        plan: planFor(t, e.id) ?? null,
        summary: summaryFor(t, e.id, today),
        installments: installmentProgress(t, e.id, today),
        payments: paymentsFor(t, e.id),
      })),
    );
  });

  return r;
}
