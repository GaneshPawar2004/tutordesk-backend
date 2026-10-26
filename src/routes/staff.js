import { Router } from 'express';

import { nextId } from '../data/store.js';
import { badRequest, notFound } from '../lib/errors.js';
import { isoDate, phone, str } from '../lib/util.js';
import { adminOnly } from '../middleware/auth.js';
import { PERMISSIONS } from '../services/access.js';

/**
 * Staff management (admin only). Passwords are never handled here: new staff
 * get "invitationPending" and set their own credentials in a future flow.
 * Financial permissions do not exist and cannot be granted.
 */
export function staffRoutes() {
  const r = Router();
  r.use('/staff', adminOnly);

  const body = (b, t) => {
    const email = str(b, 'email', { max: 120 });
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw badRequest('Enter a valid email', { field: 'email' });
    const classIds = Array.isArray(b.assignedClassIds) ? b.assignedClassIds : [];
    if (classIds.some((id) => !t.classes.some((c) => c.id === id))) throw badRequest('Unknown class in assignedClassIds');
    return {
      name: str(b, 'name', { min: 3, max: 80 }),
      email,
      phone: phone(b, 'phone'),
      designation: str(b, 'designation', { max: 80 }),
      assignedClassIds: classIds,
      isActive: b.isActive !== false,
    };
  };

  r.get('/staff', (req, res) => res.json(req.tenant.staff));

  r.get('/staff/:id', (req, res) => {
    const m = req.tenant.staff.find((s) => s.id === req.params.id);
    if (!m) throw notFound('Staff member');
    res.json({ ...m, availablePermissions: PERMISSIONS });
  });

  r.post('/staff', (req, res) => {
    const t = req.tenant;
    const member = {
      id: nextId(t, 'staff', 'stf'),
      ...body(req.body ?? {}, t),
      permissions: ['viewStudents', 'markAttendance', 'viewExamResults'],
      joinedOn: isoDate(new Date()),
      accountStatus: 'invitationPending',
    };
    t.staff.push(member);
    t.activity.push({ type: 'staff', title: 'Staff member added', subtitle: `${member.name} · ${member.designation}`, at: new Date().toISOString(), adminOnly: true });
    res.status(201).json(member);
  });

  r.patch('/staff/:id', (req, res) => {
    const t = req.tenant;
    const m = t.staff.find((s) => s.id === req.params.id);
    if (!m) throw notFound('Staff member');
    Object.assign(m, body({ ...m, ...req.body }, t));
    res.json(m);
  });

  r.put('/staff/:id/permissions', (req, res) => {
    const m = req.tenant.staff.find((s) => s.id === req.params.id);
    if (!m) throw notFound('Staff member');
    const list = req.body?.permissions;
    if (!Array.isArray(list)) throw badRequest('permissions must be a list');
    const unknown = list.filter((p) => !PERMISSIONS.includes(p));
    if (unknown.length) throw badRequest(`Not a grantable permission: ${unknown.join(', ')}`);
    m.permissions = [...new Set(list)];
    res.json(m);
  });

  r.post('/staff/:id/accept-invitation', (req, res) => {
    const m = req.tenant.staff.find((s) => s.id === req.params.id);
    if (!m) throw notFound('Staff member');
    m.accountStatus = 'active';
    res.json(m);
  });

  return r;
}
