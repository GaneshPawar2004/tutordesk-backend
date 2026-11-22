const express = require('express');

const db = require('../db');
const Student = require('../models/Student');
const validate = require('../middleware/validate');
const { requireOwner, canAccessFees } = require('../middleware/auth');
const { findOwned } = require('../utils/scope');
const { badRequest, conflict, forbidden, notFound } = require('../utils/errors');
const s = require('../utils/schemas');

const router = express.Router();

const studentFields = {
  name: s.z.string().trim().min(1, 'Student name is required').max(100),
  fatherName: s.z.string().trim().max(100),
  contact: s.optionalMobile,
  parentMobile: s.optionalMobile,
  rollNo: s.z.string().trim().max(20),
  email: s.optionalEmail,
  dateOfBirth: s.nullableDate,
  totalFees: s.money,
  // Monthly fees system: amount per month, billed from feeStart (YYYY-MM).
  monthlyFee: s.money,
  feeStart: s.z.union([s.z.null(), s.z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use month format YYYY-MM')]),
  feesDueDate: s.nullableDate,
};
// Missing fields get their column defaults.
const createSchema = s.z.object(studentFields).partial().required({ name: true });
const updateSchema = s.z.object({ ...studentFields, disabled: s.z.boolean() }).partial();

const FEE_FIELDS = ['totalFees', 'monthlyFee', 'feeStart', 'feesDueDate'];

function assertFeeEdit(user, body) {
  if (!canAccessFees(user) && FEE_FIELDS.some((f) => f in body)) {
    throw forbidden('You do not have access to fees');
  }
}

async function assertRollFree(classId, rollNo, exceptId) {
  if (!rollNo) return;
  const clash = await db.one(
    'select id from students where class_id = $1 and roll_no = $2 and id is distinct from $3',
    [classId, rollNo, exceptId ?? null],
  );
  if (clash) throw conflict('Roll number already used in this class', 'DUPLICATE_ROLL');
}

// ---- Class-scoped ----------------------------------------------------------
router.get('/classes/:classId/students', async (req, res) => {
  const c = await findOwned('classes', req.params.classId, req.instituteId, 'Class');
  const onlyActive = req.query.includeDisabled === 'false';
  const students = await db.query(
    `select * from students where class_id = $1 ${onlyActive ? 'and not disabled' : ''} order by created_at`,
    [c.id],
  );
  const fees = canAccessFees(req.user);
  res.json({ students: students.map((st) => Student.toPublic(st, fees)) });
});

router.post('/classes/:classId/students', validate(createSchema), async (req, res) => {
  const c = await findOwned('classes', req.params.classId, req.instituteId, 'Class');
  if (!canAccessFees(req.user)) {
    for (const f of FEE_FIELDS) delete req.body[f];
  }
  await assertRollFree(c.id, req.body.rollNo);
  const data = { ...db.toColumns(req.body, Student.COLUMNS), institute_id: req.instituteId, class_id: c.id };
  const st = await db.one(...db.insertSql('students', data));
  res.status(201).json({ student: Student.toPublic(st, canAccessFees(req.user)) });
});

/**
 * Copies students (details only — no fees, attendance or marks) into another
 * class, e.g. for the next academic year. Students whose roll number is
 * already used in the target class are skipped.
 */
router.post(
  '/classes/:classId/students/copy',
  validate(s.z.object({ to: s.objectId, students: s.z.array(s.objectId).min(1).max(2000) })),
  async (req, res) => {
    const from = await findOwned('classes', req.params.classId, req.instituteId, 'Class');
    const to = await findOwned('classes', req.body.to, req.instituteId, 'Class');
    if (from.id === to.id) throw badRequest('Choose a different class to copy to');
    const result = await db.tx(async (t) => {
      const picked = await t.query(
        'select * from students where class_id = $1 and id = any($2::uuid[]) order by created_at',
        [from.id, req.body.students],
      );
      const taken = new Set(
        (await t.query("select roll_no from students where class_id = $1 and roll_no <> ''", [to.id])).map(
          (r) => r.roll_no,
        ),
      );
      let copied = 0;
      const skipped = [];
      for (const st of picked) {
        if (st.roll_no && taken.has(st.roll_no)) {
          skipped.push(st.name);
          continue;
        }
        if (st.roll_no) taken.add(st.roll_no);
        await t.query(
          `insert into students (institute_id, class_id, name, father_name, contact, parent_mobile,
             roll_no, email, date_of_birth)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [req.instituteId, to.id, st.name, st.father_name, st.contact, st.parent_mobile, st.roll_no, st.email,
            st.date_of_birth],
        );
        copied += 1;
      }
      return { copied, skipped };
    });
    res.status(201).json(result);
  },
);

// ---- Single student ----------------------------------------------------------
router.get('/students/:id', async (req, res) => {
  const st = await findOwned('students', req.params.id, req.instituteId, 'Student');
  res.json({ student: Student.toPublic(st, canAccessFees(req.user)) });
});

router.patch('/students/:id', validate(updateSchema), async (req, res) => {
  let st = await findOwned('students', req.params.id, req.instituteId, 'Student');
  assertFeeEdit(req.user, req.body);
  if ('rollNo' in req.body) await assertRollFree(st.class_id, req.body.rollNo, st.id);
  const changes = db.toColumns(req.body, Student.COLUMNS);
  if (Object.keys(changes).length) st = await db.one(...db.updateSql('students', st.id, changes));
  if (req.body.disabled === true) await stopPendingSms(st.id);
  res.json({ student: Student.toPublic(st, canAccessFees(req.user)) });
});

/** Parents of disabled/deleted students must not get SMS still waiting in the queue. */
const stopPendingSms = (studentId) =>
  db.query(
    `update sms_messages set status = 'dismissed', claimed_by = null, claimed_until = null
     where student_id = $1 and status in ('pending', 'failed')`,
    [studentId],
  );

// Payments, attendance records and marks of the student go with it (cascade).
router.delete('/students/:id', requireOwner, async (req, res) => {
  const st = await findOwned('students', req.params.id, req.instituteId, 'Student');
  await stopPendingSms(st.id);
  await db.query('delete from students where id = $1', [st.id]);
  res.status(204).end();
});

// ---- Photo ------------------------------------------------------------------
const MAX_PHOTO_BYTES = 500 * 1024;

/** Image type from its first bytes (only JPEG and PNG are accepted). */
function imageMime(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  return null;
}

/** Body: { image: base64 JPEG/PNG } (the app shrinks photos before upload). */
router.put(
  '/students/:id/photo',
  validate(s.z.object({ image: s.z.string().min(10).max(800 * 1024) })),
  async (req, res) => {
    const st = await findOwned('students', req.params.id, req.instituteId, 'Student');
    const buf = Buffer.from(req.body.image, 'base64');
    const mime = imageMime(buf);
    if (!mime) throw badRequest('Photo must be a JPEG or PNG image');
    if (buf.length > MAX_PHOTO_BYTES) throw badRequest('Photo is too large (max 500 KB)');
    const updated = await db.tx(async (t) => {
      await t.query(
        `insert into student_photos (student_id, mime, image) values ($1, $2, $3)
         on conflict (student_id) do update set mime = excluded.mime, image = excluded.image`,
        [st.id, mime, buf],
      );
      return t.one('update students set photo_updated_at = now() where id = $1 returning *', [st.id]);
    });
    res.json({ student: Student.toPublic(updated, canAccessFees(req.user)) });
  },
);

router.get('/students/:id/photo', async (req, res) => {
  const st = await findOwned('students', req.params.id, req.instituteId, 'Student');
  const photo = await db.one('select mime, image from student_photos where student_id = $1', [st.id]);
  if (!photo) throw notFound('Photo');
  // The URL carries ?v=photoUpdatedAt, so a changed photo gets a new URL.
  res.set('Cache-Control', 'private, max-age=31536000, immutable');
  res.type(photo.mime).send(Buffer.from(photo.image));
});

router.delete('/students/:id/photo', async (req, res) => {
  const st = await findOwned('students', req.params.id, req.instituteId, 'Student');
  await db.query('delete from student_photos where student_id = $1', [st.id]);
  const updated = await db.one('update students set photo_updated_at = null where id = $1 returning *', [st.id]);
  res.json({ student: Student.toPublic(updated, canAccessFees(req.user)) });
});

/** Attendance history (newest first) with a summary. */
router.get('/students/:id/attendance', async (req, res) => {
  const st = await findOwned('students', req.params.id, req.instituteId, 'Student');
  const history = await db.query(
    `select a.date, r.status, r.note from attendance_records r
     join attendance a on a.id = r.attendance_id
     where r.student_id = $1 and a.class_id = $2
     order by a.date desc`,
    [st.id, st.class_id],
  );
  const present = history.filter((h) => h.status === 'present').length;
  res.json({
    summary: {
      days: history.length,
      present,
      percent: history.length ? Math.round((present * 100) / history.length) : null,
    },
    history,
  });
});

/** Marks of this student in every test of their class. */
router.get('/students/:id/results', async (req, res) => {
  const st = await findOwned('students', req.params.id, req.instituteId, 'Student');
  const rows = await db.query(
    `select t.id, t.subject, t.max_marks, m.marks, m.remarks from tests t
     join test_marks m on m.test_id = t.id
     where t.class_id = $1 and m.student_id = $2 and not m.skip
     order by t.created_at desc`,
    [st.class_id, st.id],
  );
  res.json({
    results: rows.map((r) => ({
      test: r.id,
      subject: r.subject,
      maxMarks: r.max_marks,
      marks: r.marks,
      remarks: r.remarks,
    })),
  });
});

module.exports = router;
