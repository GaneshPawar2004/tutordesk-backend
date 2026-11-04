const express = require('express');
const bcrypt = require('bcryptjs');

const db = require('../db');
const User = require('../models/User');
const validate = require('../middleware/validate');
const { requireOwner } = require('../middleware/auth');
const { signAuthToken } = require('../utils/tokens');
const { ApiError } = require('../utils/errors');
const { instituteSummary } = require('./auth');
const s = require('../utils/schemas');

/** The signed-in user's own profile. Works even when the institute's access has ended. */
const router = express.Router();

const profileSchema = s.z
  .object({
    name: s.z.string().trim().min(2, 'Enter your full name').max(100),
    instituteName: s.z.string().trim().min(2, 'Enter the institute name').max(100),
  })
  .partial();

router.patch('/', validate(profileSchema), async (req, res) => {
  const { name, instituteName } = req.body;
  if (instituteName !== undefined && req.user.role !== 'owner') {
    throw new ApiError(403, 'FORBIDDEN', 'Only the admin can rename the institute');
  }
  const user = name
    ? await db.one('update users set name = $2 where id = $1 returning *', [req.user.id, name])
    : req.user;
  if (instituteName) {
    await db.query('update institutes set name = $2 where id = $1', [req.instituteId, instituteName]);
  }
  res.json({ user: User.toPublic(user), institute: await instituteSummary(req.instituteId) });
});

const passwordSchema = s.z.object({
  currentPassword: s.z.string().min(1, 'Enter your current password'),
  newPassword: s.password,
});

/** Changes the password and signs out other devices; returns a fresh token for this one. */
router.post('/password', validate(passwordSchema), async (req, res) => {
  const ok = await bcrypt.compare(req.body.currentPassword, req.user.password_hash);
  if (!ok) throw new ApiError(400, 'WRONG_PASSWORD', 'Current password is incorrect');
  const user = await db.one(
    `update users set password_hash = $2, token_version = token_version + 1
     where id = $1 returning *`,
    [req.user.id, await bcrypt.hash(req.body.newPassword, 10)],
  );
  res.json({ token: signAuthToken(user), message: 'Password changed' });
});

/** Deletes the institute with all its staff, classes, students and records. */
router.delete('/', requireOwner, validate(s.z.object({ password: s.z.string().min(1) })), async (req, res) => {
  const ok = await bcrypt.compare(req.body.password, req.user.password_hash);
  if (!ok) throw new ApiError(400, 'WRONG_PASSWORD', 'Password is incorrect');
  await db.query('delete from institutes where id = $1', [req.instituteId]);
  res.status(204).end();
});

module.exports = router;
