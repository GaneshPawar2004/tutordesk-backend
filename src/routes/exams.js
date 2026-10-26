import { Router } from 'express';

import { nextId } from '../data/store.js';
import { badRequest, notFound } from '../lib/errors.js';
import { date, isoDate, str } from '../lib/util.js';
import { can, canAccessClass, currentYear, fullName, requireClass, requirePermission, roster } from '../services/access.js';
import { examStatus, marksProgress, resultFor } from '../services/results.js';

export function examRoutes() {
  const r = Router();
  const today = () => isoDate(new Date());

  const loadExam = (req) => {
    const exam = req.tenant.exams.find((e) => e.id === req.params.id);
    if (!exam) throw notFound('Exam');
    requireClass(req.user, exam.classId);
    return exam;
  };
  const requireExamAccess = (user) => {
    if (!can(user, 'viewExamResults') && !can(user, 'enterMarks')) requirePermission(user, 'viewExamResults');
  };

  const summary = (t, e) => ({
    id: e.id,
    name: e.name,
    classId: e.classId,
    className: t.classes.find((c) => c.id === e.classId).name,
    academicYearId: e.academicYearId,
    date: e.date,
    subjects: e.subjects.map((s) => ({ ...s, name: t.subjects.find((x) => x.id === s.subjectId).name })),
    totalMax: e.subjects.reduce((a, s) => a + s.maxMarks, 0),
    status: examStatus(e, today()),
    resultsPublished: e.resultsPublished,
    revision: e.revision,
    progress: marksProgress(e, roster(t, e.classId, e.academicYearId)),
  });

  r.get('/exams', (req, res) => {
    requireExamAccess(req.user);
    const t = req.tenant;
    const yearId = req.query.yearId ?? currentYear(t).id;
    res.json(
      t.exams
        .filter((e) => e.academicYearId === yearId && canAccessClass(req.user, e.classId))
        .filter((e) => !req.query.classId || e.classId === req.query.classId)
        .filter((e) => !req.query.status || examStatus(e, today()) === req.query.status)
        .sort((a, b) => b.date.localeCompare(a.date))
        .map((e) => summary(t, e)),
    );
  });

  r.get('/exams/:id', (req, res) => {
    requireExamAccess(req.user);
    const t = req.tenant;
    const exam = loadExam(req);
    const students = roster(t, exam.classId, exam.academicYearId);
    const results = students
      .map((s) => ({ name: fullName(s), ...resultFor(t, exam, s.id) }))
      .sort((a, b) => b.percent - a.percent);
    const scored = results.filter((x) => x.complete && !x.absentInAll);
    res.json({
      ...summary(t, exam),
      description: exam.description,
      createdBy: exam.createdBy,
      publishedAt: exam.publishedAt,
      correctionLog: exam.correctionLog,
      marks: exam.marks,
      students: students.map((s) => ({ id: s.id, name: fullName(s) })),
      results,
      classAverage: scored.length ? Math.round((scored.reduce((a, x) => a + x.percent, 0) / scored.length) * 10) / 10 : null,
      notificationBatchId: t.batches.find((b) => b.sourceKey === `exam:${exam.id}:r${exam.revision}`)?.id ?? null,
    });
  });

  r.post('/exams', (req, res) => {
    requirePermission(req.user, 'enterMarks');
    const t = req.tenant;
    const classId = str(req.body, 'classId');
    requireClass(req.user, classId);
    const subjects = req.body.subjects;
    if (!Array.isArray(subjects) || !subjects.length) throw badRequest('Add at least one subject');
    for (const s of subjects) {
      if (!t.subjects.some((x) => x.id === s.subjectId)) throw badRequest(`Unknown subject ${s.subjectId}`);
      if (!(Number(s.maxMarks) > 0 && Number(s.maxMarks) <= 1000)) throw badRequest('Maximum marks must be between 1 and 1000');
    }
    const exam = {
      id: nextId(t, 'exam', 'exm'),
      name: str(req.body, 'name', { min: 3, max: 80 }),
      academicYearId: req.body.academicYearId ?? currentYear(t).id,
      classId,
      date: date(req.body, 'date'),
      subjects: subjects.map((s) => ({ subjectId: s.subjectId, maxMarks: Number(s.maxMarks) })),
      description: str(req.body, 'description', { optional: true, max: 500 }) ?? '',
      createdBy: req.user.name,
      isDraft: req.body.isDraft === true,
      resultsPublished: false,
      publishedAt: null,
      revision: 0,
      correctionLog: [],
      marks: {},
    };
    t.exams.push(exam);
    res.status(201).json(summary(t, exam));
  });

  /**
   * Saves marks for one subject. Marks must be 0..max; absent is stored as
   * its own state. Changing published marks requires a correction note and
   * bumps the revision so corrected results can be sent once.
   */
  r.put('/exams/:id/marks/:subjectId', (req, res) => {
    requirePermission(req.user, 'enterMarks');
    const t = req.tenant;
    const exam = loadExam(req);
    const subject = exam.subjects.find((s) => s.subjectId === req.params.subjectId);
    if (!subject) throw notFound('Subject in this exam');
    const entries = req.body?.entries ?? {};
    const students = new Set(roster(t, exam.classId, exam.academicYearId).map((s) => s.id));
    const clean = {};
    for (const [studentId, e] of Object.entries(entries)) {
      if (!students.has(studentId)) throw badRequest(`${studentId} is not in this class`);
      if (e?.absent) { clean[studentId] = { marks: null, absent: true }; continue; }
      if (e?.marks === null || e?.marks === undefined || e?.marks === '') continue;
      const m = Number(e.marks);
      if (!Number.isFinite(m) || m < 0 || m > subject.maxMarks) {
        throw badRequest(`Marks for ${studentId} must be between 0 and ${subject.maxMarks}`, { studentId });
      }
      clean[studentId] = { marks: m, absent: false };
    }
    if (exam.resultsPublished) {
      const note = str(req.body, 'correctionNote', { min: 3, max: 300 });
      exam.revision += 1;
      exam.correctionLog.push(`${new Date().toISOString()} · ${req.user.name} · ${t.subjects.find((s) => s.id === subject.subjectId).name}: ${note}`);
    }
    exam.marks[subject.subjectId] = clean;
    res.json(summary(t, exam));
  });

  r.post('/exams/:id/publish', (req, res) => {
    requirePermission(req.user, 'enterMarks');
    const t = req.tenant;
    const exam = loadExam(req);
    if (exam.resultsPublished) return res.json(summary(t, exam));
    const progress = marksProgress(exam, roster(t, exam.classId, exam.academicYearId));
    if (progress.entered < progress.total) {
      throw badRequest(`Enter all marks (or mark absent) first: ${progress.entered}/${progress.total} done`);
    }
    Object.assign(exam, { resultsPublished: true, isDraft: false, publishedAt: new Date().toISOString() });
    t.activity.push({ type: 'exam', title: 'Results published', subtitle: `${exam.name} · ${t.classes.find((c) => c.id === exam.classId).name}`, at: exam.publishedAt, adminOnly: false });
    res.json(summary(t, exam));
  });

  return r;
}
