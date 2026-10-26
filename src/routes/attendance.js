import { Router } from 'express';

import { badRequest, conflict, notFound } from '../lib/errors.js';
import { isoDate, str } from '../lib/util.js';
import { adminOnly } from '../middleware/auth.js';
import { canAccessClass, currentYear, fullName, requireClass, requirePermission, roster } from '../services/access.js';

const STATUSES = ['present', 'absent', 'late', 'leave'];

export function attendanceRoutes() {
  const r = Router();
  const sessionId = (classId, d) => `att-${classId}-${d.replaceAll('-', '')}`;

  function serialize(t, s) {
    const cls = t.classes.find((c) => c.id === s.classId);
    const counts = Object.fromEntries(STATUSES.map((k) => [k, 0]));
    for (const v of Object.values(s.records)) counts[v]++;
    return {
      ...s,
      className: cls?.name,
      counts,
      total: Object.keys(s.records).length,
      locked: true,
      students: Object.entries(s.records)
        .map(([id, status]) => {
          const st = t.students.find((x) => x.id === id);
          return { id, name: st ? fullName(st) : id, status };
        })
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  }

  r.get('/attendance/today', (req, res) => {
    const t = req.tenant;
    const today = isoDate(new Date());
    const year = currentYear(t);
    res.json({
      date: today,
      yearLabel: year.label,
      classes: t.classes
        .filter((c) => c.isActive && canAccessClass(req.user, c.id))
        .sort((a, b) => a.grade - b.grade)
        .map((c) => {
          const s = t.sessions.find((x) => x.id === sessionId(c.id, today));
          return {
            classId: c.id,
            className: c.name,
            sessionLabel: c.sessionLabel,
            students: roster(t, c.id, year.id).length,
            session: s ? { id: s.id, markedBy: s.markedBy, markedAt: s.markedAt, counts: serialize(t, s).counts } : null,
          };
        }),
    });
  });

  r.get('/attendance/classes/:classId/roster', (req, res) => {
    const t = req.tenant;
    requireClass(req.user, req.params.classId);
    const today = isoDate(new Date());
    const existing = t.sessions.find((x) => x.id === sessionId(req.params.classId, today));
    res.json({
      date: today,
      existingSessionId: existing?.id ?? null,
      students: roster(t, req.params.classId, currentYear(t).id).map((s) => ({ id: s.id, name: fullName(s) })),
    });
  });

  r.get('/attendance/sessions/:id', (req, res) => {
    const t = req.tenant;
    const s = t.sessions.find((x) => x.id === req.params.id);
    if (!s) throw notFound('Attendance session');
    requireClass(req.user, s.classId);
    const batch = t.batches.find((b) => b.sourceKey === `attendance:${s.id}`);
    res.json({ ...serialize(t, s), notificationBatchId: batch?.id ?? null });
  });

  /**
   * Saves today's session for a class. The session id is derived from class
   * and date, so a second submission — from any user — gets 409 with the
   * saved session instead of creating a duplicate.
   */
  r.post('/attendance/sessions', (req, res) => {
    const t = req.tenant;
    requirePermission(req.user, 'markAttendance');
    const classId = str(req.body, 'classId');
    requireClass(req.user, classId);
    const today = isoDate(new Date());
    const id = sessionId(classId, today);
    const existing = t.sessions.find((x) => x.id === id);
    if (existing) throw conflict(`Attendance was already saved by ${existing.markedBy}`, { session: serialize(t, existing) });

    const records = req.body.records ?? {};
    const expected = roster(t, classId, currentYear(t).id);
    const missing = expected.filter((s) => !STATUSES.includes(records[s.id]));
    if (missing.length) throw badRequest(`${missing.length} students have no valid status`, { missing: missing.map((s) => s.id) });

    const session = {
      id, classId, academicYearId: currentYear(t).id, date: today,
      records: Object.fromEntries(expected.map((s) => [s.id, records[s.id]])),
      markedBy: req.user.name, markedAt: new Date().toISOString(), audit: [],
    };
    t.sessions.push(session);
    const cls = t.classes.find((c) => c.id === classId);
    t.activity.push({ type: 'attendance', title: `Attendance marked for ${cls.name}`, subtitle: req.user.name, at: session.markedAt, adminOnly: false });
    res.status(201).json(serialize(t, session));
  });

  /** Admin-only correction of a locked session, with a required audit note. */
  r.patch('/attendance/sessions/:id', adminOnly, (req, res) => {
    const t = req.tenant;
    const s = t.sessions.find((x) => x.id === req.params.id);
    if (!s) throw notFound('Attendance session');
    const note = str(req.body, 'note', { min: 3, max: 300 });
    const updates = req.body.records ?? {};
    let changed = 0;
    for (const [studentId, status] of Object.entries(updates)) {
      if (!(studentId in s.records)) throw badRequest(`${studentId} is not in this session`);
      if (!STATUSES.includes(status)) throw badRequest(`Invalid status for ${studentId}`);
      if (s.records[studentId] !== status) changed++;
      s.records[studentId] = status;
    }
    s.audit.push({ at: new Date().toISOString(), by: req.user.name, note: `${note} (${changed} record${changed === 1 ? '' : 's'} changed)` });
    res.json(serialize(t, s));
  });

  return r;
}
