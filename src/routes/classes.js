const express = require('express');

const db = require('../db');
const validate = require('../middleware/validate');
const { requireOwner } = require('../middleware/auth');
const { findOwned } = require('../utils/scope');
const { conflict } = require('../utils/errors');
const s = require('../utils/schemas');

const router = express.Router();

const toPublic = (c, studentCount = 0) => ({
  id: c.id,
  name: c.name,
  studentCount,
  createdAt: c.created_at,
});

const nameKey = (name) => name.trim().toLowerCase();

async function assertUniqueName(instituteId, name, exceptId) {
  const clash = await db.one(
    'select id from classes where institute_id = $1 and name_key = $2 and id is distinct from $3',
    [instituteId, nameKey(name), exceptId ?? null],
  );
  if (clash) throw conflict('This class already exists', 'DUPLICATE');
}

const countStudents = async (classId) =>
  (await db.one('select count(*)::int as n from students where class_id = $1', [classId])).n;

router.get('/', async (req, res) => {
  const classes = await db.query(
    `select c.*, (select count(*)::int from students st where st.class_id = c.id) as student_count
     from classes c where c.institute_id = $1 order by c.created_at`,
    [req.instituteId],
  );
  res.json({ classes: classes.map((c) => toPublic(c, c.student_count)) });
});

const nameSchema = s.z.object({
  name: s.z.string().trim().min(1, 'Please enter a class name').max(60),
});

router.post('/', validate(nameSchema), async (req, res) => {
  await assertUniqueName(req.instituteId, req.body.name);
  const c = await db.one(
    'insert into classes (institute_id, name, name_key) values ($1, $2, $3) returning *',
    [req.instituteId, req.body.name, nameKey(req.body.name)],
  );
  res.status(201).json({ class: toPublic(c) });
});

router.patch('/:id', validate(nameSchema), async (req, res) => {
  const c = await findOwned('classes', req.params.id, req.instituteId, 'Class');
  await assertUniqueName(req.instituteId, req.body.name, c.id);
  const updated = await db.one('update classes set name = $2, name_key = $3 where id = $1 returning *', [
    c.id,
    req.body.name,
    nameKey(req.body.name),
  ]);
  res.json({ class: toPublic(updated, await countStudents(c.id)) });
});

// Deleting a class removes its students, attendance, tests and payments (cascade).
router.delete('/:id', requireOwner, async (req, res) => {
  const c = await findOwned('classes', req.params.id, req.instituteId, 'Class');
  await db.query('delete from classes where id = $1', [c.id]);
  res.status(204).end();
});

module.exports = router;
