import { Router } from 'express';

import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { isoDate, str } from '../lib/util.js';
import { adminOnly } from '../middleware/auth.js';
import { canAccessClass, canSendMessages, currentYear, fullName, requireClass, requirePermission, roster } from '../services/access.js';
import { batchStats } from '../services/messaging.js';
import { resultFor } from '../services/results.js';
import { summaryFor } from '../services/fees.js';
import { announcementMessage, attendanceMessage, examResultMessage, feeReminderMessage } from '../services/templates.js';

/**
 * Parent messaging. Creating a batch is idempotent on its source (session,
 * published exam revision, announcement draft, daily fee reminder): repeating
 * a request returns the existing batch with `created: false`.
 */
export function messageRoutes(messaging) {
  const r = Router();

  const requireSend = (user) => {
    if (!canSendMessages(user)) throw forbidden('Sending messages is not enabled for your account');
  };
  const visible = (req, b) =>
    req.user.role === 'admin' || (b.category !== 'feeReminder' && b.classIds.some((c) => canAccessClass(req.user, c)));
  const loadBatch = (req) => {
    const b = req.tenant.batches.find((x) => x.id === req.params.id);
    if (!b || !visible(req, b)) throw notFound('Message batch');
    return b;
  };
  const reply = (res, { batch, created }) => res.status(created ? 201 : 200).json({ created, batch: { ...batch, stats: batchStats(batch) } });
  const draft = (s, body) => ({ studentId: s.id, studentName: fullName(s), parentName: s.parentName, phone: s.parentPhone, body });

  r.get('/messages/batches', (req, res) => {
    requirePermission(req.user, 'sendParentMessages');
    res.json(
      req.tenant.batches
        .filter((b) => visible(req, b))
        .filter((b) => !req.query.category || b.category === req.query.category)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map(({ recipients, ...b }) => ({ ...b, stats: batchStats({ recipients }) })),
    );
  });

  r.get('/messages/batches/:id', (req, res) => {
    requirePermission(req.user, 'sendParentMessages');
    const b = loadBatch(req);
    res.json({ ...b, stats: batchStats(b) });
  });

  r.post('/messages/batches/:id/retry', (req, res) => {
    requireSend(req.user);
    const b = loadBatch(req);
    const retried = messaging.retryFailed(req.tenant, b);
    const pending = messaging.processPending(req.tenant, b);
    res.json({ retried, pending, batch: { ...b, stats: batchStats(b) } });
  });

  r.post('/messages/attendance/:sessionId', (req, res) => {
    requireSend(req.user);
    const t = req.tenant;
    const session = t.sessions.find((s) => s.id === req.params.sessionId);
    if (!session) throw notFound('Attendance session');
    requireClass(req.user, session.classId);
    const include = Array.isArray(req.body?.statuses) && req.body.statuses.length ? req.body.statuses : ['absent', 'leave'];
    const exclude = new Set(req.body?.excludeStudentIds ?? []);
    const recipients = Object.entries(session.records)
      .filter(([id, st]) => include.includes(st) && !exclude.has(id))
      .map(([id, st]) => {
        const s = t.students.find((x) => x.id === id);
        return draft(s, attendanceMessage(st, fullName(s), t.tuition.name));
      });
    const cls = t.classes.find((c) => c.id === session.classId);
    reply(res, messaging.createBatch(t, {
      sourceKey: `attendance:${session.id}`,
      title: `${cls.name} attendance · ${session.date}`,
      category: 'attendance',
      classIds: [session.classId],
      createdBy: req.user.name,
      previewBody: attendanceMessage(include.includes('absent') ? 'absent' : 'present', '[Student Name]', t.tuition.name),
      recipients,
    }));
  });

  r.post('/messages/exam-results/:examId', (req, res) => {
    requireSend(req.user);
    const t = req.tenant;
    const exam = t.exams.find((e) => e.id === req.params.examId);
    if (!exam) throw notFound('Exam');
    requireClass(req.user, exam.classId);
    if (!exam.resultsPublished) throw badRequest('Publish results before sending them to parents');
    const only = Array.isArray(req.body?.studentIds) ? new Set(req.body.studentIds) : null;
    const students = roster(t, exam.classId, exam.academicYearId).filter((s) => !only || only.has(s.id));
    const recipients = students.map((s) => draft(s, examResultMessage(exam.name, fullName(s), resultFor(t, exam, s.id), t.tuition.name)));
    reply(res, messaging.createBatch(t, {
      sourceKey: `exam:${exam.id}:r${exam.revision}`,
      title: exam.revision ? `${exam.name} results (corrected)` : `${exam.name} results`,
      category: 'examResults',
      classIds: [exam.classId],
      createdBy: req.user.name,
      previewBody: recipients[0]?.body ?? '',
      recipients,
    }));
  });

  r.post('/messages/announcements', (req, res) => {
    requireSend(req.user);
    const t = req.tenant;
    const draftKey = str(req.body, 'draftKey', { max: 80 });
    const title = str(req.body, 'title', { min: 3, max: 60 });
    const body = str(req.body, 'body', { min: 10, max: 320 });
    const year = currentYear(t);
    const classIds = (Array.isArray(req.body.classIds) && req.body.classIds.length
      ? req.body.classIds
      : t.classes.filter((c) => c.isActive).map((c) => c.id)
    ).filter((id) => canAccessClass(req.user, id));
    if (!classIds.length) throw badRequest('Choose at least one of your classes');
    const only = Array.isArray(req.body.studentIds) ? new Set(req.body.studentIds) : null;
    const message = announcementMessage(title, body, t.tuition.name);
    const recipients = classIds
      .flatMap((c) => roster(t, c, year.id))
      .filter((s) => !only || only.has(s.id))
      .map((s) => draft(s, message));
    if (!recipients.length) throw badRequest('No recipients selected');
    reply(res, messaging.createBatch(t, {
      sourceKey: `announcement:${req.user.id}:${draftKey}`,
      title, category: 'announcement', classIds, createdBy: req.user.name, previewBody: message, recipients,
    }));
  });

  r.post('/messages/fee-reminders', adminOnly, (req, res) => {
    const t = req.tenant;
    const today = isoDate(new Date());
    const year = currentYear(t);
    const recipients = [];
    const classIds = new Set();
    for (const e of t.enrollments.filter((x) => x.academicYearId === year.id && x.status !== 'withdrawn')) {
      const s = t.students.find((x) => x.id === e.studentId);
      const { overdue } = summaryFor(t, e.id, today);
      if (!s.isActive || overdue <= 0) continue;
      classIds.add(e.classId);
      recipients.push(draft(s, feeReminderMessage(fullName(s), overdue, t.tuition.name)));
    }
    if (!recipients.length) throw badRequest('No overdue balances right now');
    reply(res, messaging.createBatch(t, {
      sourceKey: `fees:reminder:${today}`,
      title: `Fee reminder · ${today}`, category: 'feeReminder', classIds: [...classIds], createdBy: req.user.name,
      previewBody: feeReminderMessage('[Student Name]', 2000, t.tuition.name), recipients,
    }));
  });

  r.get('/messages/sms-settings', adminOnly, (req, res) => res.json({ ...req.tenant.sms, note: 'Mock values — no SMS provider is connected.' }));

  return r;
}
