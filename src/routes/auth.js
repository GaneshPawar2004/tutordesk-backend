import { Router } from 'express';

import { badRequest, notFound } from '../lib/errors.js';
import { signToken } from '../lib/token.js';

/**
 * Demo sign-in only: picks a role without a password. Replace with real
 * authentication (OTP / password + sessions) before any production use.
 */
export function authRoutes(store, secret) {
  const r = Router();
  const tenantId = 'tui-1';

  r.get('/demo-accounts', (_req, res) => {
    const t = store.tenant(tenantId);
    res.json({
      tuition: { id: t.tuition.id, name: t.tuition.name },
      admin: { name: t.admin.name },
      staff: t.staff
        .filter((s) => s.isActive)
        .map((s) => ({ id: s.id, name: s.name, designation: s.designation, permissionCount: s.permissions.length })),
    });
  });

  r.post('/demo-login', (req, res) => {
    const { role, staffId } = req.body ?? {};
    const t = store.tenant(tenantId);
    if (role === 'admin') {
      return res.json({ token: signToken({ tenantId, role: 'admin' }, secret) });
    }
    if (role === 'staff') {
      const member = t.staff.find((s) => s.id === staffId && s.isActive);
      if (!member) throw notFound('Staff member');
      return res.json({ token: signToken({ tenantId, role: 'staff', staffId: member.id }, secret) });
    }
    throw badRequest('role must be "admin" or "staff"');
  });

  return r;
}
