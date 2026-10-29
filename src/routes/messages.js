import { Router } from 'express';

import { COLS, currentYear, feeContext, roster, subjects, today } from '../data/repo.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { str } from '../lib/util.js';
import { adminOnly } from '../middleware/auth.js';
import { canAccessClass, canSendMessages, requireClass, requirePermission } from '../services/access.js';
import { summaryFor } from '../services/fees.js';
import { batchStats } from '../services/messaging.js';
import { resultFor } from '../services/results.js';
import { announcementMessage, attendanceMessage, examResultMessage, feeReminderMessage } from '../services/templates.js';

/**
 * Parent messaging. Batch creation is idempotent per source (session,
 * published exam revision, announcement draft, daily fee reminder): repeating a
 * request returns the existing batch with `created: false`. Messages are sent
 * by the tenant's chosen transport (see services/messaging.js).
 */
export function messageRoutes(db, messaging) {
  const r = Router();
  const requireSend = (user) => {
    if (!canSendMessages(user)) throw forbidden('Sending messages is not enabled for your account');
  };
  const visible = (req, b) =>
    req.user.role === 'admin' || (b.category !== 'feeReminder' && b.classIds.some((c) => canAccessClass(req.user, c)));

  async function fullBatch(req, id) {
    const b = await db.one(`select ${COLS.batch} from message_batches where id = $1 and tenant_id = $2`, [id, req.tenantId]);
    if (!b || !visible(req, b)) throw notFound('Message batch');
    const recipients = await db.query(`select ${COLS.recipient} from message_recipients where batch_id = $1 order by position`, [b.id]);
    return { ...b, recipients, stats: batchStats(recipients) };
  }
  async function reply(req, res, { created, batchId }) {
    res.status(created ? 201 : 200).json({ created, batch: await fullBatch(req, batchId) });
  }
  const draft = (s, body) => ({ studentId: s.id, studentName: `${s.firstName} ${s.lastName}`, parentName: s.parentName, phone: s.parentPhone, body });
  const tuitionName = async (t) => (await db.one('select name from tenants where id = $1', [t])).name;

  r.get('/messages/batches', async (req, res) => {
    requirePermission(req.user, 'sendParentMessages');
    const batches = (await db.query(`select ${COLS.batch} from message_batches where tenant_id = $1 order by created_at desc limit 100`, [req.tenantId]))
      .filter((b) => visible(req, b))
      .filter((b) => !req.query.category || b.category === req.query.category);
    const statuses = batches.length
      ? await db.query('select batch_id, status from message_recipients where batch_id = any($1)', [batches.map((b) => b.id)])
      : [];
    res.json(batches.map((b) => ({ ...b, stats: batchStats(statuses.filter((s) => s.batch_id === b.id)) })));
  });

  r.get('/messages/batches/:id', async (req, res) => {
    requirePermission(req.user, 'sendParentMessages');
    res.json(await fullBatch(req, req.params.id));
  });

  r.post('/messages/batches/:id/retry', async (req, res) => {
    requireSend(req.user);
    await fullBatch(req, req.params.id); // access check
    const result = await messaging.retry(req.tenantId, req.params.id);
    res.json({ ...result, batch: await fullBatch(req, req.params.id) });
  });

  r.post('/messages/attendance/:sessionId', async (req, res) => {
    requireSend(req.user);
    const t = req.tenantId;
    const session = await db.one(`select ${COLS.session} from attendance_sessions where id = $1 and tenant_id = $2`, [req.params.sessionId, t]);
    if (!session) throw notFound('Attendance session');
    requireClass(req.user, session.classId);
    const include = Array.isArray(req.body?.statuses) && req.body.statuses.length ? req.body.statuses : ['absent', 'leave'];
    const exclude = new Set(req.body?.excludeStudentIds ?? []);
    const ids = Object.keys(session.records).filter((id) => include.includes(session.records[id]) && !exclude.has(id));
    const studentRows = ids.length
      ? await db.query(`select ${COLS.student} from students where tenant_id = $1 and id = any($2) order by first_name`, [t, ids])
      : [];
    const name = await tuitionName(t);
    const cls = await db.one('select name from classes where id = $1', [session.classId]);
    await reply(req, res, await messaging.createBatch(t, {
      sourceKey: `attendance:${session.id}`,
      title: `${cls.name} attendance · ${session.date}`,
      category: 'attendance',
      classIds: [session.classId],
      createdBy: req.user.name,
      previewBody: attendanceMessage(include.includes('absent') ? 'absent' : 'present', '[Student Name]', name),
      recipients: studentRows.map((s) => draft(s, attendanceMessage(session.records[s.id], `${s.firstName} ${s.lastName}`, name))),
    }));
  });

  r.post('/messages/exam-results/:examId', async (req, res) => {
    requireSend(req.user);
    const t = req.tenantId;
    const exam = await db.one(`select ${COLS.exam} from exams where id = $1 and tenant_id = $2`, [req.params.examId, t]);
    if (!exam) throw notFound('Exam');
    requireClass(req.user, exam.classId);
    if (!exam.resultsPublished) throw badRequest('Publish results before sending them to parents');
    const only = Array.isArray(req.body?.studentIds) ? new Set(req.body.studentIds) : null;
    const [subs, name] = await Promise.all([subjects(db, t), tuitionName(t)]);
    const list = (await roster(db, t, exam.classId, exam.academicYearId)).filter((s) => !only || only.has(s.id));
    const recipients = list.map((s) => draft(s, examResultMessage(exam.name, `${s.firstName} ${s.lastName}`, resultFor({ subjects: subs }, exam, s.id), name)));
    if (!recipients.length) throw badRequest('No recipients selected');
    await reply(req, res, await messaging.createBatch(t, {
      sourceKey: `exam:${exam.id}:r${exam.revision}`,
      title: exam.revision ? `${exam.name} results (corrected)` : `${exam.name} results`,
      category: 'examResults',
      classIds: [exam.classId],
      createdBy: req.user.name,
      previewBody: recipients[0].body,
      recipients,
    }));
  });

  r.post('/messages/announcements', async (req, res) => {
    requireSend(req.user);
    const t = req.tenantId;
    const draftKey = str(req.body, 'draftKey', { max: 80 });
    const title = str(req.body, 'title', { min: 3, max: 60 });
    const body = str(req.body, 'body', { min: 10, max: 320 });
    const year = await currentYear(db, t);
    const all = await db.query('select id from classes where tenant_id = $1 and is_active', [t]);
    const classIds = (Array.isArray(req.body.classIds) && req.body.classIds.length ? req.body.classIds : all.map((c) => c.id))
      .filter((id) => all.some((c) => c.id === id) && canAccessClass(req.user, id));
    if (!classIds.length) throw badRequest('Choose at least one of your classes');
    const only = Array.isArray(req.body.studentIds) ? new Set(req.body.studentIds) : null;
    const message = announcementMessage(title, body, await tuitionName(t));
    const recipients = [];
    for (const c of classIds) for (const s of await roster(db, t, c, year.id)) if (!only || only.has(s.id)) recipients.push(draft(s, message));
    if (!recipients.length) throw badRequest('No parents to message in the selected classes');
    await reply(req, res, await messaging.createBatch(t, {
      sourceKey: `announcement:${req.user.id}:${draftKey}`,
      title, category: 'announcement', classIds, createdBy: req.user.name, previewBody: message, recipients,
    }));
  });

  r.post('/messages/fee-reminders', adminOnly, async (req, res) => {
    const t = req.tenantId;
    const d = today();
    const year = await currentYear(db, t);
    const rows = await db.query(
      `select e.id eid, e.class_id, ${COLS.student.replace(/(^|,\s*)(\w+)/g, '$1s.$2')}
         from enrollments e join students s on s.tenant_id = e.tenant_id and s.id = e.student_id
        where e.tenant_id = $1 and e.academic_year_id = $2 and e.status <> 'withdrawn' and s.is_active`,
      [t, year.id],
    );
    const ctx = await feeContext(db, t, rows.map((x) => x.eid));
    const name = await tuitionName(t);
    const due = rows.map((x) => ({ ...x, overdue: summaryFor(ctx, x.eid, d).overdue })).filter((x) => x.overdue > 0);
    if (!due.length) throw badRequest('No overdue balances right now');
    await reply(req, res, await messaging.createBatch(t, {
      sourceKey: `fees:reminder:${d}`,
      title: `Fee reminder · ${d}`,
      category: 'feeReminder',
      classIds: [...new Set(due.map((x) => x.class_id))],
      createdBy: req.user.name,
      previewBody: feeReminderMessage('[Student Name]', 2000, name),
      recipients: due.map((x) => draft(x, feeReminderMessage(`${x.firstName} ${x.lastName}`, x.overdue, name))),
    }));
  });

  const smsSettings = async (t) => {
    const { sms } = await db.one('select sms from tenants where id = $1', [t]);
    const [{ waiting }] = await db.query(`select count(*)::int waiting from message_recipients where tenant_id = $1 and status = 'queued'`, [t]);
    return { ...sms, simulated: sms.mode !== 'device', waiting };
  };

  r.get('/messages/sms-settings', adminOnly, async (req, res) => {
    res.json(await smsSettings(req.tenantId));
  });

  /** Admin picks the transport: 'device' (a phone's SIM) or 'simulated'. */
  r.put('/messages/sms-settings', adminOnly, async (req, res) => {
    const mode = req.body?.mode;
    if (mode !== 'device' && mode !== 'simulated') throw badRequest('mode must be "device" or "simulated"');
    const deviceName = mode === 'device' ? str(req.body, 'deviceName', { max: 60 }) : '';
    await db.query(`update tenants set sms = sms || jsonb_build_object('mode', $2::text, 'deviceName', $3::text) where id = $1`, [req.tenantId, mode, deviceName]);
    if (mode === 'simulated') await messaging.flushQueued(req.tenantId);
    res.json(await smsSettings(req.tenantId));
  });

  /** Sending phone: take the next queued messages to send from its SIM. */
  r.post('/sms-device/claim', adminOnly, async (req, res) => {
    const { sms } = await db.one('select sms from tenants where id = $1', [req.tenantId]);
    if (sms.mode !== 'device') return res.json({ active: false, messages: [] });
    const limit = Math.min(Math.max(Number(req.body?.limit) || 5, 1), 20);
    const messages = await messaging.claim(req.tenantId, { limit, deviceName: str(req.body, 'deviceName', { max: 60 }) });
    res.json({ active: true, messages });
  });

  r.post('/sms-device/report', adminOnly, async (req, res) => {
    const status = req.body?.status;
    if (!['sent', 'failed', 'delivered'].includes(status)) throw badRequest('status must be sent, failed or delivered');
    const ok = await messaging.report(req.tenantId, {
      id: str(req.body, 'id', { max: 80 }),
      status,
      reason: typeof req.body?.reason === 'string' ? req.body.reason.slice(0, 200) : null,
    });
    res.json({ ok });
  });

  return r;
}
