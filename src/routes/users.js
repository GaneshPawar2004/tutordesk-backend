const express = require('express');
const bcrypt = require('bcryptjs');

const db = require('../db');
const User = require('../models/User');
const validate = require('../middleware/validate');
const { findOwned } = require('../utils/scope');
const { conflict, forbidden } = require('../utils/errors');
const s = require('../utils/schemas');

/** Staff logins. Mounted behind requireOwner. */
const router = express.Router();

const PLAN_MESSAGE =
  'Your plan does not include more staff logins. Add staff logins for ₹500/user per year from Subscriptions.';

async function planInfo(instituteId) {
  const row = await db.one(
    `select i.staff_login_limit,
       (select count(*)::int from users u
          where u.institute_id = i.id and u.role = 'staff' and u.active) as active_count
     from institutes i where i.id = $1`,
    [instituteId],
  );
  return { staffLoginLimit: row.staff_login_limit, activeCount: row.active_count };
}

async function assertEmailFree(email, exceptId) {
  const clash = await db.one('select id from users where email = $1 and id is distinct from $2', [
    email,
    exceptId ?? null,
  ]);
  if (clash) throw conflict('This email is already used', 'EMAIL_TAKEN');
}

router.get('/', async (req, res) => {
  const users = await db.query(
    "select * from users where institute_id = $1 and role = 'staff' order by created_at",
    [req.instituteId],
  );
  res.json({ ...(await planInfo(req.instituteId)), users: users.map(User.toPublic) });
});

const staffFields = {
  name: s.z.string().trim().min(1, 'Name is required').max(100),
  subject: s.z.string().trim().max(100),
  phone: s.optionalMobile,
  email: s.email,
  password: s.password,
  salary: s.money.nullable(),
  canAccessFees: s.z.boolean(),
};

router.post(
  '/',
  validate(s.z.object(staffFields).partial().required({ name: true, email: true, password: true })),
  async (req, res) => {
    const { password, ...rest } = req.body;
    await assertEmailFree(rest.email);
    // New logins start active only while the plan has free slots.
    const { staffLoginLimit, activeCount } = await planInfo(req.instituteId);
    const data = {
      ...db.toColumns(rest, User.COLUMNS),
      institute_id: req.instituteId,
      role: 'staff',
      email_verified: true,
      active: activeCount < staffLoginLimit,
      password_hash: await bcrypt.hash(password, 10),
    };
    const user = await db.one(...db.insertSql('users', data));
    res.status(201).json({ user: User.toPublic(user) });
  },
);

router.patch(
  '/:id',
  validate(s.z.object({ ...staffFields, active: s.z.boolean() }).partial()),
  async (req, res) => {
    let user = await findOwned('users', req.params.id, req.instituteId, 'User');
    if (user.role !== 'staff') throw forbidden('The admin login cannot be changed here');
    const { password, active, ...rest } = req.body;

    if (rest.email) await assertEmailFree(rest.email, user.id);
    if (active === true && !user.active) {
      const { staffLoginLimit, activeCount } = await planInfo(req.instituteId);
      if (activeCount >= staffLoginLimit) throw forbidden(PLAN_MESSAGE, 'PLAN_LIMIT');
    }
    const changes = db.toColumns(rest, User.COLUMNS);
    if (active !== undefined) changes.active = active;
    if (password) {
      changes.password_hash = await bcrypt.hash(password, 10);
      changes.token_version = user.token_version + 1;
    }
    if (Object.keys(changes).length) user = await db.one(...db.updateSql('users', user.id, changes));
    res.json({ user: User.toPublic(user) });
  },
);

router.delete('/:id', async (req, res) => {
  const user = await findOwned('users', req.params.id, req.instituteId, 'User');
  if (user.role !== 'staff') throw forbidden('The admin login cannot be deleted');
  await db.query('delete from users where id = $1', [user.id]);
  res.status(204).end();
});

module.exports = router;
