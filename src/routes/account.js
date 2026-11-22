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
    // Institute details and settings (admin only).
    instituteName: s.z.string().trim().min(2, 'Enter the institute name').max(100),
    institutePhone: s.z.string().trim().max(30),
    instituteAddress: s.z.string().trim().max(300),
    monthlyFees: s.z.boolean(),
  })
  .partial();

const INSTITUTE_COLUMNS = {
  instituteName: 'name',
  institutePhone: 'phone',
  instituteAddress: 'address',
  monthlyFees: 'monthly_fees',
};

router.patch('/', validate(profileSchema), async (req, res) => {
  const { name } = req.body;
  const changes = db.toColumns(req.body, INSTITUTE_COLUMNS);
  if (Object.keys(changes).length && req.user.role !== 'owner') {
    throw new ApiError(403, 'FORBIDDEN', 'Only the admin can change the institute details');
  }
  const user = name
    ? await db.one('update users set name = $2 where id = $1 returning *', [req.user.id, name])
    : req.user;
  if (Object.keys(changes).length) await db.query(...db.updateSql('institutes', req.instituteId, changes));
  res.json({ user: User.toPublic(user), institute: await instituteSummary(req.instituteId) });
});

// ---- Institute logo (shown on receipts) ------------------------------------------
function imageMime(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 8 && buf.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) return 'image/png';
  return null;
}

router.put(
  '/logo',
  requireOwner,
  validate(s.z.object({ image: s.z.string().min(10).max(700 * 1024) })),
  async (req, res) => {
    const buf = Buffer.from(req.body.image, 'base64');
    const mime = imageMime(buf);
    if (!mime) throw new ApiError(400, 'BAD_REQUEST', 'Logo must be a JPEG or PNG image');
    if (buf.length > 400 * 1024) throw new ApiError(400, 'BAD_REQUEST', 'Logo is too large (max 400 KB)');
    await db.tx(async (t) => {
      await t.query(
        `insert into institute_logos (institute_id, mime, image) values ($1, $2, $3)
         on conflict (institute_id) do update set mime = excluded.mime, image = excluded.image`,
        [req.instituteId, mime, buf],
      );
      await t.query('update institutes set logo_updated_at = now() where id = $1', [req.instituteId]);
    });
    res.json({ institute: await instituteSummary(req.instituteId) });
  },
);

router.get('/logo', async (req, res) => {
  const logo = await db.one('select mime, image from institute_logos where institute_id = $1', [req.instituteId]);
  if (!logo) throw new ApiError(404, 'NOT_FOUND', 'No logo');
  res.set('Cache-Control', 'private, max-age=31536000, immutable');
  res.type(logo.mime).send(Buffer.from(logo.image));
});

router.delete('/logo', requireOwner, async (req, res) => {
  await db.query('delete from institute_logos where institute_id = $1', [req.instituteId]);
  await db.query('update institutes set logo_updated_at = null where id = $1', [req.instituteId]);
  res.json({ institute: await instituteSummary(req.instituteId) });
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
