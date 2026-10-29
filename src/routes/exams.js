import { Router } from 'express';

import { COLS, currentYear, logActivity, newId, notify, roster, subjects, today } from '../data/repo.js';
import { badRequest, notFound } from '../lib/errors.js';
import { date, str } from '../lib/util.js';
import { can, canAccessClass, requireClass, requirePermission } from '../services/access.js';
import { examStatus, marksProgress, resultFor } from '../services/results.js';

export function examRoutes(db) {
  const r = Router();

  const requireExamAccess = (user) => {
    if (!can(user, 'viewExamResults') && !can(user, 'enterMarks')) requirePermission(user, 'viewExamResults');
  };
  async function load(req) {
    const exam = await db.one(`select ${COLS.exam} from exams where id = $1 and tenant_id = $2`, [req.params.id, req.tenantId]);
    if (!exam) throw notFound('Exam');
    requireClass(req.user, exam.classId);
    return exam;
  }
  async function summary(t, e, subs, classes) {
    const students = await roster(db, t, e.classId, e.academicYearId);
    return {
      id: e.id,
      name: e.name,
      classId: e.classId,
      className: classes.find((c) => c.id === e.classId)?.name ?? '',
      academicYearId: e.academicYearId,
      date: e.date,
      subjects: e.subjects.map((s) => ({ ...s, name: subs.find((x) => x.id === s.subjectId)?.name ?? s.subjectId })),
      totalMax: e.subjects.reduce((a, s) => a + s.maxMarks, 0),
      status: examStatus(e, today()),
      resultsPublished: e.resultsPublished,
      revision: e.revision,
      progress: marksProgress(e, students),
    };
  }
  const classesOf = (t) => db.query('select id, name from classes where tenant_id = $1', [t]);

  r.get('/exams', async (req, res) => {
    requireExamAccess(req.user);
    const t = req.tenantId;
    const yearId = req.query.yearId ?? (await currentYear(db, t)).id;
    const [subs, classes] = await Promise.all([subjects(db, t), classesOf(t)]);
    const list = (await db.query(`select ${COLS.exam} from exams where tenant_id = $1 and academic_year_id = $2 order by date desc`, [t, yearId]))
      .filter((e) => canAccessClass(req.user, e.classId))
      .filter((e) => !req.query.classId || e.classId === req.query.classId)
      .filter((e) => !req.query.status || examStatus(e, today()) === req.query.status);
    res.json(await Promise.all(list.map((e) => summary(t, e, subs, classes))));
  });

  r.get('/exams/:id', async (req, res) => {
    requireExamAccess(req.user);
    const t = req.tenantId;
    const exam = await load(req);
    const [subs, classes, students] = await Promise.all([subjects(db, t), classesOf(t), roster(db, t, exam.classId, exam.academicYearId)]);
    const results = students
      .map((s) => ({ name: `${s.firstName} ${s.lastName}`, ...resultFor({ subjects: subs }, exam, s.id) }))
      .sort((a, b) => b.percent - a.percent);
    const scored = results.filter((x) => x.complete && !x.absentInAll);
    const batch = await db.one('select id from message_batches where tenant_id = $1 and source_key = $2', [t, `exam:${exam.id}:r${exam.revision}`]);
    res.json({
      ...(await summary(t, exam, subs, classes)),
      description: exam.description,
      createdBy: exam.createdBy,
      publishedAt: exam.publishedAt,
      correctionLog: exam.correctionLog,
      marks: exam.marks,
      students: students.map((s) => ({ id: s.id, name: `${s.firstName} ${s.lastName}` })),
      results,
      classAverage: scored.length ? Math.round((scored.reduce((a, x) => a + x.percent, 0) / scored.length) * 10) / 10 : null,
      notificationBatchId: batch?.id ?? null,
    });
  });

  async function examBody(req, t) {
    const classId = str(req.body, 'classId');
    requireClass(req.user, classId);
    const subs = await subjects(db, t);
    const list = req.body.subjects;
    if (!Array.isArray(list) || !list.length) throw badRequest('Add at least one subject');
    for (const s of list) {
      if (!subs.some((x) => x.id === s.subjectId)) throw badRequest(`Unknown subject ${s.subjectId}`);
      if (!(Number(s.maxMarks) > 0 && Number(s.maxMarks) <= 1000)) throw badRequest('Maximum marks must be between 1 and 1000');
    }
    return {
      name: str(req.body, 'name', { min: 3, max: 80 }),
      classId,
      date: date(req.body, 'date'),
      subjects: list.map((s) => ({ subjectId: s.subjectId, maxMarks: Number(s.maxMarks) })),
      description: str(req.body, 'description', { optional: true, max: 500 }) ?? '',
      isDraft: req.body.isDraft === true,
    };
  }

  r.post('/exams', async (req, res) => {
    requirePermission(req.user, 'enterMarks');
    const t = req.tenantId;
    const e = await examBody(req, t);
    const yearId = req.body.academicYearId ?? (await currentYear(db, t)).id;
    const exam = await db.one(
      `insert into exams (id, tenant_id, name, academic_year_id, class_id, date, subjects, description, created_by, is_draft)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning ${COLS.exam}`,
      [newId(), t, e.name, yearId, e.classId, e.date, JSON.stringify(e.subjects), e.description, req.user.name, e.isDraft],
    );
    await logActivity(db, t, { type: 'exam', title: e.isDraft ? 'Exam draft created' : 'Exam scheduled', subtitle: e.name });
    res.status(201).json(await summary(t, exam, await subjects(db, t), await classesOf(t)));
  });

  /** Edit exam details (not allowed after results are published). */
  r.patch('/exams/:id', async (req, res) => {
    requirePermission(req.user, 'enterMarks');
    const t = req.tenantId;
    const cur = await load(req);
    if (cur.resultsPublished) throw badRequest('Published exams cannot be edited; correct marks instead');
    req.body = { ...cur, ...req.body };
    const e = await examBody(req, t);
    const keep = new Set(e.subjects.map((s) => s.subjectId));
    const marks = Object.fromEntries(Object.entries(cur.marks).filter(([k]) => keep.has(k)));
    const exam = await db.one(
      `update exams set name = $2, class_id = $3, date = $4, subjects = $5, description = $6, is_draft = $7, marks = $8
        where id = $1 returning ${COLS.exam}`,
      [cur.id, e.name, e.classId, e.date, JSON.stringify(e.subjects), e.description, e.isDraft, marks],
    );
    res.json(await summary(t, exam, await subjects(db, t), await classesOf(t)));
  });

  /**
   * Saves marks for one subject (0..max, or absent as its own state).
   * Changing published marks needs a correction note and bumps the revision so
   * corrected results can be sent once more.
   */
  r.put('/exams/:id/marks/:subjectId', async (req, res) => {
    requirePermission(req.user, 'enterMarks');
    const t = req.tenantId;
    const exam = await load(req);
    const subject = exam.subjects.find((s) => s.subjectId === req.params.subjectId);
    if (!subject) throw notFound('Subject in this exam');
    const ids = new Set((await roster(db, t, exam.classId, exam.academicYearId)).map((s) => s.id));
    const clean = {};
    for (const [studentId, e] of Object.entries(req.body?.entries ?? {})) {
      if (!ids.has(studentId)) throw badRequest(`${studentId} is not in this class`);
      if (e?.absent) { clean[studentId] = { marks: null, absent: true }; continue; }
      if (e?.marks === null || e?.marks === undefined || e?.marks === '') continue;
      const m = Number(e.marks);
      if (!Number.isFinite(m) || m < 0 || m > subject.maxMarks) {
        throw badRequest(`Marks for ${studentId} must be between 0 and ${subject.maxMarks}`, { studentId });
      }
      clean[studentId] = { marks: m, absent: false };
    }
    let revision = exam.revision;
    const log = [...exam.correctionLog];
    if (exam.resultsPublished) {
      const note = str(req.body, 'correctionNote', { min: 3, max: 300 });
      const subs = await subjects(db, t);
      revision += 1;
      log.push(`${new Date().toISOString()} · ${req.user.name} · ${subs.find((s) => s.id === subject.subjectId)?.name}: ${note}`);
    }
    const updated = await db.one(
      `update exams set marks = jsonb_set(marks, $2::text[], $3::jsonb), revision = $4, correction_log = $5 where id = $1 returning ${COLS.exam}`,
      [exam.id, `{${subject.subjectId}}`, clean, revision, JSON.stringify(log)],
    );
    res.json(await summary(t, updated, await subjects(db, t), await classesOf(t)));
  });

  r.post('/exams/:id/publish', async (req, res) => {
    requirePermission(req.user, 'enterMarks');
    const t = req.tenantId;
    const exam = await load(req);
    if (!exam.resultsPublished) {
      const progress = marksProgress(exam, await roster(db, t, exam.classId, exam.academicYearId));
      if (progress.total === 0) throw badRequest('There are no students in this class yet');
      if (progress.entered < progress.total) throw badRequest(`Enter all marks (or mark absent) first: ${progress.entered}/${progress.total} done`);
      await db.query('update exams set results_published = true, is_draft = false, published_at = now() where id = $1', [exam.id]);
      await logActivity(db, t, { type: 'exam', title: 'Results published', subtitle: exam.name });
      await notify(db, t, { type: 'exam', title: `Results published: ${exam.name}`, body: 'Ready to share with parents.' });
    }
    const fresh = await db.one(`select ${COLS.exam} from exams where id = $1`, [exam.id]);
    res.json(await summary(t, fresh, await subjects(db, t), await classesOf(t)));
  });

  return r;
}
