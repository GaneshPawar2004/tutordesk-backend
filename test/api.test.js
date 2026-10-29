import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, test } from 'node:test';

import { createApp } from '../src/app.js';
import { createDb } from '../src/db/index.js';
import { migrate } from '../src/db/schema.js';
import { signToken } from '../src/lib/token.js';

try {
  process.loadEnvFile('.env');
} catch {
  /* CI may provide env vars directly */
}

// Each run uses its own throwaway Postgres schema, dropped afterwards.
const SCHEMA = `test_${randomBytes(4).toString('hex')}`;
const url = process.env.DATABASE_URL ?? process.env.NEON_DB_URL;
let db, app, server, base;
const phoneNo = () => `9${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`;

async function call(path, { token, method = 'GET', body } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}
const ok = (r, status = 200) => {
  assert.equal(r.status, status, JSON.stringify(r.body));
  return r.body;
};

// Shared fixture built through the public API, like a real tuition would.
const fx = {};

before(async () => {
  const admin = createDb({ url });
  await admin.query(`create schema "${SCHEMA}"`);
  await admin.close();
  db = createDb({ url, schema: SCHEMA });
  await migrate(db);
  app = createApp({ db, secret: 'test-secret', smsSpeed: 1000 });
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://localhost:${server.address().port}`;

  fx.adminPhone = phoneNo();
  fx.admin = ok(await call('/api/auth/register', { method: 'POST', body: { tuitionName: 'Test Classes', city: 'Pune', adminName: 'Asha Admin', phone: fx.adminPhone, password: 'secret123' } }), 201).token;
  const me = ok(await call('/api/me', { token: fx.admin }));
  fx.yearId = me.currentYearId;
  const subjects = ok(await call('/api/subjects', { token: fx.admin }));
  fx.math = subjects.find((s) => s.name === 'Mathematics').id;
  fx.class5 = ok(await call('/api/classes', { token: fx.admin, method: 'POST', body: { name: 'Class 5', grade: 5, sessionLabel: '4–5 PM', subjectIds: [fx.math] } }), 201).id;
  fx.class6 = ok(await call('/api/classes', { token: fx.admin, method: 'POST', body: { name: 'Class 6', grade: 6, subjectIds: [fx.math] } }), 201).id;
  fx.students = [];
  for (const [i, name] of ['Ganesh Pawar', 'Priya Patil', 'Aarav Sharma'].entries()) {
    const [firstName, lastName] = name.split(' ');
    const r = ok(await call('/api/students', { token: fx.admin, method: 'POST', body: {
      firstName, lastName, dateOfBirth: '2016-04-0' + (i + 1), parentName: `Parent ${lastName}`, parentPhone: phoneNo(),
      yearId: fx.yearId, classId: fx.class5,
      fee: { annualFee: 12000, installmentCount: 6, frequency: 'monthly', firstDueDate: '2026-06-15', initialAmount: 2000, method: 'cash' },
    } }), 201);
    fx.students.push(r.student.id);
  }
  // Staff member assigned to Class 5 only, with an invite code.
  fx.staffPhone = phoneNo();
  const staff = ok(await call('/api/staff', { token: fx.admin, method: 'POST', body: { name: 'Sneha Kulkarni', phone: fx.staffPhone, designation: 'Maths teacher', assignedClassIds: [fx.class5] } }), 201);
  fx.staffId = staff.id;
  fx.inviteCode = staff.inviteCode;
});

after(async () => {
  app?.locals.close();
  server?.close();
  await db?.close();
  const admin = createDb({ url });
  await admin.query(`drop schema if exists "${SCHEMA}" cascade`);
  await admin.close();
});

describe('accounts', () => {
  test('register rejects duplicates; login works by phone; wrong password fails', async () => {
    const dup = await call('/api/auth/register', { method: 'POST', body: { tuitionName: 'Other', adminName: 'X Y', phone: fx.adminPhone, password: 'secret123' } });
    assert.equal(dup.status, 409);
    assert.equal((await call('/api/auth/login', { method: 'POST', body: { identifier: fx.adminPhone, password: 'nope-nope' } })).status, 401);
    ok(await call('/api/auth/login', { method: 'POST', body: { identifier: `+91 ${fx.adminPhone}`, password: 'secret123' } }));
  });

  test('student IDs are sequential per tuition', () => {
    assert.deepEqual(fx.students, ['STU-0001', 'STU-0002', 'STU-0003']);
  });

  test('staff accept invite, then log in; tampered tokens rejected', async () => {
    assert.equal((await call('/api/auth/login', { method: 'POST', body: { identifier: fx.staffPhone, password: 'whatever1' } })).status, 401);
    assert.equal((await call('/api/auth/accept-invite', { method: 'POST', body: { phone: fx.staffPhone, code: 'WRONG1', password: 'teacher123' } })).status, 401);
    fx.staff = ok(await call('/api/auth/accept-invite', { method: 'POST', body: { phone: fx.staffPhone, code: fx.inviteCode, password: 'teacher123' } })).token;
    ok(await call('/api/auth/login', { method: 'POST', body: { identifier: fx.staffPhone, password: 'teacher123' } }));
    assert.equal((await call('/api/me', { token: `${fx.staff}x` })).status, 401);
    const forged = signToken({ tenantId: 'x', userId: fx.staffId }, 'other-secret');
    assert.equal((await call('/api/me', { token: forged })).status, 401);
  });
});

