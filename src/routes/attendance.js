import { Router } from 'express';

import { COLS, currentYear, logActivity, newId, notify, roster, today } from '../data/repo.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { str } from '../lib/util.js';
import { adminOnly } from '../middleware/auth.js';
import { canAccessClass, requireClass, requirePermission } from '../services/access.js';

const STATUSES = ['present', 'absent', 'late', 'leave'];

export function attendanceRoutes(db) {
  const r = Router();

  async function serialize(tenantId, s) {
    const cls = await db.one('select name from classes where id = $1', [s.classId]);
    const ids = Object.keys(s.records);
    const names = ids.length
      ? await db.query(`select id, first_name || ' ' || last_name name from students where tenant_id = $1 and id = any($2)`, [tenantId, ids])
      : [];
    const counts = Object.fromEntries(STATUSES.map((k) => [k, 0]));
    for (const v of Object.values(s.records)) counts[v]++;
    return {
      ...s,
      className: cls?.name,
      counts,
      total: ids.length,
      locked: true,
      students: ids
        .map((id) => ({ id, name: names.find((n) => n.id === id)?.name ?? id, status: s.records[id] }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  }

  r.get('/attendance/today', async (req, res) => {
    const t = req.tenantId;
    const d = today();
    const year = await currentYear(db, t);
    const classes = (await db.query(`select ${COLS.class} from classes where tenant_id = $1 and is_active order by grade, name`, [t]))
      .filter((c) => canAccessClass(req.user, c.id));
    const sessions = await db.query(`select ${COLS.session} from attendance_sessions where tenant_id = $1 and date = $2`, [t, d]);
    const out = [];
    for (const c of classes) {
      const s = sessions.find((x) => x.classId === c.id);
      const counts = Object.fromEntries(STATUSES.map((k) => [k, 0]));
      if (s) for (const v of Object.values(s.records)) counts[v]++;
      out.push({
        classId: c.id,
        className: c.name,
        sessionLabel: c.sessionLabel,
        students: (await roster(db, t, c.id, year.id)).length,
        session: s ? { id: s.id, markedBy: s.markedBy, markedAt: s.markedAt, counts } : null,
      });
    }
    res.json({ date: d, yearLabel: year.label, classes: out });
  });

  r.get('/attendance/classes/:classId/roster', async (req, res) => {
    const t = req.tenantId;
    requireClass(req.user, req.params.classId);
    const year = await currentYear(db, t);
    const existing = await db.one('select id from attendance_sessions where tenant_id = $1 and class_id = $2 and date = $3', [t, req.params.classId, today()]);
    res.json({
      date: today(),
      existingSessionId: existing?.id ?? null,
      students: (await roster(db, t, req.params.classId, year.id)).map((s) => ({ id: s.id, name: `${s.firstName} ${s.lastName}` })),
    });
  });

  r.get('/attendance/sessions/:id', async (req, res) => {
    const t = req.tenantId;
    const s = await db.one(`select ${COLS.session} from attendance_sessions where id = $1 and tenant_id = $2`, [req.params.id, t]);
    if (!s) throw notFound('Attendance session');
    requireClass(req.user, s.classId);
    const batch = await db.one('select id from message_batches where tenant_id = $1 and source_key = $2', [t, `attendance:${s.id}`]);
    res.json({ ...(await serialize(t, s)), notificationBatchId: batch?.id ?? null });
  });

  /**
   * Saves today's attendance for a class. The unique (tenant, class, date)
   * constraint means a second submission — from anyone, even at the same
   * instant — gets 409 with the saved session instead of a duplicate.
   */
  r.post('/attendance/sessions', async (req, res) => {
    const t = req.tenantId;
    requirePermission(req.user, 'markAttendance');
    const classId = str(req.body, 'classId');
    requireClass(req.user, classId);
    const year = await currentYear(db, t);
    const expected = await roster(db, t, classId, year.id);
    const records = req.body.records ?? {};
    const missing = expected.filter((s) => !STATUSES.includes(records[s.id]));
    if (missing.length) throw badRequest(`${missing.length} students have no valid status`, { missing: missing.map((s) => s.id) });
    const clean = Object.fromEntries(expected.map((s) => [s.id, records[s.id]]));
    const saved = await db.one(
      `insert into attendance_sessions (id, tenant_id, class_id, academic_year_id, date, records, marked_by)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (tenant_id, class_id, date) do nothing
       returning ${COLS.session}`,
      [newId(), t, classId, year.id, today(), clean, req.user.name],
    );
    if (!saved) {
      const existing = await db.one(`select ${COLS.session} from attendance_sessions where tenant_id = $1 and class_id = $2 and date = $3`, [t, classId, today()]);
      throw conflict(`Attendance was already saved by ${existing.markedBy}`, { session: await serialize(t, existing) });
    }
    const cls = await db.one('select name from classes where id = $1', [classId]);
    await logActivity(db, t, { type: 'attendance', title: `Attendance marked for ${cls.name}`, subtitle: req.user.name });
    await notify(db, t, { type: 'attendance', title: `Attendance marked for ${cls.name}`, body: `${req.user.name} saved today's session.` });
    res.status(201).json(await serialize(t, saved));
  });

  /** Admin-only correction of a locked session, with a required audit note. */
  r.patch('/attendance/sessions/:id', adminOnly, async (req, res) => {
    const t = req.tenantId;
    const s = await db.one(`select ${COLS.session} from attendance_sessions where id = $1 and tenant_id = $2`, [req.params.id, t]);
    if (!s) throw notFound('Attendance session');
    const note = str(req.body, 'note', { min: 3, max: 300 });
    let changed = 0;
    for (const [studentId, status] of Object.entries(req.body.records ?? {})) {
      if (!(studentId in s.records)) throw badRequest(`${studentId} is not in this session`);
      if (!STATUSES.includes(status)) throw badRequest(`Invalid status for ${studentId}`);
      if (s.records[studentId] !== status) changed++;
      s.records[studentId] = status;
    }
    const audit = [...s.audit, { at: new Date().toISOString(), by: req.user.name, note: `${note} (${changed} record${changed === 1 ? '' : 's'} changed)` }];
    const updated = await db.one(
      `update attendance_sessions set records = $2, audit = $3 where id = $1 returning ${COLS.session}`,
      [s.id, s.records, JSON.stringify(audit)],
    );
    res.json(await serialize(t, updated));
  });

  return r;
}
