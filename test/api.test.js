import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { createApp } from '../src/app.js';
import { signToken } from '../src/lib/token.js';

let server;
let app;
let base;

async function call(path, { token, method = 'GET', body } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function login(role, staffId) {
  const r = await call('/api/auth/demo-login', { method: 'POST', body: { role, staffId } });
  assert.equal(r.status, 200);
  return r.body.token;
}

before(async () => {
  app = createApp({ secret: 'test-secret', simulateSms: true, smsSpeed: 1000 });
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  base = `http://localhost:${server.address().port}`;
});

after(() => {
  app.locals.close();
  server.close();
});

describe('auth', () => {
  test('rejects missing, tampered and foreign-secret tokens', async () => {
    assert.equal((await call('/api/me')).status, 401);
    const good = await login('admin');
    assert.equal((await call('/api/me', { token: `${good}x` })).status, 401);
    const foreign = signToken({ tenantId: 'tui-1', role: 'admin' }, 'other-secret');
    assert.equal((await call('/api/me', { token: foreign })).status, 401);
  });
});

describe('role enforcement on the server', () => {
  test('staff get 403 from every fee endpoint and never see fee figures', async () => {
    const staff = await login('staff', 'stf-1');
    for (const path of ['/api/fees/summary', '/api/fees/students', '/api/fees/enrollments/enr-1', '/api/students/STU-0001/fees']) {
      assert.equal((await call(path, { token: staff })).status, 403, path);
    }
    const pay = await call('/api/fees/payments', { token: staff, method: 'POST', body: { enrollmentId: 'enr-1', amount: 1, method: 'cash' } });
    assert.equal(pay.status, 403);
    const dash = await call('/api/dashboard', { token: staff });
    assert.equal(dash.body.fees, undefined);
    const profile = await call('/api/students/STU-0001', { token: staff });
    assert.equal(profile.status, 200);
    assert.ok(profile.body.enrollments.every((e) => e.fees === undefined));
  });

  test('staff only see their assigned classes', async () => {
    const sneha = await login('staff', 'stf-1'); // Classes 5, 6, 7
    const list = await call('/api/students', { token: sneha });
    assert.ok(list.body.length > 0);
    assert.ok(list.body.every((s) => ['cls-5', 'cls-6', 'cls-7'].includes(s.classId)));
    const class10 = await call('/api/students?classId=cls-10', { token: sneha });
    assert.equal(class10.body.length, 0);
    const att = await call('/api/attendance/sessions', { token: sneha, method: 'POST', body: { classId: 'cls-10', records: {} } });
    assert.equal(att.status, 403);
  });

  test('permission changes apply on the very next request', async () => {
    const admin = await login('admin');
    const sneha = await login('staff', 'stf-1');
    const before = await call('/api/me', { token: sneha });
    assert.equal(before.body.canSendMessages, true);
    const member = (await call('/api/staff/stf-1', { token: admin })).body;
    const without = member.permissions.filter((p) => p !== 'sendSms');
    assert.equal((await call('/api/staff/stf-1/permissions', { token: admin, method: 'PUT', body: { permissions: without } })).status, 200);
    const now = await call('/api/me', { token: sneha });
    assert.equal(now.body.canSendMessages, false);
    const send = await call('/api/messages/announcements', {
      token: sneha, method: 'POST', body: { draftKey: 'x', title: 'Test', body: 'This should be blocked.' },
    });
    assert.equal(send.status, 403);
    // Financial permissions are not grantable at all.
    const bad = await call('/api/staff/stf-1/permissions', { token: admin, method: 'PUT', body: { permissions: ['viewFees'] } });
    assert.equal(bad.status, 400);
    await call('/api/staff/stf-1/permissions', { token: admin, method: 'PUT', body: { permissions: member.permissions } });
  });
});

describe('attendance', () => {
  test('a session can only be submitted once; correction needs admin + note', async () => {
    const admin = await login('admin');
    const sneha = await login('staff', 'stf-1');
    const rosterRes = await call('/api/attendance/classes/cls-7/roster', { token: sneha });
    const records = Object.fromEntries(rosterRes.body.students.map((s) => [s.id, 'present']));

    const incomplete = await call('/api/attendance/sessions', { token: sneha, method: 'POST', body: { classId: 'cls-7', records: {} } });
    assert.equal(incomplete.status, 400);

    const first = await call('/api/attendance/sessions', { token: sneha, method: 'POST', body: { classId: 'cls-7', records } });
    assert.equal(first.status, 201);
    const second = await call('/api/attendance/sessions', { token: admin, method: 'POST', body: { classId: 'cls-7', records } });
    assert.equal(second.status, 409);
    assert.equal(second.body.error.details.session.markedBy, 'Sneha Kulkarni');

    const studentId = rosterRes.body.students[0].id;
    const staffFix = await call(`/api/attendance/sessions/${first.body.id}`, { token: sneha, method: 'PATCH', body: { note: 'x', records: { [studentId]: 'absent' } } });
    assert.equal(staffFix.status, 403);
    const noNote = await call(`/api/attendance/sessions/${first.body.id}`, { token: admin, method: 'PATCH', body: { records: { [studentId]: 'absent' } } });
    assert.equal(noNote.status, 400);
    const fix = await call(`/api/attendance/sessions/${first.body.id}`, { token: admin, method: 'PATCH', body: { note: 'Arrived after roll call', records: { [studentId]: 'absent' } } });
    assert.equal(fix.status, 200);
    assert.equal(fix.body.counts.absent, 1);
    assert.match(fix.body.audit[0].note, /1 record changed/);
  });
});

describe('messaging', () => {
  test('one batch per session; retry resends failures only', async () => {
    const admin = await login('admin');
    const today = await call('/api/attendance/today', { token: admin });
    const sessionId = today.body.classes.find((c) => c.session && c.classId === 'cls-5').session.id;
    const first = await call(`/api/messages/attendance/${sessionId}`, { token: admin, method: 'POST', body: { statuses: ['present', 'absent', 'late', 'leave'] } });
    assert.equal(first.status, 201);
    const again = await call(`/api/messages/attendance/${sessionId}`, { token: admin, method: 'POST', body: {} });
    assert.equal(again.status, 200);
    assert.equal(again.body.created, false);
    assert.equal(again.body.batch.id, first.body.batch.id);

    // Wait for the (sped-up) simulation to settle.
    await new Promise((r) => setTimeout(r, 300));
    const settled = (await call(`/api/messages/batches/${first.body.batch.id}`, { token: admin })).body;
    const okBefore = Object.fromEntries(settled.recipients.filter((r) => r.status !== 'failed').map((r) => [r.id, r.attempts]));
    const retry = await call(`/api/messages/batches/${first.body.batch.id}/retry`, { token: admin, method: 'POST' });
    assert.equal(retry.body.retried, settled.stats.failed);
    await new Promise((r) => setTimeout(r, 300));
    const finalBatch = (await call(`/api/messages/batches/${first.body.batch.id}`, { token: admin })).body;
    assert.equal(finalBatch.stats.failed, 0);
    for (const r of finalBatch.recipients) {
      if (r.id in okBefore) assert.equal(r.attempts, okBefore[r.id], 'successful recipients must not be resent');
    }
  });

  test('staff never see fee reminder batches', async () => {
    const sneha = await login('staff', 'stf-1');
    const list = await call('/api/messages/batches', { token: sneha });
    assert.ok(list.body.every((b) => b.category !== 'feeReminder'));
    assert.equal((await call('/api/messages/batches/bat-4', { token: sneha })).status, 404);
  });
});

describe('fees', () => {
  test('payments are appended and validated against the balance', async () => {
    const admin = await login('admin');
    const fee = (await call('/api/students/STU-0001/fees', { token: admin })).body.find((f) => f.yearLabel === '2026–27');
    assert.equal(fee.summary.agreed, 12000);
    const tooMuch = await call('/api/fees/payments', { token: admin, method: 'POST', body: { enrollmentId: fee.enrollmentId, amount: fee.summary.outstanding + 1, method: 'cash' } });
    assert.equal(tooMuch.status, 400);
    const ok = await call('/api/fees/payments', { token: admin, method: 'POST', body: { enrollmentId: fee.enrollmentId, amount: 500, method: 'upi' } });
    assert.equal(ok.status, 201);
    assert.equal(ok.body.summary.outstanding, fee.summary.outstanding - 500);
    const after = (await call(`/api/fees/enrollments/${fee.enrollmentId}`, { token: admin })).body;
    assert.equal(after.payments.length, fee.payments.length + 1);
  });
});

describe('promotion', () => {
  test('adds an enrollment, keeps the student and last year fee, never duplicates', async () => {
    const admin = await login('admin');
    const body = { fromYearId: 'ay-2026', toYearId: 'ay-2027', toClassId: 'cls-6', studentIds: ['STU-0002'], annualFee: 13000, installments: 4 };
    const r1 = await call('/api/promotions', { token: admin, method: 'POST', body });
    assert.equal(r1.status, 201);
    assert.equal(r1.body.promoted.length, 1);
    const r2 = await call('/api/promotions', { token: admin, method: 'POST', body });
    assert.deepEqual(r2.body.skipped, ['STU-0002']);
    const fees = (await call('/api/students/STU-0002/fees', { token: admin })).body;
    assert.equal(fees.find((f) => f.yearLabel === '2027–28').plan.annualFee, 13000);
    assert.equal(fees.find((f) => f.yearLabel === '2026–27').plan.annualFee, 12000);
    const profile = (await call('/api/students/STU-0002', { token: admin })).body;
    assert.equal(profile.student.id, 'STU-0002');
  });
});

describe('exams', () => {
  test('result totals are computed; marks are validated; publish requires all marks', async () => {
    const admin = await login('admin');
    const exam = (await call('/api/exams/exm-1', { token: admin })).body;
    const ganesh = exam.results.find((r) => r.studentId === 'STU-0001');
    assert.equal(ganesh.obtained, 126);
    assert.equal(ganesh.maxTotal, 150);
    assert.equal(ganesh.percent, 84);

    const tooHigh = await call('/api/exams/exm-2/marks/sub-math', { token: admin, method: 'PUT', body: { entries: { [exam.students[0].id]: { marks: 99 } } } });
    assert.equal(tooHigh.status, 400);
    const publish = await call('/api/exams/exm-2/publish', { token: admin, method: 'POST' });
    assert.equal(publish.status, 400);

    // Correcting published marks needs a note and bumps the revision.
    const noNote = await call('/api/exams/exm-1/marks/sub-eng', { token: admin, method: 'PUT', body: { entries: exam.marks['sub-eng'] } });
    assert.equal(noNote.status, 400);
    const fixed = await call('/api/exams/exm-1/marks/sub-eng', { token: admin, method: 'PUT', body: { entries: exam.marks['sub-eng'], correctionNote: 'Re-totalled' } });
    assert.equal(fixed.body.revision, 1);
  });
});
