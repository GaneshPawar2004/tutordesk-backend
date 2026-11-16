const express = require('express');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');

const config = require('../config');
const db = require('../db');
const validate = require('../middleware/validate');
const { isId } = require('../utils/scope');
const { accessOf } = require('../utils/access');
const { badRequest, unauthorized, notFound } = require('../utils/errors');
const s = require('../utils/schemas');

/**
 * Your own tools, used by the admin web page (/admin): list every tuition and
 * allow, block or extend it. Requires header `x-admin-key: <ADMIN_API_KEY>`.
 * Disabled when ADMIN_API_KEY is empty.
 */
const router = express.Router();

// Slows down guessing the admin key: wrong keys only, 20 per 15 minutes per IP.
router.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 20,
    skipSuccessfulRequests: true,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    skip: () => config.isTest,
    message: { error: { code: 'RATE_LIMITED', message: 'Too many wrong keys. Try again later.' } },
  }),
);

router.use((req, _res, next) => {
  const key = Buffer.from(req.get('x-admin-key') || '');
  const expected = Buffer.from(config.adminApiKey);
  const ok = expected.length > 0 && key.length === expected.length && crypto.timingSafeEqual(key, expected);
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
    // allow: active for `days` (added to a running plan) or until accessUntil
    // (null/absent = no end); block: no access; trial: back to trial
    action: s.z.enum(['allow', 'block', 'trial']),
    days: s.z.number().int().min(1).max(3650),
    accessUntil: s.nullableDate,
    // Only for tuitions on trial (an allowed or blocked one keeps its status).
    extendTrialDays: s.z.number().int().min(1).max(3650),
  })
  .partial();

const DAY = 86400000;

router.patch('/institutes/:id', validate(accessSchema), async (req, res) => {
  const inst = isId(req.params.id) && (await db.one('select * from institutes where id = $1', [req.params.id]));
  if (!inst) throw notFound('Institute');
  const { action, days, accessUntil, extendTrialDays } = req.body;
  const changes = {};
  if (action === 'allow') {
    changes.access_status = 'active';
    if (days) {
      // Renewing early keeps the days left: count from the current end date.
      const running = inst.access_status === 'active' && inst.access_until && inst.access_until.getTime() > Date.now();
      const from = running ? inst.access_until.getTime() : Date.now();
      changes.access_until = new Date(from + days * DAY);
    } else {
      changes.access_until = accessUntil ?? null;
    }
  } else if (action === 'block') {
    changes.access_status = 'blocked';
  } else if (action === 'trial') {
    changes.access_status = 'trial';
    changes.access_until = null;
  }
  if (extendTrialDays) {
    if ((action ?? inst.access_status) !== 'trial') {
      throw badRequest('Extending the trial only works for tuitions on trial. Use Allow instead.');
    }
    const from = Math.max(Date.now(), inst.trial_ends_at.getTime());
    changes.trial_ends_at = new Date(from + extendTrialDays * DAY);
  }
  if (Object.keys(changes).length) await db.query(...db.updateSql('institutes', inst.id, changes));
  const row = await db.one(`${LIST_SQL} where i.id = $1`, [inst.id]);
  res.json({ institute: instituteToPublic(row) });
});

module.exports = router;
