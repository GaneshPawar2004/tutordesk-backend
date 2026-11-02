const db = require('../db');
const { verifyToken } = require('../utils/tokens');
const { isId } = require('../utils/scope');
const { unauthorized, forbidden } = require('../utils/errors');

/** Requires a valid Bearer token; sets req.user (a `users` row) and req.instituteId. */
async function requireAuth(req, _res, next) {
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const payload = token && verifyToken(token, 'auth');
  if (!payload || !isId(payload.sub)) return next(unauthorized());

  const user = await db.one('select * from users where id = $1', [payload.sub]);
  if (!user || user.token_version !== payload.v) return next(unauthorized());
  if (user.role === 'staff' && !user.active) {
    return next(forbidden('Your login has been blocked by the admin', 'ACCOUNT_BLOCKED'));
  }
  req.user = user;
  req.instituteId = user.institute_id;
  next();
}

const requireOwner = (req, _res, next) =>
  req.user.role === 'owner' ? next() : next(forbidden('Only the admin can do this'));

const canAccessFees = (user) => user.role === 'owner' || user.can_access_fees;

const requireFeeAccess = (req, _res, next) =>
  canAccessFees(req.user) ? next() : next(forbidden('You do not have access to fees'));

module.exports = { requireAuth, requireOwner, requireFeeAccess, canAccessFees };