describe('isolation and permissions', () => {
  test('another tuition cannot see this tuition\'s data', async () => {
    const other = ok(await call('/api/auth/register', { method: 'POST', body: { tuitionName: 'Rival Classes', adminName: 'Ravi R', phone: phoneNo(), password: 'secret123' } }), 201).token;
    assert.equal((await call('/api/students', { token: other })).body.length, 0);
    assert.equal((await call(`/api/students/${fx.students[0]}`, { token: other })).status, 404);
    const foreignRoster = await call(`/api/attendance/classes/${fx.class5}/roster`, { token: other });
    assert.equal(foreignRoster.body.students?.length ?? 0, 0, 'must not see another tuition students');
    const sync = ok(await call('/api/sync', { token: other }));
    assert.equal(sync.students.length, 0);
    assert.equal(sync.classes.length, 0);
  });

  test('staff: 403 on fees, no fee data in sync, only own classes', async () => {
    for (const p of ['/api/fees/summary', '/api/fees/students', '/api/staff']) assert.equal((await call(p, { token: fx.staff })).status, 403, p);
    const sync = ok(await call('/api/sync', { token: fx.staff }));
    assert.equal(sync.feePlans.length, 0);
    assert.equal(sync.payments.length, 0);
    assert.ok(sync.staff.every((s) => s.inviteCode === null));
    assert.equal((await call(`/api/attendance/classes/${fx.class6}/roster`, { token: fx.staff })).status, 403);
  });

  test('permission revocation applies on the next request', async () => {
    ok(await call(`/api/staff/${fx.staffId}/permissions`, { token: fx.admin, method: 'PUT', body: { permissions: ['viewStudents', 'markAttendance', 'viewExamResults', 'enterMarks', 'sendParentMessages', 'sendSms'] } }));
    assert.equal(ok(await call('/api/me', { token: fx.staff })).canSendMessages, true);
    ok(await call(`/api/staff/${fx.staffId}/permissions`, { token: fx.admin, method: 'PUT', body: { permissions: ['viewStudents', 'markAttendance', 'viewExamResults', 'enterMarks', 'sendParentMessages'] } }));
    assert.equal(ok(await call('/api/me', { token: fx.staff })).canSendMessages, false);
    assert.equal((await call('/api/staff/x/permissions', { token: fx.admin, method: 'PUT', body: { permissions: ['viewFees'] } })).status, 400);
  });
});

describe('attendance and messaging', () => {
  test('one session per class per day (even if submitted at the same time); audited correction', async () => {
    const roster = ok(await call(`/api/attendance/classes/${fx.class5}/roster`, { token: fx.staff })).students;
    const records = Object.fromEntries(roster.map((s, i) => [s.id, i === 0 ? 'absent' : 'present']));
    const [a, b] = await Promise.all([
      call('/api/attendance/sessions', { token: fx.staff, method: 'POST', body: { classId: fx.class5, records } }),
      call('/api/attendance/sessions', { token: fx.admin, method: 'POST', body: { classId: fx.class5, records } }),
    ]);
    assert.deepEqual([a.status, b.status].sort(), [201, 409]);
    fx.sessionId = (a.status === 201 ? a : b).body.id ?? (a.status === 201 ? a.body.id : b.body.error.details.session.id);
    assert.equal((await call(`/api/attendance/sessions/${fx.sessionId}`, { token: fx.staff, method: 'PATCH', body: { note: 'x', records: {} } })).status, 403);
    const fixed = ok(await call(`/api/attendance/sessions/${fx.sessionId}`, { token: fx.admin, method: 'PATCH', body: { note: 'Came late', records: { [roster[0].id]: 'late' } } }));
    assert.equal(fixed.counts.late, 1);
    assert.match(fixed.audit[0].note, /1 record changed/);
  });

  test('notification batch is idempotent; retry resends failures only', async () => {
    const first = ok(await call(`/api/messages/attendance/${fx.sessionId}`, { token: fx.admin, method: 'POST', body: { statuses: ['present', 'absent', 'late', 'leave'] } }), 201);
    const again = ok(await call(`/api/messages/attendance/${fx.sessionId}`, { token: fx.admin, method: 'POST', body: {} }));
    assert.equal(again.created, false);
    assert.equal(again.batch.id, first.batch.id);
    await new Promise((r) => setTimeout(r, 400));
    const settled = ok(await call(`/api/messages/batches/${first.batch.id}`, { token: fx.admin }));
    assert.equal(settled.stats.pending, 0);
    const okAttempts = Object.fromEntries(settled.recipients.filter((x) => x.status !== 'failed').map((x) => [x.id, x.attempts]));
    ok(await call(`/api/messages/batches/${first.batch.id}/retry`, { token: fx.admin, method: 'POST' }));
    await new Promise((r) => setTimeout(r, 400));
    const done = ok(await call(`/api/messages/batches/${first.batch.id}`, { token: fx.admin }));
    assert.equal(done.stats.failed, 0);
    for (const x of done.recipients) if (x.id in okAttempts) assert.equal(x.attempts, okAttempts[x.id]);
  });
});

