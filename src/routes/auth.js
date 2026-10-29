import { Router } from 'express';

import { newId } from '../data/repo.js';
import { badRequest, conflict, unauthorized } from '../lib/errors.js';
import { hashPassword, verifyPassword } from '../lib/password.js';
import { signToken } from '../lib/token.js';
import { phone, str } from '../lib/util.js';

const TOKEN_TTL = 60 * 60 * 24 * 30; // 30 days
const DEFAULT_SUBJECTS = [
  ['Mathematics', 'MATH'], ['Science', 'SCI'], ['English', 'ENG'],
  ['Social Studies', 'SST'], ['Hindi', 'HIN'], ['Marathi', 'MAR'],
];

/** Academic year containing `d`, assuming June–April sessions (Indian tuition norm). */
function yearFor(d = new Date()) {
  const start = d.getMonth() >= 5 ? d.getFullYear() : d.getFullYear() - 1;
  return { label: `${start}–${String((start + 1) % 100).padStart(2, '0')}`, startDate: `${start}-06-01`, endDate: `${start + 1}-04-30` };
}

function password(body) {
  const p = body?.password;
  if (typeof p !== 'string' || p.length < 8) throw badRequest('Password must be at least 8 characters', { field: 'password' });
  if (p.length > 128) throw badRequest('Password is too long', { field: 'password' });
  return p;
}

export function authRoutes(db, secret) {
  const r = Router();
  const tokenFor = (u) => signToken({ tenantId: u.tenant_id, userId: u.id }, secret, TOKEN_TTL);

  /** Creates a new tuition with its first admin account. */
  r.post('/register', async (req, res) => {
    const b = req.body ?? {};
    const tuitionName = str(b, 'tuitionName', { min: 2, max: 100 });
    const adminName = str(b, 'adminName', { min: 2, max: 80 });
    const adminPhone = phone(b, 'phone');
    const email = str(b, 'email', { optional: true, max: 120 })?.toLowerCase() ?? null;
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw badRequest('Enter a valid email', { field: 'email' });
    const pwd = password(b);
    const city = str(b, 'city', { optional: true, max: 60 }) ?? '';

    const taken = await db.one(
      'select 1 from users where phone = $1 or (lower(email) = $2 and $2 is not null)',
      [adminPhone, email],
    );
    if (taken) throw conflict('An account with this phone number or email already exists. Please log in.');

    const hash = await hashPassword(pwd);
    const user = await db.tx(async (t) => {
      const tenantId = newId();
      await t.query('insert into tenants (id, name, city, phone, email) values ($1, $2, $3, $4, $5)', [tenantId, tuitionName, city, adminPhone, email ?? '']);
      const y = yearFor();
      await t.query(
        `insert into academic_years (id, tenant_id, label, start_date, end_date, status) values ($1, $2, $3, $4, $5, 'active')`,
        [newId(), tenantId, y.label, y.startDate, y.endDate],
      );
      for (const [name, code] of DEFAULT_SUBJECTS) {
        await t.query('insert into subjects (id, tenant_id, name, code) values ($1, $2, $3, $4)', [newId(), tenantId, name, code]);
      }
      return t.one(
        `insert into users (id, tenant_id, role, name, email, phone, password_hash, designation)
         values ($1, $2, 'admin', $3, $4, $5, $6, 'Owner · Admin') returning id, tenant_id`,
        [newId(), tenantId, adminName, email, adminPhone, hash],
      );
    });
    res.status(201).json({ token: tokenFor(user) });
  });

  /** Log in with phone number or email + password. */
  r.post('/login', async (req, res) => {
    const id = str(req.body, 'identifier', { max: 120 });
    const pwd = String(req.body?.password ?? '');
    const digits = id.replace(/\D/g, '').slice(-10);
    const u = id.includes('@')
      ? await db.one('select id, tenant_id, password_hash, is_active, account_status from users where lower(email) = $1', [id.toLowerCase()])
      : await db.one('select id, tenant_id, password_hash, is_active, account_status from users where phone = $1', [digits]);
    if (u?.account_status === 'invitationPending') {
      throw unauthorized('Your invitation is not accepted yet. Choose "I have an invite code" to set your password.');
    }
    if (!u || !(await verifyPassword(pwd, u.password_hash))) throw unauthorized('Wrong phone/email or password');
    if (!u.is_active) throw unauthorized('Your account is inactive. Contact your tuition admin.');
    res.json({ token: tokenFor(u) });
  });

  /** Staff set their own password using the invite code the admin shared. */
  r.post('/accept-invite', async (req, res) => {
    const staffPhone = phone(req.body, 'phone');
    const code = str(req.body, 'code', { max: 20 }).toUpperCase().replace(/\s/g, '');
    const pwd = password(req.body);
    const u = await db.one(
      `select id, tenant_id, invite_code from users where phone = $1 and account_status = 'invitationPending'`,
      [staffPhone],
    );
    if (!u || u.invite_code !== code) throw unauthorized('Invite code or phone number is incorrect');
    await db.query(
      `update users set password_hash = $2, account_status = 'active', invite_code = null where id = $1`,
      [u.id, await hashPassword(pwd)],
    );
    res.json({ token: tokenFor(u) });
  });

  return r;
}
