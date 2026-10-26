import { forbidden, unauthorized } from '../lib/errors.js';
import { verifyToken } from '../lib/token.js';

/**
 * Resolves the tenant and the user for every /api request. Permissions are
 * re-read from the store on each request, so an admin's change applies to
 * the staff member's very next call.
 */
export function authenticate(store, secret) {
  return (req, _res, next) => {
    const header = req.get('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    const payload = verifyToken(token, secret);
    if (!payload) return next(unauthorized());

    const t = store.tenant(payload.tenantId);
    if (!t) return next(unauthorized());

    if (payload.role === 'admin') {
      req.user = { role: 'admin', id: t.admin.id, name: t.admin.name, isActive: true, permissions: [], assignedClassIds: [] };
    } else {
      const member = t.staff.find((s) => s.id === payload.staffId);
      if (!member) return next(unauthorized());
      if (!member.isActive) return next(forbidden('Your account is inactive'));
      req.user = {
        role: 'staff',
        id: member.id,
        name: member.name,
        isActive: member.isActive,
        permissions: member.permissions,
        assignedClassIds: member.assignedClassIds,
      };
    }
    req.tenant = t;
    next();
  };
}

export function adminOnly(req, _res, next) {
  if (req.user?.role !== 'admin') return next(forbidden('Admin only'));
  next();
}
