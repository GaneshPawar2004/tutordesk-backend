const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/db');
const { api, setup, teardown, auth, registerOwner } = require('./helpers');

describe('parent SMS queue', () => {
  let H; // owner
  let S; // staff
  let classId;
  let batchId;

  const list = (n) =>
    Array.from({ length: n }, (_, i) => ({
      name: `Student ${i + 1}`,
      phone: `98${String(i).padStart(8, '0')}`,
      body: `Dear Parent, Student ${i + 1} was absent today.`,
    }));

  before(async () => {
    await setup();
    const owner = await registerOwner('sms@example.com', '9833330000');
    H = auth(owner.token);
    await api()
      .post('/api/v1/users')
      .set(H)
      .send({ name: 'Staff Four', email: 'staff4@example.com', password: 'secret1' })
      .expect(201);
    const login = await api()
      .post('/api/v1/auth/login')
      .send({ identifier: 'staff4@example.com', password: 'secret1' })
      .expect(200);
    S = auth(login.body.token);
    const c = await api().post('/api/v1/classes').set(H).send({ name: 'Class 10' }).expect(201);
    classId = c.body.class.id;
  });
  after(teardown);

  it('staff sends 100 of 120; the 20 left show as remaining for everyone', async () => {
    const created = await api()
      .post('/api/v1/sms/batches')
      .set(S)
      .send({ kind: 'absent', title: 'Class 10 · Absent on 03-11-2026', classId, messages: list(120) })
      .expect(201);
    batchId = created.body.batch;
    assert.equal(created.body.messages.length, 120);

    // The phone has 100 SMS left today: claim 100, send them.
    const claim = await api().post('/api/v1/sms/claim').set(S).send({ batch: batchId, limit: 100 }).expect(200);
    assert.equal(claim.body.messages.length, 100);
    assert.equal(claim.body.messages[0].name, 'Student 1');
    for (const m of claim.body.messages) {
      await api().post(`/api/v1/sms/${m.id}/report`).set(S).send({ status: 'sent' }).expect(200);
    }

    const batches = await api().get('/api/v1/sms/batches').set(H).expect(200);
    const b = batches.body.batches[0];
    assert.equal(b.total, 120);
    assert.equal(b.sent, 100);
    assert.equal(b.remaining, 20);
    assert.equal(b.className, 'Class 10');
    assert.deepEqual(b.senders, [{ name: 'Staff Four', count: 100 }]);

    const detail = await api().get(`/api/v1/sms/batches/${batchId}`).set(H).expect(200);
    const unsent = detail.body.messages.filter((m) => m.status !== 'sent').map((m) => m.name);
    assert.equal(unsent.length, 20);
    assert.equal(unsent[0], 'Student 101');
  });

  it('two phones never get the same messages; released ones go back', async () => {
    const a = await api().post('/api/v1/sms/claim').set(H).send({ batch: batchId, limit: 15 }).expect(200);
    assert.equal(a.body.messages.length, 15);
    const b = await api().post('/api/v1/sms/claim').set(S).send({ batch: batchId, limit: 100 }).expect(200);
    assert.equal(b.body.messages.length, 5); // only the 5 not reserved by the owner
    const overlap = b.body.messages.filter((m) => a.body.messages.some((x) => x.id === m.id));
    assert.equal(overlap.length, 0);

    // Owner sends 10, one fails, then gives back the other 4.
    for (const m of a.body.messages.slice(0, 10)) {
      await api().post(`/api/v1/sms/${m.id}/report`).set(H).send({ status: 'sent' }).expect(200);
    }
    await api()
      .post(`/api/v1/sms/${a.body.messages[10].id}/report`)
      .set(H)
      .send({ status: 'failed', reason: 'No mobile network' })
      .expect(200);
    await api()
      .post('/api/v1/sms/release')
      .set(H)
      .send({ ids: a.body.messages.slice(11).map((m) => m.id) })
      .expect(204);
    await api()
      .post('/api/v1/sms/release')
      .set(S)
      .send({ ids: b.body.messages.map((m) => m.id) })
      .expect(204);

    const again = await api().post('/api/v1/sms/claim').set(S).send({ batch: batchId, limit: 100 }).expect(200);
    assert.equal(again.body.messages.length, 10); // 4 released + 5 released + 1 failed
    await api().post('/api/v1/sms/release').set(S).send({ ids: again.body.messages.map((m) => m.id) }).expect(204);

    const batches = await api().get('/api/v1/sms/batches').set(H).expect(200);
    assert.equal(batches.body.batches[0].remaining, 10);
    assert.equal(batches.body.batches[0].failed, 1);

    // A sent message cannot be reported again.
    await api().post(`/api/v1/sms/${a.body.messages[0].id}/report`).set(S).send({ status: 'failed' }).expect(404);
  });

  it('dismiss and expiry stop the rest', async () => {
    await api().post(`/api/v1/sms/batches/${batchId}/dismiss`).set(H).expect(204);
    let batches = await api().get('/api/v1/sms/batches').set(H).expect(200);
    assert.equal(batches.body.batches[0].remaining, 0);
    assert.equal(batches.body.batches[0].dismissed, 10);

    const old = await api()
      .post('/api/v1/sms/batches')
      .set(H)
      .send({ kind: 'fees', title: 'Old reminders', messages: list(3) })
      .expect(201);
    await db.query("update sms_batches set created_at = now() - interval '3 days' where id = $1", [old.body.batch]);
    batches = await api().get('/api/v1/sms/batches').set(H).expect(200);
    const expired = batches.body.batches.find((b) => b.id === old.body.batch);
    assert.equal(expired.remaining, 0);
    assert.equal(expired.expired, true);
    const claim = await api().post('/api/v1/sms/claim').set(H).send({ batch: old.body.batch }).expect(200);
    assert.equal(claim.body.messages.length, 0);
  });

  it('rejects students of another institute', async () => {
    const other = await registerOwner('other-sms@example.com', '9844440000');
    const O = auth(other.token);
    const c = await api().post('/api/v1/classes').set(O).send({ name: 'X' }).expect(201);
    const st = await api().post(`/api/v1/classes/${c.body.class.id}/students`).set(O).send({ name: 'Y' }).expect(201);
    await api()
      .post('/api/v1/sms/batches')
      .set(H)
      .send({ title: 'Bad', messages: [{ student: st.body.student.id, name: 'Y', phone: '9800000000', body: 'Hi' }] })
      .expect(400);
  });
});
