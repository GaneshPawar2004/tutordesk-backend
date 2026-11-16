const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/db');
const { api, setup, teardown, auth, registerOwner } = require('./helpers');

const ADMIN = { 'x-admin-key': 'test-admin-key' };
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());

describe('fixes: attendance, absence SMS, permissions, payments, admin', () => {
  let owner;
  let H; // owner
  let S; // staff without fee access
  let classId;
  let ravi;
  let sita;
  let mohan;

  before(async () => {
    await setup();
    owner = await registerOwner('fixes@example.com', '9855550000');
    H = auth(owner.token);
    await api()
      .post('/api/v1/users')
      .set(H)
      .send({ name: 'Staff', email: 'fstaff@example.com', password: 'secret1' })
      .expect(201);
    S = auth(
      (await api().post('/api/v1/auth/login').send({ identifier: 'fstaff@example.com', password: 'secret1' })).body
        .token,
    );
    classId = (await api().post('/api/v1/classes').set(H).send({ name: 'Class 9' })).body.class.id;
    const add = async (name, mobile) =>
      (
        await api()
          .post(`/api/v1/classes/${classId}/students`)
          .set(H)
          .send({ name, parentMobile: mobile, totalFees: 1000 })
      ).body.student;
    ravi = await add('Ravi', '9811100001');
    sita = await add('Sita', '9811100002');
    mohan = await add('Mohan', '');
  });
  after(teardown);

  const recs = (absentIds) =>
    [ravi, sita, mohan].map((s) => ({ student: s.id, status: absentIds.includes(s.id) ? 'absent' : 'present' }));
  const smsList = (who = S) => api().post(`/api/v1/classes/${classId}/attendance/sms`).set(who).send({ date: today });

  it('absence SMS only from saved attendance; nothing before saving', async () => {
    const res = await smsList().expect(200);
    assert.equal(res.body.messages.length, 0);
    // The old way (a hand-made "absent" list) is refused.
    await api()
      .post('/api/v1/sms/batches')
      .set(S)
      .send({ kind: 'absent', title: 'x', messages: [{ name: 'a', phone: '9800000000', body: 'b' }] })
      .expect(400);
  });

  it('saves with a version; a second phone with an old version is refused', async () => {
    const first = await api()
      .put(`/api/v1/classes/${classId}/attendance`)
      .set(S)
      .send({ date: today, records: recs([ravi.id, mohan.id]), version: null })
      .expect(200);
    assert.equal(first.body.version, 1);
    assert.equal(first.body.savedBy, 'Staff');
    // Another phone loaded the day before it was saved (version null).
    const stale = await api()
      .put(`/api/v1/classes/${classId}/attendance`)
      .set(H)
      .send({ date: today, records: recs([]), version: null })
      .expect(409);
    assert.equal(stale.body.error.code, 'ATTENDANCE_CHANGED');
  });

  it('one SMS per absent student per day; asking again adds only new absentees', async () => {
    const a = await smsList().expect(200);
    assert.deepEqual(
      a.body.messages.map((m) => m.name),
      ['Ravi'],
    );
    assert.deepEqual(a.body.noNumber, ['Mohan']);
    const [m] = a.body.messages;
    await api().post('/api/v1/sms/claim').set(S).send({ ids: [m.id], limit: 1 }).expect(200);
    await api().post(`/api/v1/sms/${m.id}/report`).set(S).send({ status: 'sent' }).expect(200);

    // Tapping again: Ravi is not added twice.
    const again = await smsList(H).expect(200);
    assert.equal(again.body.messages.length, 1);
    assert.equal(again.body.messages[0].status, 'sent');
    assert.equal(again.body.batch, a.body.batch);

    // Sita is marked absent later → only Sita is new.
    const day = await api().get(`/api/v1/classes/${classId}/attendance?date=${today}`).set(H).expect(200);
    await api()
      .put(`/api/v1/classes/${classId}/attendance`)
      .set(H)
      .send({ date: today, records: recs([ravi.id, sita.id, mohan.id]), version: day.body.version })
      .expect(200);
    const third = await smsList(H).expect(200);
    assert.deepEqual(
      third.body.messages.map((x) => `${x.name}:${x.status}`),
      ['Ravi:sent', 'Sita:pending'],
    );
    const loaded = await api().get(`/api/v1/classes/${classId}/attendance?date=${today}`).set(H).expect(200);
    assert.equal(loaded.body.records.find((r) => r.student === ravi.id).sms, 'sent');
  });

  it('changing a saved mark is recorded; a waiting absence SMS is stopped', async () => {
    const day = await api().get(`/api/v1/classes/${classId}/attendance?date=${today}`).set(H).expect(200);
    const res = await api()
      .put(`/api/v1/classes/${classId}/attendance`)
      .set(H)
      .send({ date: today, records: recs([ravi.id, mohan.id]), version: day.body.version })
      .expect(200);
    const change = res.body.changes.find((c) => c.student === sita.id);
    assert.equal(change.from, 'absent');
    assert.equal(change.to, 'present');
    assert.equal(change.by, 'Asha Patil');
    // Sita's unsent absence SMS no longer goes out.
    assert.equal(res.body.records.find((r) => r.student === sita.id).sms, 'dismissed');
    const list = await smsList(H).expect(200);
    assert.deepEqual(
      list.body.messages.map((x) => x.name),
      ['Ravi'],
    );
  });

  it('re-saving keeps records of students disabled since', async () => {
    await api().patch(`/api/v1/students/${mohan.id}`).set(H).send({ disabled: true }).expect(200);
    const day = await api().get(`/api/v1/classes/${classId}/attendance?date=${today}`).set(H).expect(200);
    assert.equal(day.body.records.length, 2); // Mohan is hidden while disabled
    await api()
      .put(`/api/v1/classes/${classId}/attendance`)
      .set(H)
      .send({
        date: today,
        records: day.body.records.map((r) => ({ student: r.student, status: r.status })),
        version: day.body.version,
      })
      .expect(200);
    const hist = await api().get(`/api/v1/students/${mohan.id}/attendance`).set(H).expect(200);
    assert.equal(hist.body.history.length, 1);
    assert.equal(hist.body.history[0].status, 'absent');
    await api().patch(`/api/v1/students/${mohan.id}`).set(H).send({ disabled: false }).expect(200);
  });

  it('fee SMS lists are hidden from staff without fee access', async () => {
    const fees = await api()
      .post('/api/v1/sms/batches')
      .set(H)
      .send({
        kind: 'fees',
        title: 'Fee reminders',
        key: `fees:${classId}:${today}`,
        messages: [{ student: ravi.id, name: 'Ravi', phone: '9811100001', body: '₹1000 pending' }],
      })
      .expect(201);
    const staffList = await api().get('/api/v1/sms/batches').set(S).expect(200);
    assert.ok(staffList.body.batches.every((b) => b.kind !== 'fees'));
    await api().get(`/api/v1/sms/batches/${fees.body.batch}`).set(S).expect(404);
    const claim = await api().post('/api/v1/sms/claim').set(S).send({ batch: fees.body.batch }).expect(200);
    assert.equal(claim.body.messages.length, 0);
    await api()
      .post('/api/v1/sms/batches')
      .set(S)
      .send({ kind: 'fees', title: 'x', messages: [{ name: 'a', phone: '9800000000', body: 'b' }] })
      .expect(403);
    // Same key again → same list, no duplicate message.
    const again = await api()
      .post('/api/v1/sms/batches')
      .set(H)
      .send({
        kind: 'fees',
        title: 'Fee reminders',
        key: `fees:${classId}:${today}`,
        messages: [{ student: ravi.id, name: 'Ravi', phone: '9811100001', body: '₹1000 pending' }],
      })
      .expect(201);
    assert.equal(again.body.batch, fees.body.batch);
    assert.equal(again.body.messages.length, 1);
  });

  it('a message claimed by another phone cannot be reported; STOP halts the sender', async () => {
    const b = await api()
      .post('/api/v1/sms/batches')
      .set(H)
      .send({
        kind: 'other',
        title: 'Notice',
        messages: [
          { name: 'A', phone: '9800000001', body: 'Hi' },
          { name: 'B', phone: '9800000002', body: 'Hi' },
        ],
      })
      .expect(201);
    const claimed = await api().post('/api/v1/sms/claim').set(S).send({ batch: b.body.batch, limit: 2 }).expect(200);
    const [m1, m2] = claimed.body.messages;
    // The owner opens WhatsApp for a message the staff phone is sending.
    const clash = await api()
      .post(`/api/v1/sms/${m1.id}/report`)
      .set(H)
      .send({ status: 'sent', channel: 'whatsapp' })
      .expect(409);
    assert.equal(clash.body.error.code, 'SENDING_ELSEWHERE');

    await api().post(`/api/v1/sms/batches/${b.body.batch}/dismiss`).set(H).expect(204);
    // The staff phone had just sent m1: recorded as sent, and told to stop.
    const r1 = await api().post(`/api/v1/sms/${m1.id}/report`).set(S).send({ status: 'sent' }).expect(200);
    assert.equal(r1.body.stop, true);
    assert.equal(r1.body.message.status, 'sent');
    // A failure on a stopped message keeps it stopped.
    const r2 = await api().post(`/api/v1/sms/${m2.id}/report`).set(S).send({ status: 'failed' }).expect(200);
    assert.equal(r2.body.message.status, 'dismissed');
  });

  it('deleting a student stops their waiting SMS', async () => {
    const extra = (
      await api().post(`/api/v1/classes/${classId}/students`).set(H).send({ name: 'Gone', parentMobile: '9811100009' })
    ).body.student;
    const b = await api()
      .post('/api/v1/sms/batches')
      .set(H)
      .send({ kind: 'other', title: 'N', messages: [{ student: extra.id, name: 'Gone', phone: '9811100009', body: 'x' }] })
      .expect(201);
    await api().delete(`/api/v1/students/${extra.id}`).set(H).expect(204);
    const detail = await api().get(`/api/v1/sms/batches/${b.body.batch}`).set(H).expect(200);
    assert.equal(detail.body.messages[0].status, 'dismissed');
  });

  it('a repeated payment is saved once; the admin can delete a wrong one', async () => {
    const pay = () =>
      api()
        .post(`/api/v1/students/${sita.id}/fees/payments`)
        .set(H)
        .send({ amount: 300, clientRef: 'ref-12345678' });
    await pay().expect(201);
    const retry = await pay().expect(200);
    assert.equal(retry.body.student.feesPaid, 300);
    const list = await api().get(`/api/v1/students/${sita.id}/fees/payments`).set(H).expect(200);
    assert.equal(list.body.payments.length, 1);

    await api().delete(`/api/v1/students/${sita.id}/fees/payments/${list.body.payments[0].id}`).set(S).expect(403);
    const del = await api()
      .delete(`/api/v1/students/${sita.id}/fees/payments/${list.body.payments[0].id}`)
      .set(H)
      .expect(200);
    assert.equal(del.body.student.feesPaid, 0);
  });

  it('admin: allow adds to a running plan; +7 trial does not undo Allow', async () => {
    const url = `/api/v1/admin/institutes/${owner.institute.id}`;
    const a = await api().patch(url).set(ADMIN).send({ action: 'allow', days: 30 }).expect(200);
    const until1 = new Date(a.body.institute.accessUntil).getTime();
    const b = await api().patch(url).set(ADMIN).send({ action: 'allow', days: 30 }).expect(200);
    const until2 = new Date(b.body.institute.accessUntil).getTime();
    assert.ok(Math.abs(until2 - until1 - 30 * 86400000) < 5000);
    await api().patch(url).set(ADMIN).send({ extendTrialDays: 7 }).expect(400);
    const still = await api().get('/api/v1/admin/institutes').set(ADMIN).expect(200);
    assert.equal(still.body.institutes.find((i) => i.id === owner.institute.id).status, 'active');
    // A wrong key of odd bytes is a 401, not a crash.
    await api().get('/api/v1/admin/institutes').set('x-admin-key', 'é'.repeat(7)).expect(401);
  });

  it('blocked staff are signed out with ACCOUNT_BLOCKED', async () => {
    const users = await api().get('/api/v1/users').set(H).expect(200);
    await api().patch(`/api/v1/users/${users.body.users[0].id}`).set(H).send({ active: false }).expect(200);
    const res = await api().get('/api/v1/classes').set(S).expect(403);
    assert.equal(res.body.error.code, 'ACCOUNT_BLOCKED');
    await db.query('select 1');
  });
});
