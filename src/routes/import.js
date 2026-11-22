const express = require('express');

const db = require('../db');
const validate = require('../middleware/validate');
const { requireOwner } = require('../middleware/auth');
const { findOwned, todayIST } = require('../utils/scope');
const { badRequest } = require('../utils/errors');
const s = require('../utils/schemas');

/**
 * Bulk import of a class's data (e.g. from the old Teachers App's "Export
 * Class Data (CSV)", parsed by the app): students, fee payments, attendance
 * history and tests with marks — all in one transaction, so a failed import
 * changes nothing. Admin only (the data includes fees).
 *
 * Students already in the class with the same roll number (or the same name
 * when there is no roll number) are skipped, so importing a file twice does
 * not create duplicates.
 */
const router = express.Router({ mergeParams: true });

const text = (max) => s.z.string().trim().max(max).default('');
const isoDate = s.isoDate;

const importSchema = s.z.object({
  students: s.z
    .array(
      s.z.object({
        name: s.z.string().trim().min(1).max(100),
        fatherName: text(100),
        contact: s.optionalMobile.default(''),
        parentMobile: s.optionalMobile.default(''),
        rollNo: text(20),
        email: s.optionalEmail.default(''),
        dateOfBirth: isoDate.nullable().default(null),
        totalFees: s.money.default(0),
        feesDueDate: isoDate.nullable().default(null),
        payments: s.z
          .array(s.z.object({ amount: s.z.number().positive().max(1e9), paidAt: isoDate.nullable() }))
          .max(500)
          .default([]),
        // date (YYYY-MM-DD) → status
        attendance: s.z.record(isoDate, s.z.enum(['present', 'absent', 'leave', 'others'])).default({}),
      }),
    )
    .min(1)
    .max(2000),
  tests: s.z
    .array(
      s.z.object({
        subject: s.z.string().trim().min(1).max(100),
        maxMarks: s.z.number().positive().max(10000),
        // index in `students` → marks (null = absent)
        marks: s.z.record(s.z.string().regex(/^\d+$/), s.z.number().min(0).nullable()).default({}),
      }),
    )
    .max(200)
    .default([]),
  source: s.z.string().trim().max(60).default('import'),
});

/** Runs a multi-row insert in chunks (stays under Postgres' parameter limit). */
async function insertRows(t, sqlHead, rows, width, tail = '') {
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const part = rows.slice(i, i + CHUNK);
    const params = part.flat();
    const values = part.map((_, r) => `(${Array.from({ length: width }, (_, c) => `$${r * width + c + 1}`).join(', ')})`);
    await t.query(`${sqlHead} values ${values.join(', ')} ${tail}`, params);
  }
}

router.post('/', requireOwner, validate(importSchema), async (req, res) => {
  const c = await findOwned('classes', req.params.classId, req.instituteId, 'Class');
  const { students, tests, source } = req.body;
  const today = todayIST();

  const result = await db.tx(async (t) => {
    const existing = await t.query('select id, name, roll_no from students where class_id = $1', [c.id]);
    const byRoll = new Map(existing.filter((x) => x.roll_no).map((x) => [x.roll_no, x.id]));
    const byName = new Set(existing.filter((x) => !x.roll_no).map((x) => x.name.toLowerCase()));

    const seenRoll = new Set();
    const ids = []; // index in `students` → new id (null = skipped)
    let skipped = 0;
    const newStudents = [];
    students.forEach((st, i) => {
      const dupe = st.rollNo ? byRoll.has(st.rollNo) || seenRoll.has(st.rollNo) : byName.has(st.name.toLowerCase());
      if (dupe) {
        skipped += 1;
        ids[i] = null;
        return;
      }
      if (st.rollNo) seenRoll.add(st.rollNo);
      newStudents.push(i);
    });

    // Students (one insert each: we need their ids, and imports are small).
    for (const i of newStudents) {
      const st = students[i];
      const paid = Math.round(st.payments.reduce((a, p) => a + p.amount, 0) * 100) / 100;
      const row = await t.one(
        `insert into students (institute_id, class_id, name, father_name, contact, parent_mobile, roll_no,
           email, total_fees, fees_paid, fees_due_date, date_of_birth)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) returning id`,
        [
          req.instituteId,
          c.id,
          st.name,
          st.fatherName,
          st.contact,
          st.parentMobile,
          st.rollNo,
          st.email,
          Math.max(st.totalFees, paid),
          paid,
          st.feesDueDate,
          st.dateOfBirth,
        ],
      );
      ids[i] = row.id;
    }

    // Fee payments (kept with their original dates).
    const payments = [];
    for (const i of newStudents) {
      for (const p of students[i].payments) {
        payments.push([
          req.instituteId,
          ids[i],
          p.amount,
          `Imported (${source})`,
          p.paidAt ? new Date(`${p.paidAt}T12:00:00+05:30`) : new Date(),
          req.user.id,
        ]);
      }
    }
    await insertRows(
      t,
      'insert into fee_payments (institute_id, student_id, amount, note, paid_at, collected_by)',
      payments,
      6,
    );

    // Attendance history: one attendance row per date, records for imported students.
    const byDate = new Map();
    for (const i of newStudents) {
      for (const [date, status] of Object.entries(students[i].attendance)) {
        if (date > today) continue;
        if (!byDate.has(date)) byDate.set(date, []);
        byDate.get(date).push([ids[i], status]);
      }
    }
    let attendanceDays = 0;
    for (const [date, recs] of byDate) {
      const day = await t.one(
        `insert into attendance (institute_id, class_id, date, marked_by) values ($1, $2, $3, $4)
         on conflict (class_id, date) do update set version = attendance.version + 1
         returning id`,
        [req.instituteId, c.id, date, req.user.id],
      );
      const { n } = await t.one(
        'select coalesce(max(position) + 1, 0)::int as n from attendance_records where attendance_id = $1',
        [day.id],
      );
      await insertRows(
        t,
        'insert into attendance_records (attendance_id, student_id, position, status)',
        recs.map(([sid, status], k) => [day.id, sid, n + k, status]),
        4,
        'on conflict (attendance_id, student_id) do nothing',
      );
      attendanceDays += 1;
    }

    // Tests with marks.
    let testCount = 0;
    for (const test of tests) {
      const marks = Object.entries(test.marks)
        .map(([idx, m]) => [ids[Number(idx)], m])
        .filter(([sid, m]) => sid && (m === null || m <= test.maxMarks));
      if (!marks.length) continue;
      const row = await t.one(
        'insert into tests (institute_id, class_id, subject, max_marks) values ($1, $2, $3, $4) returning id',
        [req.instituteId, c.id, test.subject, test.maxMarks],
      );
      await insertRows(
        t,
        'insert into test_marks (test_id, student_id, position, marks)',
        marks.map(([sid, m], k) => [row.id, sid, k, m]),
        4,
      );
      testCount += 1;
    }

    return {
      students: newStudents.length,
      skipped,
      payments: payments.length,
      attendanceDays,
      tests: testCount,
    };
  });
  if (!result.students && result.skipped) {
    throw badRequest('All students in this file are already in the class.');
  }
  res.status(201).json({ imported: result });
});

module.exports = router;
