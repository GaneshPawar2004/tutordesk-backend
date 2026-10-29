import { Router } from 'express';

import { COLS, currentYear, feeContext, fullName, logActivity, newId, notify, subjects, today } from '../data/repo.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { date, int, oneOf, phone, str } from '../lib/util.js';
import { adminOnly } from '../middleware/auth.js';
import { can, canAccessClass, requirePermission } from '../services/access.js';
import { FREQUENCIES, PAYMENT_METHODS, installmentProgress, paymentsFor, summaryFor } from '../services/fees.js';
import { resultFor } from '../services/results.js';

export function studentRoutes(db) {
  const r = Router();

  async function assertStudentAccess(req, studentId) {
    requirePermission(req.user, 'viewStudents');
    if (req.user.role === 'admin') return;
    const rows = await db.query('select class_id from enrollments where tenant_id = $1 and student_id = $2', [req.tenantId, studentId]);
    if (!rows.some((e) => canAccessClass(req.user, e.class_id))) throw forbidden('This student is not in your classes');
  }

  r.get('/students', async (req, res) => {
    requirePermission(req.user, 'viewStudents');
    const t = req.tenantId;
    const yearId = req.query.yearId ?? (await currentYear(db, t))?.id;
    const status = req.query.status ?? 'active';
    const q = String(req.query.q ?? '').trim().toLowerCase();
    const digits = q.replace(/\D/g, '');
    const rows = await db.query(
      `select s.id, s.first_name "firstName", s.last_name "lastName", s.parent_name "parentName",
              right(s.parent_phone, 4) "parentPhoneSuffix", s.parent_phone "_phone", e.class_id "classId", c.name "className", e.id "enrollmentId",
              (s.is_active and e.status <> 'withdrawn') active
         from enrollments e
         join students s on s.tenant_id = e.tenant_id and s.id = e.student_id
         join classes c on c.id = e.class_id
        where e.tenant_id = $1 and e.academic_year_id = $2 and ($3::text is null or e.class_id = $3)
        order by s.first_name, s.last_name`,
      [t, yearId, req.query.classId || null],
    );
    res.json(
      rows
        .filter((s) => {
          if (!canAccessClass(req.user, s.classId)) return false;
          if (status === 'active' && !s.active) return false;
          if (status === 'inactive' && s.active) return false;
          if (!q) return true;
          return `${s.firstName} ${s.lastName}`.toLowerCase().includes(q) || s.id.toLowerCase().includes(q) ||
            s.parentName.toLowerCase().includes(q) || (digits.length >= 3 && s._phone.includes(digits));
        })
        .map(({ _phone, ...s }) => s),
    );
  });

  r.get('/students/next-id', adminOnly, async (req, res) => {
    const t = await db.one('select student_seq from tenants where id = $1', [req.tenantId]);
    res.json({ id: `STU-${String(t.student_seq + 1).padStart(4, '0')}` });
  });

  r.get('/students/:id', async (req, res) => {
    const t = req.tenantId;
    const s = await db.one(`select ${COLS.student} from students where tenant_id = $1 and id = $2`, [t, req.params.id]);
    if (!s) throw notFound('Student');
    await assertStudentAccess(req, s.id);
    const d = today();
    const enrollments = await db.query(
      `select ${COLS.enrollment.replace(/(^|,\s*)(\w+)/g, '$1e.$2')}, c.name "className", y.label "yearLabel"
         from enrollments e join classes c on c.id = e.class_id join academic_years y on y.id = e.academic_year_id
        where e.tenant_id = $1 and e.student_id = $2 order by y.start_date`,
      [t, s.id],
    );
    if (req.user.role === 'admin') {
      const ctx = await feeContext(db, t, enrollments.map((e) => e.id));
      for (const e of enrollments) e.fees = summaryFor(ctx, e.id, d);
    }
    const year = await currentYear(db, t);
    const history = (
      await db.query(
        `select date, records->>$3 status from attendance_sessions where tenant_id = $1 and academic_year_id = $2 and records ? $3 order by date desc`,
        [t, year.id, s.id],
      )
    );
    const count = (st) => history.filter((h) => h.status === st).length;
    const attended = count('present') + count('late');
    let exams = [];
    if (can(req.user, 'viewExamResults')) {
      const subs = await subjects(db, t);
      const pairs = enrollments.map((e) => `${e.academicYearId}|${e.classId}`);
      exams = (await db.query(`select ${COLS.exam} from exams where tenant_id = $1 order by date desc`, [t]))
        .filter((ex) => pairs.includes(`${ex.academicYearId}|${ex.classId}`))
        .filter((ex) => ex.resultsPublished || (req.user.role === 'admin' && Object.keys(ex.marks).length))
        .map((ex) => ({ id: ex.id, name: ex.name, date: ex.date, published: ex.resultsPublished, result: resultFor({ subjects: subs }, ex, s.id) }));
    }
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

  r.post('/students', adminOnly, async (req, res) => {
    const t = req.tenantId;
    const b = req.body ?? {};
    const yearId = str(b, 'yearId');
    const classId = str(b, 'classId');
    if (!(await db.one('select 1 from academic_years where id = $1 and tenant_id = $2', [yearId, t]))) throw badRequest('Unknown academic year', { field: 'yearId' });
    if (!(await db.one('select 1 from classes where id = $1 and tenant_id = $2 and is_active', [classId, t]))) throw badRequest('Choose a class (create one first if the list is empty)', { field: 'classId' });
    const s = {
      firstName: str(b, 'firstName', { max: 60 }),
      lastName: str(b, 'lastName', { max: 60 }),
      dateOfBirth: date(b, 'dateOfBirth'),
      gender: oneOf(b, 'gender', ['female', 'male', 'other'], { optional: true }) ?? null,
      parentName: str(b, 'parentName', { max: 100 }),
      parentPhone: phone(b, 'parentPhone'),
      altPhone: phone(b, 'altPhone', { optional: true }) ?? null,
      address: str(b, 'address', { optional: true, max: 300 }) ?? null,
      admittedOn: date(b, 'enrolledOn', { optional: true }) ?? today(),
      isActive: b.active !== false,
    };
    let fee = null;
    if (b.fee) {
      const f = b.fee;
      const annualFee = int(f, 'annualFee', { min: 1, max: 10_000_000 });
      fee = {
        annualFee,
        installmentCount: int(f, 'installmentCount', { min: 1, max: 36 }),
        frequency: oneOf(f, 'frequency', Object.keys(FREQUENCIES)),
        firstDueDate: date(f, 'firstDueDate'),
        note: str(f, 'note', { optional: true, max: 300 }) ?? null,
        initial: int(f, 'initialAmount', { optional: true, min: 0, max: annualFee }) ?? 0,
        paymentDate: date(f, 'paymentDate', { optional: true }) ?? today(),
        method: f.initialAmount > 0 ? oneOf(f, 'method', PAYMENT_METHODS) : 'cash',
      };
    }
    const className = (await db.one('select name from classes where id = $1', [classId])).name;
    const result = await db.tx(async (tx) => {
      const { student_seq: seq } = await tx.one('update tenants set student_seq = student_seq + 1 where id = $1 returning student_seq', [t]);
      const id = `STU-${String(seq).padStart(4, '0')}`;
      const student = await tx.one(
        `insert into students (tenant_id, id, first_name, last_name, date_of_birth, gender, parent_name, parent_phone, alt_phone, address, admitted_on, is_active)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) returning ${COLS.student}`,
        [t, id, s.firstName, s.lastName, s.dateOfBirth, s.gender, s.parentName, s.parentPhone, s.altPhone, s.address, s.admittedOn, s.isActive],
      );
      const enrollment = await tx.one(
        `insert into enrollments (id, tenant_id, student_id, academic_year_id, class_id, enrolled_on, status)
         values ($1, $2, $3, $4, $5, $6, $7) returning ${COLS.enrollment}`,
        [newId(), t, id, yearId, classId, s.admittedOn, s.isActive ? 'active' : 'withdrawn'],
      );
      if (fee) {
        await tx.query(
          `insert into fee_plans (id, tenant_id, enrollment_id, annual_fee, installment_count, frequency, first_due_date, note)
           values ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [newId(), t, enrollment.id, fee.annualFee, fee.installmentCount, fee.frequency, fee.firstDueDate, fee.note],
        );
        if (fee.initial > 0) {
          await tx.query(
            `insert into payments (id, tenant_id, enrollment_id, amount, date, method, note, recorded_by)
             values ($1, $2, $3, $4, $5, $6, 'Initial payment at admission', $7)`,
            [newId(), t, enrollment.id, fee.initial, fee.paymentDate, fee.method, req.user.name],
          );
        }
      }
      return { student, enrollment };
    });
    await logActivity(db, t, { type: 'student', title: 'Student admitted', subtitle: `${fullName(result.student)} · ${className}` });
    await notify(db, t, { type: 'student', title: `New admission: ${fullName(result.student)}`, body: className });
    res.status(201).json(result);
  });

  r.patch('/students/:id', async (req, res) => {
    const t = req.tenantId;
    const s = await db.one(`select ${COLS.student} from students where tenant_id = $1 and id = $2`, [t, req.params.id]);
    if (!s) throw notFound('Student');
    if (req.user.role !== 'admin') {
      requirePermission(req.user, 'editStudents');
      await assertStudentAccess(req, s.id);
    }
    const b = { ...s, ...req.body };
    const isActive = req.user.role === 'admin' && typeof req.body.isActive === 'boolean' ? req.body.isActive : s.isActive;
    res.json(
      await db.one(
        `update students set first_name = $3, last_name = $4, date_of_birth = $5, gender = $6, parent_name = $7, parent_phone = $8,
                alt_phone = $9, address = $10, is_active = $11 where tenant_id = $1 and id = $2 returning ${COLS.student}`,
        [t, s.id, str(b, 'firstName', { max: 60 }), str(b, 'lastName', { max: 60 }), date(b, 'dateOfBirth'),
          oneOf(b, 'gender', ['female', 'male', 'other'], { optional: true }) ?? null, str(b, 'parentName', { max: 100 }),
          phone(b, 'parentPhone'), phone(b, 'altPhone', { optional: true }) ?? null, str(b, 'address', { optional: true, max: 300 }) ?? null, isActive],
      ),
    );
  });

  /**
   * Adds an enrollment in the destination year for each student. The student
   * record is reused (never copied); the previous enrollment, its fee plan and
   * payments stay as they were, only marked "promoted".
   */
  r.post('/promotions', adminOnly, async (req, res) => {
    const t = req.tenantId;
    const b = req.body ?? {};
    const from = await db.one(`select ${COLS.year} from academic_years where id = $1 and tenant_id = $2`, [b.fromYearId, t]);
    const to = await db.one(`select ${COLS.year} from academic_years where id = $1 and tenant_id = $2`, [b.toYearId, t]);
    const toClass = await db.one('select id, name from classes where id = $1 and tenant_id = $2', [b.toClassId, t]);
    if (!from || !to || !toClass) throw badRequest('Choose the source year, destination year and destination class');
    if (to.startDate <= from.startDate) throw badRequest('Destination year must come after the source year');
    if (!Array.isArray(b.studentIds) || !b.studentIds.length) throw badRequest('Select at least one student');
    const annualFee = int(b, 'annualFee', { optional: true, min: 1, max: 10_000_000 });
    const installments = int(b, 'installments', { optional: true, min: 1, max: 36 }) ?? 1;

    const result = await db.tx(async (tx) => {
      const promoted = [];
      const skipped = [];
      for (const id of b.studentIds) {
        const exists = await tx.one('select 1 from enrollments where tenant_id = $1 and student_id = $2 and academic_year_id = $3', [t, id, to.id]);
        const student = await tx.one('select 1 from students where tenant_id = $1 and id = $2', [t, id]);
        if (exists || !student) { skipped.push(id); continue; }
        const source = await tx.one(
          `update enrollments set status = 'promoted' where tenant_id = $1 and student_id = $2 and academic_year_id = $3 returning id`,
          [t, id, from.id],
        );
        const e = await tx.one(
          `insert into enrollments (id, tenant_id, student_id, academic_year_id, class_id, enrolled_on, status, promoted_from_id)
           values ($1, $2, $3, $4, $5, $6, 'active', $7) returning ${COLS.enrollment}`,
          [newId(), t, id, to.id, toClass.id, to.startDate, source?.id ?? null],
        );
        if (annualFee) {
          await tx.query(
            `insert into fee_plans (id, tenant_id, enrollment_id, annual_fee, installment_count, frequency, first_due_date)
             values ($1, $2, $3, $4, $5, $6, $7)`,
            [newId(), t, e.id, annualFee, installments, installments === 1 ? 'custom' : 'monthly', `${to.startDate.slice(0, 7)}-10`],
          );
        }
        promoted.push(e);
      }
      return { promoted, skipped };
    });
    if (result.promoted.length) {
      await logActivity(db, t, { type: 'student', title: 'Students promoted', subtitle: `${result.promoted.length} → ${toClass.name}, ${to.label}`, adminOnly: true });
    }
    res.status(201).json(result);
  });

  r.get('/students/:id/fees', adminOnly, async (req, res) => {
    const t = req.tenantId;
    const list = await db.query(
      `select e.id, e.academic_year_id, y.label "yearLabel", c.name "className"
         from enrollments e join academic_years y on y.id = e.academic_year_id join classes c on c.id = e.class_id
        where e.tenant_id = $1 and e.student_id = $2 order by y.start_date`,
      [t, req.params.id],
    );
    if (!list.length) throw notFound('Student');
    const ctx = await feeContext(db, t, list.map((e) => e.id));
    const d = today();
    res.json(
      list.map((e) => ({
        enrollmentId: e.id,
        yearLabel: e.yearLabel,
        className: e.className,
        plan: ctx.feePlans.find((p) => p.enrollmentId === e.id) ?? null,
        summary: summaryFor(ctx, e.id, d),
        installments: installmentProgress(ctx, e.id, d),
        payments: paymentsFor(ctx, e.id),
      })),
    );
  });

  return r;
}
