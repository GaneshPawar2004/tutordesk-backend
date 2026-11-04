const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/db');
const { api, setup, teardown, auth, registerOwner } = require('./helpers');

const ADMIN = { 'x-admin-key': 'test-admin-key' };

describe('access control, admin page, account, photos', () => {
  let owner;
  let H;
  let staffH;
  let studentId;

  before(async () => {
    await setup();
    owner = await registerOwner('access@example.com', '9822220000');
    H = auth(owner.token);
    await api()
      .post('/api/v1/users')
      .set(H)
      .send({ name: 'Staff', email: 'staff1@example.com', password: 'secret1' })
      .expect(201);
    const login = await api()
      .post('/api/v1/auth/login')
      .send({ identifier: 'staff1@example.com', password: 'secret1' })
      .expect(200);
    staffH = auth(login.body.token);
    const c = await api().post('/api/v1/classes').set(H).send({ name: 'Class 1' }).expect(201);
    const st = await api()
      .post(`/api/v1/classes/${c.body.class.id}/students`)
      .set(H)
      .send({ name: 'Asha' })
      .expect(201);
    studentId = st.body.student.id;
  });
  after(teardown);

  it('reports trial access on sign-in', () => {
    assert.equal(owner.institute.access.status, 'trial');
    assert.equal(owner.institute.access.allowed, true);
    assert.equal(owner.institute.support.email, 'ganeshpawardev@gmail.com');
  });

  it('blocks owner and staff when the trial ends, until the admin allows', async () => {
    await db.query("update institutes set trial_ends_at = now() - interval '1 day' where id = $1", [
      owner.institute.id,
    ]);
    const blocked = await api().get('/api/v1/classes').set(H).expect(403);
    assert.equal(blocked.body.error.code, 'ACCESS_EXPIRED');
    await api().get('/api/v1/classes').set(staffH).expect(403);

    // The session itself still works, so the app can show why.
    const me = await api().get('/api/v1/auth/me').set(H).expect(200);
    assert.equal(me.body.institute.access.allowed, false);
    assert.equal(me.body.institute.access.code, 'ACCESS_EXPIRED');

    // Admin page: list, then Allow for 30 days.
    const list = await api().get('/api/v1/admin/institutes?q=access').set(ADMIN).expect(200);
    assert.equal(list.body.institutes.length, 1);
    assert.equal(list.body.institutes[0].allowed, false);
    assert.equal(list.body.institutes[0].staffCount, 1);
    const until = new Date(Date.now() + 30 * 86400000).toISOString();
    const allowed = await api()
      .patch(`/api/v1/admin/institutes/${owner.institute.id}`)
      .set(ADMIN)
      .send({ action: 'allow', accessUntil: until })
      .expect(200);
    assert.equal(allowed.body.institute.status, 'active');
    assert.equal(allowed.body.institute.allowed, true);
    await api().get('/api/v1/classes').set(H).expect(200);
    await api().get('/api/v1/classes').set(staffH).expect(200);
  });

  it('admin can block, and extend a trial', async () => {
    await api()
      .patch(`/api/v1/admin/institutes/${owner.institute.id}`)
      .set(ADMIN)
      .send({ action: 'block' })
      .expect(200);
    const res = await api().get('/api/v1/classes').set(staffH).expect(403);
    assert.equal(res.body.error.code, 'ACCESS_BLOCKED');

    const ext = await api()
      .patch(`/api/v1/admin/institutes/${owner.institute.id}`)
      .set(ADMIN)
      .send({ extendTrialDays: 7 })
      .expect(200);
    assert.equal(ext.body.institute.status, 'trial');
    assert.equal(ext.body.institute.trialDaysRemaining, 7);
    await api().get('/api/v1/classes').set(H).expect(200);
  });

  it('admin API and page', async () => {
    await api().get('/api/v1/admin/institutes').expect(401);
    const page = await api().get('/admin').expect(200);
    assert.match(page.text, /Kaksha Admin/);
    await api().get('/admin.js').expect(200);
    await api().get('/terms').expect(200);
  });

  it('student photo upload, fetch and delete', async () => {
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 1)]);
    const up = await api()
      .put(`/api/v1/students/${studentId}/photo`)
      .set(H)
      .send({ image: jpeg.toString('base64') })
      .expect(200);
    assert.ok(up.body.student.photoUpdatedAt);
    const got = await api().get(`/api/v1/students/${studentId}/photo`).set(staffH).expect(200);
    assert.equal(got.headers['content-type'], 'image/jpeg');
    assert.equal(Buffer.compare(got.body, jpeg), 0);

    await api()
      .put(`/api/v1/students/${studentId}/photo`)
      .set(H)
      .send({ image: Buffer.from('not an image at all').toString('base64') })
      .expect(400);

    const del = await api().delete(`/api/v1/students/${studentId}/photo`).set(H).expect(200);
    assert.equal(del.body.student.photoUpdatedAt, null);
    await api().get(`/api/v1/students/${studentId}/photo`).set(H).expect(404);
  });

  it('profile: rename, change password, staff cannot rename institute', async () => {
    const res = await api()
      .patch('/api/v1/account')
      .set(H)
      .send({ name: 'Asha Patil', instituteName: 'Bright Tuition' })
      .expect(200);
    assert.equal(res.body.user.name, 'Asha Patil');
    assert.equal(res.body.institute.name, 'Bright Tuition');
    await api().patch('/api/v1/account').set(staffH).send({ instituteName: 'X Y' }).expect(403);

    await api()
      .post('/api/v1/account/password')
      .set(H)
      .send({ currentPassword: 'wrong', newPassword: 'newpass1' })
      .expect(400);
    const changed = await api()
      .post('/api/v1/account/password')
      .set(H)
      .send({ currentPassword: 'secret1', newPassword: 'newpass1' })
      .expect(200);
    await api().get('/api/v1/classes').set(H).expect(401); // old token signed out
    H = auth(changed.body.token);
    await api().get('/api/v1/classes').set(H).expect(200);
  });

  it('owner deletes the account with everything in it', async () => {
    await api().delete('/api/v1/account').set(staffH).send({ password: 'secret1' }).expect(403);
    await api().delete('/api/v1/account').set(H).send({ password: 'wrong' }).expect(400);
    await api().delete('/api/v1/account').set(H).send({ password: 'newpass1' }).expect(204);
    await api().get('/api/v1/auth/me').set(H).expect(401);
    await api().get('/api/v1/auth/me').set(staffH).expect(401);
    const { n } = await db.one('select count(*)::int as n from students');
    assert.equal(n, 0);
  });
});
