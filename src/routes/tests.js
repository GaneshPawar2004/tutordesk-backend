const express = require('express');

const db = require('../db');
const Test = require('../models/Test');
const validate = require('../middleware/validate');
const { findOwned } = require('../utils/scope');
const { badRequest } = require('../utils/errors');
const s = require('../utils/schemas');

const router = express.Router();

const subject = s.z.string().trim().min(1, 'Subject is required').max(100);
const maxMarks = s.z.number().positive('Enter valid maximum marks').max(10000);

const marksOf = (testId, q = db) =>
  q.query('select * from test_marks where test_id = $1 order by position', [testId]);

router.get('/classes/:classId/tests', async (req, res) => {
  const c = await findOwned('classes', req.params.classId, req.instituteId, 'Class');
  const [tests, marks] = await Promise.all([
    db.query('select * from tests where class_id = $1 order by created_at desc', [c.id]),
    db.query(
      `select m.* from test_marks m join tests t on t.id = m.test_id
       where t.class_id = $1 order by m.position`,
      [c.id],
    ),
  ]);
  const byTest = new Map(tests.map((t) => [t.id, []]));
  for (const m of marks) byTest.get(m.test_id)?.push(m);
  res.json({ tests: tests.map((t) => Test.toPublic(t, byTest.get(t.id))) });
});

router.post(
  '/classes/:classId/tests',
  validate(s.z.object({ subject, maxMarks })),
  async (req, res) => {
    const c = await findOwned('classes', req.params.classId, req.instituteId, 'Class');
    const t = await db.one(
      'insert into tests (institute_id, class_id, subject, max_marks) values ($1, $2, $3, $4) returning *',
      [req.instituteId, c.id, req.body.subject, req.body.maxMarks],
    );
    res.status(201).json({ test: Test.toPublic(t, []) });
  },
);

router.get('/tests/:id', async (req, res) => {
  const t = await findOwned('tests', req.params.id, req.instituteId, 'Test');
  res.json({ test: Test.toPublic(t, await marksOf(t.id)) });
});

const marksSchema = s.z.object({
  subject: subject.optional(),
  maxMarks: maxMarks.optional(),
  marks: s.z
    .array(
      s.z.object({
        student: s.objectId,
        marks: s.z.number().min(0).nullable().default(null), // null = absent
        remarks: s.z.string().trim().max(200).default(''),
        skip: s.z.boolean().default(false),
      }),
    )
    .max(1000)
    .optional(),
});

/** Update test details and/or replace all marks (Edit Marks → Save). */
router.put('/tests/:id', validate(marksSchema), async (req, res) => {
  const t = await findOwned('tests', req.params.id, req.instituteId, 'Test');
  const subjectNew = req.body.subject || t.subject;
  const maxNew = req.body.maxMarks || t.max_marks;

  let marks;
  if (req.body.marks) {
    const ids = req.body.marks.map((m) => m.student);
    if (new Set(ids).size !== ids.length) throw badRequest('A student appears more than once');
    const { n } = await db.one(
      'select count(*)::int as n from students where class_id = $1 and id = any($2::uuid[])',
      [t.class_id, ids],
    );
    if (n !== ids.length) throw badRequest('Some students do not belong to this class');
    marks = req.body.marks.map((m, i) => ({ student_id: m.student, position: i, ...m }));
  } else {
    marks = await marksOf(t.id);
  }
  const over = marks.find((m) => !m.skip && m.marks != null && m.marks > maxNew);
  if (over) throw badRequest(`Marks cannot be more than ${maxNew}`);

  const result = await db.tx(async (q) => {
    const updated = await q.one('update tests set subject = $2, max_marks = $3 where id = $1 returning *', [
      t.id,
      subjectNew,
      maxNew,
    ]);
    if (req.body.marks) {
      await q.query('delete from test_marks where test_id = $1', [t.id]);
      if (marks.length) {
        const params = [t.id];
        const rows = marks.map((m) => {
          params.push(m.student_id, m.position, m.marks, m.remarks, m.skip);
          const p = params.length;
          return `($1, $${p - 4}, $${p - 3}, $${p - 2}, $${p - 1}, $${p})`;
        });
        await q.query(
          `insert into test_marks (test_id, student_id, position, marks, remarks, skip) values ${rows.join(', ')}`,
          params,
        );
      }
    }
    return Test.toPublic(updated, await marksOf(t.id, q));
  });
  res.json({ test: result });
});

router.delete('/tests/:id', async (req, res) => {
  const t = await findOwned('tests', req.params.id, req.instituteId, 'Test');
  await db.query('delete from tests where id = $1', [t.id]);
  res.status(204).end();
});

module.exports = router;