describe('fees, exams, promotion', () => {
  test('payments append and cannot exceed the balance', async () => {
    const fee = ok(await call(`/api/students/${fx.students[0]}/fees`, { token: fx.admin }))[0];
    assert.equal(fee.summary.agreed, 12000);
    assert.equal(fee.summary.paid, 2000);
    assert.equal((await call('/api/fees/payments', { token: fx.admin, method: 'POST', body: { enrollmentId: fee.enrollmentId, amount: 10001, method: 'upi' } })).status, 400);
    const paid = ok(await call('/api/fees/payments', { token: fx.admin, method: 'POST', body: { enrollmentId: fee.enrollmentId, amount: 1500, method: 'upi' } }), 201);
    assert.equal(paid.summary.outstanding, 8500);
  });

  test('exam totals computed from marks; validation; publish; correction bumps revision', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const exam = ok(await call('/api/exams', { token: fx.staff, method: 'POST', body: { name: 'Weekly Test', classId: fx.class5, date: today, subjects: [{ subjectId: fx.math, maxMarks: 50 }] } }), 201);
    assert.equal((await call(`/api/exams/${exam.id}/marks/${fx.math}`, { token: fx.staff, method: 'PUT', body: { entries: { [fx.students[0]]: { marks: 51 } } } })).status, 400);
    assert.equal((await call(`/api/exams/${exam.id}/publish`, { token: fx.staff, method: 'POST' })).status, 400);
    ok(await call(`/api/exams/${exam.id}/marks/${fx.math}`, { token: fx.staff, method: 'PUT', body: { entries: { [fx.students[0]]: { marks: 42 }, [fx.students[1]]: { absent: true }, [fx.students[2]]: { marks: 36 } } } }));
    ok(await call(`/api/exams/${exam.id}/publish`, { token: fx.staff, method: 'POST' }));
    const d = ok(await call(`/api/exams/${exam.id}`, { token: fx.admin }));
    const g = d.results.find((x) => x.studentId === fx.students[0]);
    assert.equal(g.obtained, 42);
    assert.equal(g.percent, 84);
    assert.equal(d.results.find((x) => x.studentId === fx.students[1]).subjects[0].absent, true);
    assert.equal((await call(`/api/exams/${exam.id}/marks/${fx.math}`, { token: fx.admin, method: 'PUT', body: { entries: { [fx.students[0]]: { marks: 43 } } } })).status, 400);
    assert.equal(ok(await call(`/api/exams/${exam.id}/marks/${fx.math}`, { token: fx.admin, method: 'PUT', body: { entries: { [fx.students[0]]: { marks: 43 } }, correctionNote: 'Re-totalled' } })).revision, 1);
  });

  test('promotion adds an enrollment; keeps ID and last year\'s fee; no duplicates', async () => {
    const next = ok(await call('/api/academic-years', { token: fx.admin, method: 'POST', body: { label: 'Next year', startDate: '2099-06-01', endDate: '2100-04-30' } }), 201);
    const body = { fromYearId: fx.yearId, toYearId: next.id, toClassId: fx.class6, studentIds: [fx.students[0]], annualFee: 13000, installments: 4 };
    assert.equal(ok(await call('/api/promotions', { token: fx.admin, method: 'POST', body }), 201).promoted.length, 1);
    assert.deepEqual(ok(await call('/api/promotions', { token: fx.admin, method: 'POST', body }), 201).skipped, [fx.students[0]]);
    const fees = ok(await call(`/api/students/${fx.students[0]}/fees`, { token: fx.admin }));
    assert.deepEqual(fees.map((f) => f.plan?.annualFee), [12000, 13000]);
  });
});
