import { Router } from 'express';

import { nextId } from '../data/store.js';
import { badRequest, notFound } from '../lib/errors.js';
import { date, int, isoDate, str } from '../lib/util.js';
import { adminOnly } from '../middleware/auth.js';
import { canAccessClass, canSendMessages, currentYear, roster } from '../services/access.js';
import { addSummaries, summaryFor } from '../services/fees.js';
import { examStatus } from '../services/results.js';

/** Profile, dashboard, academic years, classes, subjects, notifications. */
export function coreRoutes() {
  const r = Router();

  r.get('/me', (req, res) => {
    const t = req.tenant;
    const u = req.user;
    const member = u.role === 'staff' ? t.staff.find((s) => s.id === u.id) : null;
    res.json({
      role: u.role,
      id: u.id,
      name: u.name,
      email: member?.email ?? t.admin.email,
      phone: member?.phone ?? t.admin.phone,
      designation: member?.designation ?? 'Owner · Admin',
      permissions: u.role === 'admin' ? 'all' : u.permissions,
      assignedClassIds: u.role === 'admin' ? t.classes.filter((c) => c.isActive).map((c) => c.id) : u.assignedClassIds,
      canSeeFinance: u.role === 'admin',
      canSendMessages: canSendMessages(u),
      tuition: t.tuition,
      currentYearId: currentYear(t).id,
    });
  });

  r.get('/dashboard', (req, res) => {
    const t = req.tenant;
    const u = req.user;
    const today = isoDate(new Date());
    const year = currentYear(t);
    const classes = t.classes.filter((c) => c.isActive && canAccessClass(u, c.id));
    let present = 0, absent = 0, lateOrLeave = 0, notMarked = 0, marked = 0, students = 0;
    const classRows = classes.map((c) => {
      const count = roster(t, c.id, year.id).length;
      students += count;
      const s = t.sessions.find((x) => x.classId === c.id && x.date === today);
      if (!s) notMarked += count;
      else {
        marked++;
        for (const v of Object.values(s.records)) {
          if (v === 'present' || v === 'late') present++;
          if (v === 'absent') absent++;
          if (v === 'late' || v === 'leave') lateOrLeave++;
        }
      }
      return { id: c.id, name: c.name, sessionLabel: c.sessionLabel, students: count, marked: !!s };
    });
    const exams = t.exams.filter((e) => canAccessClass(u, e.classId));
    const upcoming = exams
      .filter((e) => examStatus(e, today) === 'upcoming')
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((e) => ({ id: e.id, name: e.name, date: e.date, className: t.classes.find((c) => c.id === e.classId).name }));

    const body = {
      yearLabel: year.label,
      students,
      classes: classRows,
      attendance: { classesMarked: marked, classesTotal: classes.length, present, absent, lateOrLeave, notMarked },
      upcomingExams: upcoming,
      resultsPending: exams.filter((e) => examStatus(e, today) === 'completed').length,
      activity: t.activity
        .filter((a) => u.role === 'admin' || !a.adminOnly)
        .sort((a, b) => b.at.localeCompare(a.at))
        .slice(0, 6),
      events: t.events.filter((e) => e.date >= today),
    };
    // Financial figures are only ever computed for the admin.
    if (u.role === 'admin') {
      body.fees = addSummaries(
        t.enrollments.filter((e) => e.academicYearId === year.id).map((e) => summaryFor(t, e.id, today)),
      );
    }
    res.json(body);
  });

  // ------------------------------------------------------- academic years
  r.get('/academic-years', (req, res) => {
    const t = req.tenant;
    res.json(
      [...t.years]
        .sort((a, b) => b.startDate.localeCompare(a.startDate))
        .map((y) => ({ ...y, enrollments: t.enrollments.filter((e) => e.academicYearId === y.id).length })),
    );
  });

  r.post('/academic-years', adminOnly, (req, res) => {
    const t = req.tenant;
    const label = str(req.body, 'label', { max: 20 });
    const startDate = date(req.body, 'startDate');
    const endDate = date(req.body, 'endDate');
    if (endDate <= startDate) throw badRequest('endDate must be after startDate');
    if (t.years.some((y) => y.label === label)) throw badRequest('This academic year already exists');
    const year = { id: nextId(t, 'year', 'ay-new'), label, startDate, endDate, status: 'upcoming' };
    t.years.push(year);
    res.status(201).json(year);
  });

  r.post('/academic-years/:id/make-current', adminOnly, (req, res) => {
    const t = req.tenant;
    const year = t.years.find((y) => y.id === req.params.id);
    if (!year) throw notFound('Academic year');
    for (const y of t.years) if (y.status === 'active') y.status = 'closed';
    year.status = 'active';
    res.json(year);
  });

  // -------------------------------------------------------------- classes
  r.get('/subjects', (req, res) => res.json(req.tenant.subjects));

  r.get('/classes', (req, res) => {
    const t = req.tenant;
    const yearId = req.query.yearId ?? currentYear(t).id;
    res.json(
      [...t.classes]
        .filter((c) => req.user.role === 'admin' || (c.isActive && canAccessClass(req.user, c.id)))
        .sort((a, b) => a.grade - b.grade)
        .map((c) => ({
          ...c,
          students: roster(t, c.id, yearId).length,
          staff: t.staff.filter((s) => s.assignedClassIds.includes(c.id)).map((s) => ({ id: s.id, name: s.name })),
        })),
    );
  });

  const classBody = (body) => ({
    name: str(body, 'name', { max: 40 }),
    grade: int(body, 'grade', { min: 1, max: 12 }),
    sessionLabel: str(body, 'sessionLabel', { max: 40 }),
    room: str(body, 'room', { optional: true, max: 40 }) ?? '',
    subjectIds: Array.isArray(body.subjectIds) && body.subjectIds.length ? body.subjectIds : null,
  });

  r.post('/classes', adminOnly, (req, res) => {
    const t = req.tenant;
    const data = classBody(req.body);
    if (!data.subjectIds) throw badRequest('Choose at least one subject');
    const cls = { id: nextId(t, 'class', 'cls-new'), ...data, isActive: true };
    t.classes.push(cls);
    res.status(201).json(cls);
  });

  r.patch('/classes/:id', adminOnly, (req, res) => {
    const cls = req.tenant.classes.find((c) => c.id === req.params.id);
    if (!cls) throw notFound('Class');
    const data = classBody({ ...cls, ...req.body });
    Object.assign(cls, data, { subjectIds: data.subjectIds ?? cls.subjectIds });
    if (typeof req.body.isActive === 'boolean') cls.isActive = req.body.isActive;
    res.json(cls);
  });

  r.put('/classes/:id/staff', adminOnly, (req, res) => {
    const t = req.tenant;
    const cls = t.classes.find((c) => c.id === req.params.id);
    if (!cls) throw notFound('Class');
    const ids = new Set(Array.isArray(req.body.staffIds) ? req.body.staffIds : []);
    for (const s of t.staff) {
      const has = s.assignedClassIds.includes(cls.id);
      if (ids.has(s.id) && !has) s.assignedClassIds.push(cls.id);
      if (!ids.has(s.id) && has) s.assignedClassIds = s.assignedClassIds.filter((c) => c !== cls.id);
    }
    res.json({ ok: true });
  });

  // -------------------------------------------------------- notifications
  const visible = (req) =>
    req.tenant.notifications
      .filter((n) => req.user.role === 'admin' || !n.adminOnly)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  r.get('/notifications', (req, res) => res.json(visible(req)));

  r.post('/notifications/read-all', (req, res) => {
    for (const n of visible(req)) n.isRead = true;
    res.json({ ok: true });
  });

  r.post('/notifications/:id/read', (req, res) => {
    const n = visible(req).find((x) => x.id === req.params.id);
    if (!n) throw notFound('Notification');
    n.isRead = true;
    res.json(n);
  });

  return r;
}
