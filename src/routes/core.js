import { Router } from 'express';

import { COLS, currentYear, feeContext, newId, subjects, today } from '../data/repo.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { date, int, phone, str } from '../lib/util.js';
import { adminOnly } from '../middleware/auth.js';
import { canAccessClass, canSendMessages } from '../services/access.js';
import { addSummaries, summaryFor } from '../services/fees.js';
import { examStatus } from '../services/results.js';

/** Profile, dashboard, academic years, classes, subjects, notifications, settings. */
export function coreRoutes(db) {
  const r = Router();
  const tuition = (tenantId) => db.one('select id, name, city, address, phone, email from tenants where id = $1', [tenantId]);

  r.get('/me', async (req, res) => {
    const u = req.user;
    const year = await currentYear(db, req.tenantId);
    res.json({
      role: u.role,
      id: u.id,
      name: u.name,
      email: u.email,
      phone: u.phone,
      designation: u.designation,
      permissions: u.role === 'admin' ? 'all' : u.permissions,
      assignedClassIds: u.assignedClassIds,
      canSeeFinance: u.role === 'admin',
      canSendMessages: canSendMessages(u),
      tuition: await tuition(req.tenantId),
      currentYearId: year?.id ?? null,
    });
  });

  r.patch('/me', async (req, res) => {
    const b = { ...req.user, ...req.body };
    const email = str(b, 'email', { optional: true, max: 120 })?.toLowerCase() || null;
    try {
      await db.query('update users set name = $2, email = $3, phone = $4 where id = $1', [
        req.user.id, str(b, 'name', { min: 2, max: 80 }), email, phone(b, 'phone'),
      ]);
    } catch (e) {
      if (e.code === '23505') throw conflict('That phone number or email is already used by another account');
      throw e;
    }
    res.json({ ok: true });
  });

  r.get('/dashboard', async (req, res) => {
    const u = req.user;
    const t = req.tenantId;
    const d = today();
    const year = await currentYear(db, t);
    const classes = (await db.query(`select ${COLS.class} from classes where tenant_id = $1 and is_active order by grade, name`, [t]))
      .filter((c) => canAccessClass(u, c.id));
    const ids = classes.map((c) => c.id);
    const counts = await db.query(
      `select e.class_id, count(*)::int n from enrollments e join students s on s.tenant_id = e.tenant_id and s.id = e.student_id
        where e.tenant_id = $1 and e.academic_year_id = $2 and e.status <> 'withdrawn' and s.is_active and e.class_id = any($3)
        group by e.class_id`,
      [t, year.id, ids],
    );
    const sessions = await db.query(`select class_id, records from attendance_sessions where tenant_id = $1 and date = $2 and class_id = any($3)`, [t, d, ids]);
    let present = 0, absent = 0, lateOrLeave = 0, notMarked = 0, students = 0;
    const classRows = classes.map((c) => {
      const n = counts.find((x) => x.class_id === c.id)?.n ?? 0;
      students += n;
      const s = sessions.find((x) => x.class_id === c.id);
      if (!s) notMarked += n;
      else {
        for (const v of Object.values(s.records)) {
          if (v === 'present' || v === 'late') present++;
          if (v === 'absent') absent++;
          if (v === 'late' || v === 'leave') lateOrLeave++;
        }
      }
      return { id: c.id, name: c.name, sessionLabel: c.sessionLabel, students: n, marked: !!s };
    });
    const exams = (await db.query(`select ${COLS.exam} from exams where tenant_id = $1 and academic_year_id = $2`, [t, year.id]))
      .filter((e) => canAccessClass(u, e.classId));
    const body = {
      yearLabel: year.label,
      students,
      classes: classRows,
      attendance: { classesMarked: sessions.length, classesTotal: classes.length, present, absent, lateOrLeave, notMarked },
      upcomingExams: exams
        .filter((e) => examStatus(e, d) === 'upcoming')
        .sort((a, b) => a.date.localeCompare(b.date))
        .map((e) => ({ id: e.id, name: e.name, date: e.date, className: classes.find((c) => c.id === e.classId)?.name ?? '' })),
      resultsPending: exams.filter((e) => examStatus(e, d) === 'completed').length,
      activity: await db.query(
        `select ${COLS.activity} from activity where tenant_id = $1 and ($2 or not admin_only) order by at desc limit 6`,
        [t, u.role === 'admin'],
      ),
      events: [],
    };
    if (u.role === 'admin') {
      const enr = await db.query(`select id from enrollments where tenant_id = $1 and academic_year_id = $2`, [t, year.id]);
      const ctx = await feeContext(db, t, enr.map((e) => e.id));
      body.fees = addSummaries(enr.map((e) => summaryFor(ctx, e.id, d)));
    }
    res.json(body);
  });

  // ------------------------------------------------------- academic years
  r.get('/academic-years', async (req, res) => {
    res.json(
      await db.query(
        `select ${COLS.year}, (select count(*)::int from enrollments e where e.academic_year_id = y.id) enrollments
           from academic_years y where tenant_id = $1 order by start_date desc`,
        [req.tenantId],
      ),
    );
  });

  r.post('/academic-years', adminOnly, async (req, res) => {
    const label = str(req.body, 'label', { max: 20 });
    const startDate = date(req.body, 'startDate');
    const endDate = date(req.body, 'endDate');
    if (endDate <= startDate) throw badRequest('End date must be after start date');
    try {
      const y = await db.one(
        `insert into academic_years (id, tenant_id, label, start_date, end_date, status) values ($1, $2, $3, $4, $5, 'upcoming') returning ${COLS.year}`,
        [newId(), req.tenantId, label, startDate, endDate],
      );
      res.status(201).json(y);
    } catch (e) {
      if (e.code === '23505') throw badRequest('This academic year already exists');
      throw e;
    }
  });

  r.post('/academic-years/:id/make-current', adminOnly, async (req, res) => {
    const y = await db.tx(async (t) => {
      const target = await t.one('select id from academic_years where id = $1 and tenant_id = $2', [req.params.id, req.tenantId]);
      if (!target) throw notFound('Academic year');
      await t.query(`update academic_years set status = 'closed' where tenant_id = $1 and status = 'active'`, [req.tenantId]);
      return t.one(`update academic_years set status = 'active' where id = $1 returning ${COLS.year}`, [req.params.id]);
    });
    res.json(y);
  });

  // ------------------------------------------------------------- classes
  r.get('/subjects', async (req, res) => res.json(await subjects(db, req.tenantId)));

  r.get('/classes', async (req, res) => {
    const yearId = req.query.yearId ?? (await currentYear(db, req.tenantId))?.id;
    const rows = await db.query(
      `select ${COLS.class},
        (select count(*)::int from enrollments e join students s on s.tenant_id = e.tenant_id and s.id = e.student_id
          where e.class_id = c.id and e.academic_year_id = $2 and e.status <> 'withdrawn' and s.is_active) students
         from classes c where tenant_id = $1 order by grade, name`,
      [req.tenantId, yearId],
    );
    const staff = await db.query(`select id, name, assigned_class_ids from users where tenant_id = $1 and role = 'staff'`, [req.tenantId]);
    res.json(
      rows
        .filter((c) => req.user.role === 'admin' || (c.isActive && canAccessClass(req.user, c.id)))
        .map((c) => ({ ...c, staff: staff.filter((s) => s.assigned_class_ids.includes(c.id)).map((s) => ({ id: s.id, name: s.name })) })),
    );
  });

  const classBody = (b) => ({
    name: str(b, 'name', { max: 40 }),
    grade: int(b, 'grade', { min: 1, max: 12 }),
    sessionLabel: str(b, 'sessionLabel', { optional: true, max: 40 }) ?? '',
    room: str(b, 'room', { optional: true, max: 40 }) ?? '',
    subjectIds: Array.isArray(b.subjectIds) ? b.subjectIds.map(String) : [],
  });

  r.post('/classes', adminOnly, async (req, res) => {
    const c = classBody(req.body ?? {});
    if (!c.subjectIds.length) throw badRequest('Choose at least one subject');
    res.status(201).json(
      await db.one(
        `insert into classes (id, tenant_id, name, grade, session_label, room, subject_ids) values ($1, $2, $3, $4, $5, $6, $7) returning ${COLS.class}`,
        [newId(), req.tenantId, c.name, c.grade, c.sessionLabel, c.room, c.subjectIds],
      ),
    );
  });

  r.patch('/classes/:id', adminOnly, async (req, res) => {
    const existing = await db.one(`select ${COLS.class} from classes where id = $1 and tenant_id = $2`, [req.params.id, req.tenantId]);
    if (!existing) throw notFound('Class');
    const c = classBody({ ...existing, ...req.body });
    const isActive = typeof req.body.isActive === 'boolean' ? req.body.isActive : existing.isActive;
    res.json(
      await db.one(
        `update classes set name = $2, grade = $3, session_label = $4, room = $5, subject_ids = $6, is_active = $7 where id = $1 returning ${COLS.class}`,
        [existing.id, c.name, c.grade, c.sessionLabel, c.room, c.subjectIds.length ? c.subjectIds : existing.subjectIds, isActive],
      ),
    );
  });

  r.put('/classes/:id/staff', adminOnly, async (req, res) => {
    const cls = await db.one('select id from classes where id = $1 and tenant_id = $2', [req.params.id, req.tenantId]);
    if (!cls) throw notFound('Class');
    const ids = Array.isArray(req.body.staffIds) ? req.body.staffIds : [];
    await db.query(
      `update users set assigned_class_ids = array_remove(assigned_class_ids, $2) where tenant_id = $1 and role = 'staff' and not (id = any($3))`,
      [req.tenantId, cls.id, ids],
    );
    await db.query(
      `update users set assigned_class_ids = array_append(assigned_class_ids, $2)
        where tenant_id = $1 and role = 'staff' and id = any($3) and not ($2 = any(assigned_class_ids))`,
      [req.tenantId, cls.id, ids],
    );
    res.json({ ok: true });
  });

  // -------------------------------------------------------- notifications
  r.get('/notifications', async (req, res) => {
    res.json(
      await db.query(
        `select ${COLS.notification} from notifications where tenant_id = $1 and ($2 or not admin_only) order by created_at desc limit 100`,
        [req.tenantId, req.user.role === 'admin'],
      ),
    );
  });
  r.post('/notifications/read-all', async (req, res) => {
    await db.query('update notifications set is_read = true where tenant_id = $1 and ($2 or not admin_only)', [req.tenantId, req.user.role === 'admin']);
    res.json({ ok: true });
  });
  r.post('/notifications/:id/read', async (req, res) => {
    await db.query('update notifications set is_read = true where id = $1 and tenant_id = $2', [req.params.id, req.tenantId]);
    res.json({ ok: true });
  });

  // ------------------------------------------------------------- settings
  r.patch('/tuition', adminOnly, async (req, res) => {
    const cur = await tuition(req.tenantId);
    const b = { ...cur, ...req.body };
    res.json(
      await db.one(
        'update tenants set name = $2, city = $3, address = $4, phone = $5, email = $6 where id = $1 returning id, name, city, address, phone, email',
        [req.tenantId, str(b, 'name', { min: 2, max: 100 }), str(b, 'city', { optional: true, max: 60 }) ?? '',
          str(b, 'address', { optional: true, max: 300 }) ?? '', str(b, 'phone', { optional: true, max: 20 }) ?? '',
          str(b, 'email', { optional: true, max: 120 }) ?? ''],
      ),
    );
  });

  return r;
}
