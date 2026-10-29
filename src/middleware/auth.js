import { forbidden, unauthorized } from '../lib/errors.js';
import { verifyToken } from '../lib/token.js';

/**
 * Resolves the user (and their tenant) from the bearer token on every request.
 * The user row is re-read each time, so permission or status changes made by
 * an admin apply to the staff member's very next call.
 */
export function authenticate(db, secret) {
  return async (req, _res, next) => {
    try {
      const header = req.get('authorization') ?? '';
      const payload = verifyToken(header.startsWith('Bearer ') ? header.slice(7) : null, secret);
      if (!payload) return next(unauthorized());
      const u = await db.one(
        `select u.id, u.tenant_id "tenantId", u.role, u.name, coalesce(u.email, '') email, u.phone, u.designation,
                u.permissions, u.assigned_class_ids "assignedClassIds", u.is_active "isActive", u.account_status "accountStatus"
           from users u where u.id = $1 and u.tenant_id = $2`,
        [payload.userId, payload.tenantId],
      );
      if (!u) return next(unauthorized());
      if (!u.isActive) return next(forbidden('Your account is inactive. Contact your tuition admin.'));
      if (u.role === 'admin') {
        // Admin can use every class, including ones created after sign-in.
        const rows = await db.query('select id from classes where tenant_id = $1', [u.tenantId]);
        u.assignedClassIds = rows.map((r) => r.id);
      }
      req.user = u;
      req.tenantId = u.tenantId;
      next();
    } catch (e) {
      next(e);
    }
  };
}

export function adminOnly(req, _res, next) {
  if (req.user?.role !== 'admin') return next(forbidden('Admin only'));
  next();
}
