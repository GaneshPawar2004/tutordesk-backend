const express = require('express');
const crypto = require('crypto');

const config = require('../config');
const db = require('../db');
const validate = require('../middleware/validate');
const { isId } = require('../utils/scope');
const { accessOf } = require('../utils/access');
const { unauthorized, notFound } = require('../utils/errors');
const s = require('../utils/schemas');

/**
 * Your own tools, used by the admin web page (/admin): list every tuition and
 * allow, block or extend it. Requires header `x-admin-key: <ADMIN_API_KEY>`.
 * Disabled when ADMIN_API_KEY is empty.
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

const instituteToPublic = (row) => {
  const access = accessOf(row);
  return {
    id: row.id,
    name: row.name,
    owner: row.owner_name ? { name: row.owner_name, email: row.owner_email, mobile: row.owner_mobile } : null,
    ownerVerified: row.owner_verified ?? null,
    staffCount: row.staff_count ?? null,
    studentCount: row.student_count ?? null,
    referredByMobile: row.referred_by_mobile,
    createdAt: row.created_at,
    trialEndsAt: row.trial_ends_at,
    trialDaysRemaining: access.trialDaysRemaining,
    status: row.access_status,
    accessUntil: row.access_until,
    allowed: access.allowed,
  };
};

const LIST_SQL = `
  select i.*, o.name as owner_name, o.email as owner_email, o.mobile as owner_mobile,
    o.email_verified as owner_verified,
    (select count(*)::int from users u where u.institute_id = i.id and u.role = 'staff') as staff_count,
    (select count(*)::int from students st where st.institute_id = i.id) as student_count
  from institutes i left join users o on o.id = i.owner_id`;

/** All tuitions, newest first. `q` filters by institute/owner name, email or mobile. */
router.get('/institutes', validate(s.z.object({ q: s.z.string().trim().max(100).optional() }), 'query'), async (req, res) => {
  const q = req.validQuery.q ? `%${req.validQuery.q.toLowerCase()}%` : null;
  const rows = await db.query(
    `${LIST_SQL}
     where $1::text is null or lower(i.name) like $1 or lower(o.name) like $1
        or lower(o.email) like $1 or o.mobile like $1
     order by i.created_at desc`,
    [q],
  );
  res.json({ institutes: rows.map(instituteToPublic) });
});

const accessSchema = s.z
  .object({
    // allow: active until accessUntil (null = no end); block: no access; trial: back to trial
    action: s.z.enum(['allow', 'block', 'trial']),
    accessUntil: s.nullableDate,
    extendTrialDays: s.z.number().int().min(1).max(3650),
  })
  .partial();

router.patch('/institutes/:id', validate(accessSchema), async (req, res) => {
  const inst = isId(req.params.id) && (await db.one('select * from institutes where id = $1', [req.params.id]));
  if (!inst) throw notFound('Institute');
  const { action, accessUntil, extendTrialDays } = req.body;
  const changes = {};
  if (action === 'allow') {
    changes.access_status = 'active';
    changes.access_until = accessUntil ?? null;
  } else if (action === 'block') {
    changes.access_status = 'blocked';
  } else if (action === 'trial') {
    changes.access_status = 'trial';
    changes.access_until = null;
  }
  if (extendTrialDays) {
    const from = Math.max(Date.now(), inst.trial_ends_at.getTime());
    changes.trial_ends_at = new Date(from + extendTrialDays * 86400000);
    if (!action) {
      changes.access_status = 'trial';
      changes.access_until = null;
    }
  }
  if (Object.keys(changes).length) await db.query(...db.updateSql('institutes', inst.id, changes));
  const row = await db.one(`${LIST_SQL} where i.id = $1`, [inst.id]);
  res.json({ institute: instituteToPublic(row) });
});

module.exports = router;
