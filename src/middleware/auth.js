const db = require('../db');
const { verifyToken } = require('../utils/tokens');
const { isId } = require('../utils/scope');
const { ApiError, unauthorized, forbidden } = require('../utils/errors');
const { accessOf } = require('../utils/access');

/** Requires a valid Bearer token; sets req.user (a `users` row) and req.instituteId. */
async function requireAuth(req, _res, next) {
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const payload = token && verifyToken(token, 'auth');
  if (!payload || !isId(payload.sub)) return next(unauthorized());

  const user = await db.one(
    `select u.*, i.access_status, i.access_until, i.trial_ends_at
     from users u join institutes i on i.id = u.institute_id where u.id = $1`,
    [payload.sub],
  );
  if (!user || user.token_version !== payload.v) return next(unauthorized());
  if (user.role === 'staff' && !user.active) {
    return next(forbidden('Your login has been blocked by the admin', 'ACCOUNT_BLOCKED'));
  }
  req.user = user;
  req.instituteId = user.institute_id;
  next();
}

/**
 * Blocks the institute's data while its trial/plan has ended or it is blocked
 * (allowed again with "Allow" on the admin page). Use after requireAuth.
 */
function requireAccess(req, _res, next) {
  const access = accessOf(req.user);
  if (access.allowed) return next();
  return next(new ApiError(403, access.code, `${access.message} Please contact us to continue using Kaksha.`));
}

const requireOwner = (req, _res, next) =>
  req.user.role === 'owner' ? next() : next(forbidden('Only the admin can do this'));

const canAccessFees = (user) => user.role === 'owner' || user.can_access_fees;

const requireFeeAccess = (req, _res, next) =>
  canAccessFees(req.user) ? next() : next(forbidden('You do not have access to fees'));

module.exports = { requireAuth, requireAccess, requireOwner, requireFeeAccess, canAccessFees };
