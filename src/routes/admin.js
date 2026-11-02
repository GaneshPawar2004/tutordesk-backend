const express = require('express');
const crypto = require('crypto');

const config = require('../config');
const db = require('../db');
const User = require('../models/User');
const validate = require('../middleware/validate');
const { isId } = require('../utils/scope');
const { unauthorized, notFound } = require('../utils/errors');
const s = require('../utils/schemas');

/**
 * Your own tools (not used by the app): look up an institute and change its
 * plan, e.g. after a teacher pays for staff logins. Requires header
 * `x-admin-key: <ADMIN_API_KEY>`. Disabled when ADMIN_API_KEY is empty.
 */
const router = express.Router();

router.use((req, _res, next) => {
  const key = req.get('x-admin-key') || '';
  const expected = config.adminApiKey;
  const ok =
    expected &&
    key.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(key), Buffer.from(expected));
  return ok ? next() : next(unauthorized('Invalid admin key'));
});

const instituteToPublic = (inst) => ({
  id: inst.id,
  name: inst.name,
  owner: inst.owner_id,
  trialEndsAt: inst.trial_ends_at,
  staffLoginLimit: inst.staff_login_limit,
  referredByMobile: inst.referred_by_mobile,
  createdAt: inst.created_at,
  updatedAt: inst.updated_at,
});

router.get('/institutes', validate(s.z.object({ email: s.email }), 'query'), async (req, res) => {
  const owner = await db.one('select * from users where email = $1', [req.validQuery.email]);
  if (!owner) throw notFound('Account');
  const inst = await db.one('select * from institutes where id = $1', [owner.institute_id]);
  res.json({ institute: instituteToPublic(inst), owner: User.toPublic(owner) });
});

const planSchema = s.z
  .object({
    staffLoginLimit: s.z.number().int().min(0).max(1000),
    extendTrialDays: s.z.number().int().min(1).max(3650),
  })
  .partial();

router.patch('/institutes/:id', validate(planSchema), async (req, res) => {
  const inst = isId(req.params.id) && (await db.one('select * from institutes where id = $1', [req.params.id]));
  if (!inst) throw notFound('Institute');
  const changes = {};
  if (req.body.staffLoginLimit !== undefined) changes.staff_login_limit = req.body.staffLoginLimit;
  if (req.body.extendTrialDays) {
    const from = Math.max(Date.now(), inst.trial_ends_at.getTime());
    changes.trial_ends_at = new Date(from + req.body.extendTrialDays * 86400000);
  }
  const updated = Object.keys(changes).length
    ? await db.one(...db.updateSql('institutes', inst.id, changes))
    : inst;
  res.json({ institute: instituteToPublic(updated) });
});

module.exports = router;
