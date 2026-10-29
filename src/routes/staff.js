import { Router } from 'express';

import { COLS, logActivity, newId } from '../data/repo.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { inviteCode } from '../lib/password.js';
import { phone, str } from '../lib/util.js';
import { adminOnly } from '../middleware/auth.js';
import { PERMISSIONS } from '../services/access.js';

/**
 * Staff management (admin only). New staff get an invite code; they set
 * their own password with it (POST /api/auth/accept-invite). Passwords are
 * never visible to the admin. Financial permissions do not exist.
 */
export function staffRoutes(db) {
  const r = Router();
  r.use('/staff', adminOnly);

  async function body(b, tenantId) {
    const email = str(b, 'email', { optional: true, max: 120 })?.toLowerCase() || null;
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw badRequest('Enter a valid email', { field: 'email' });
    const classIds = Array.isArray(b.assignedClassIds) ? b.assignedClassIds.map(String) : [];
    if (classIds.length) {
      const found = await db.query('select id from classes where tenant_id = $1 and id = any($2)', [tenantId, classIds]);
      if (found.length !== new Set(classIds).size) throw badRequest('Unknown class in assigned classes');
    }
    return {
      name: str(b, 'name', { min: 3, max: 80 }),
      email,
      phone: phone(b, 'phone'),
      designation: str(b, 'designation', { max: 80 }),
      assignedClassIds: classIds,
      isActive: b.isActive !== false,
    };
  }
  const select = `select ${COLS.staff}, invite_code "inviteCode" from users`;

  r.get('/staff', async (req, res) => {
    res.json(await db.query(`${select} where tenant_id = $1 and role = 'staff' order by name`, [req.tenantId]));
  });

  r.get('/staff/:id', async (req, res) => {
    const m = await db.one(`${select} where id = $1 and tenant_id = $2 and role = 'staff'`, [req.params.id, req.tenantId]);
    if (!m) throw notFound('Staff member');
    res.json({ ...m, availablePermissions: PERMISSIONS });
  });

  r.post('/staff', async (req, res) => {
    const m = await body(req.body ?? {}, req.tenantId);
    try {
      const created = await db.one(
        `insert into users (id, tenant_id, role, name, email, phone, designation, permissions, assigned_class_ids, is_active, account_status, invite_code)
         values ($1, $2, 'staff', $3, $4, $5, $6, $7, $8, $9, 'invitationPending', $10)
         returning ${COLS.staff}, invite_code "inviteCode"`,
        [newId(), req.tenantId, m.name, m.email, m.phone, m.designation, ['viewStudents', 'markAttendance', 'viewExamResults'],
          m.assignedClassIds, m.isActive, inviteCode()],
      );
      await logActivity(db, req.tenantId, { type: 'staff', title: 'Staff member added', subtitle: `${m.name} · ${m.designation}`, adminOnly: true });
      res.status(201).json(created);
    } catch (e) {
      if (e.code === '23505') throw conflict('This phone number or email already has an account');
      throw e;
    }
  });

  r.patch('/staff/:id', async (req, res) => {
    const cur = await db.one(`${select} where id = $1 and tenant_id = $2 and role = 'staff'`, [req.params.id, req.tenantId]);
    if (!cur) throw notFound('Staff member');
    const m = await body({ ...cur, ...req.body }, req.tenantId);
    try {
      res.json(
        await db.one(
          `update users set name = $2, email = $3, phone = $4, designation = $5, assigned_class_ids = $6, is_active = $7
            where id = $1 returning ${COLS.staff}, invite_code "inviteCode"`,
          [cur.id, m.name, m.email, m.phone, m.designation, m.assignedClassIds, m.isActive],
        ),
      );
    } catch (e) {
      if (e.code === '23505') throw conflict('This phone number or email already has an account');
      throw e;
    }
  });

  r.put('/staff/:id/permissions', async (req, res) => {
    const list = req.body?.permissions;
    if (!Array.isArray(list)) throw badRequest('permissions must be a list');
    const unknown = list.filter((p) => !PERMISSIONS.includes(p));
    if (unknown.length) throw badRequest(`Not a grantable permission: ${unknown.join(', ')}`);
    const m = await db.one(
      `update users set permissions = $3 where id = $1 and tenant_id = $2 and role = 'staff' returning ${COLS.staff}, invite_code "inviteCode"`,
      [req.params.id, req.tenantId, [...new Set(list)]],
    );
    if (!m) throw notFound('Staff member');
    res.json(m);
  });

  /** Issues a fresh invite code (e.g. staff lost it or forgot their password). */
  r.post('/staff/:id/reset-invite', async (req, res) => {
    const m = await db.one(
      `update users set invite_code = $3, account_status = 'invitationPending', password_hash = null
        where id = $1 and tenant_id = $2 and role = 'staff' returning ${COLS.staff}, invite_code "inviteCode"`,
      [req.params.id, req.tenantId, inviteCode()],
    );
    if (!m) throw notFound('Staff member');
    res.json(m);
  });

  return r;
}
