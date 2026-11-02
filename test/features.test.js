const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { api, setup, teardown, auth, registerOwner } = require('./helpers');

const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());

describe('classes, students, attendance, tests, fees, reports', () => {
  let owner;
  let H;
  let classId;
  let ganesh;
  let roshan;

  before(async () => {
    await setup();
    owner = await registerOwner('owner@example.com', '9811111111');
    H = auth(owner.token);
  });
  after(teardown);

  it('creates classes with unique names', async () => {
    const res = await api().post('/api/v1/classes').set(H).send({ name: 'Class 5' }).expect(201);
    classId = res.body.class.id;
    const dup = await api().post('/api/v1/classes').set(H).send({ name: ' class 5 ' }).expect(409);
    assert.equal(dup.body.error.code, 'DUPLICATE');
  });

  it('adds students; roll numbers unique per class', async () => {
    const a = await api()
      .post(`/api/v1/classes/${classId}/students`)
      .set(H)
      .send({ name: 'Ganesh Pawar', rollNo: '10', totalFees: 15000, parentMobile: '9822222222' })
      .expect(201);
    ganesh = a.body.student;
    assert.equal(ganesh.feesDue, 15000);
    const b = await api()
      .post(`/api/v1/classes/${classId}/students`)
      .set(H)
      .send({ name: 'Roshan Bachhav', rollNo: '11', totalFees: 15000, dateOfBirth: '2015-06-01' })
      .expect(201);
    roshan = b.body.student;
    const dup = await api()
      .post(`/api/v1/classes/${classId}/students`)
      .set(H)
      .send({ name: 'Dup', rollNo: '10' })
      .expect(409);
    assert.equal(dup.body.error.code, 'DUPLICATE_ROLL');

    const list = await api().get('/api/v1/classes').set(H).expect(200);
    assert.equal(list.body.classes[0].studentCount, 2);
  });

  it('updates a student without wiping other fields', async () => {
    const res = await api()
      .patch(`/api/v1/students/${ganesh.id}`)
      .set(H)
      .send({ fatherName: 'Ramesh' })
      .expect(200);
    assert.equal(res.body.student.fatherName, 'Ramesh');
    assert.equal(res.body.student.parentMobile, '9822222222');
    assert.equal(res.body.student.rollNo, '10');
  });

  it('defaults attendance to present and saves it', async () => {
    const empty = await api().get(`/api/v1/classes/${classId}/attendance?date=${today}`).set(H).expect(200);
    assert.equal(empty.body.saved, false);
    assert.equal(empty.body.counts.present, 2);

    const saved = await api()
      .put(`/api/v1/classes/${classId}/attendance`)
      .set(H)
      .send({
        date: today,
        records: [
          { student: ganesh.id, status: 'present' },
          { student: roshan.id, status: 'absent' },
        ],
      })
      .expect(200);
    assert.deepEqual(
      { p: saved.body.counts.present, a: saved.body.counts.absent },
      { p: 1, a: 1 },
    );
    await api()
      .put(`/api/v1/classes/${classId}/attendance`)
      .set(H)
      .send({ date: '2999-01-01', records: [] })
      .expect(400);

    const hist = await api().get(`/api/v1/students/${roshan.id}/attendance`).set(H).expect(200);
    assert.equal(hist.body.history[0].status, 'absent');

    const dash = await api().get(`/api/v1/dashboard?date=${today}`).set(H).expect(200);
    assert.deepEqual(
      { c: dash.body.classes, s: dash.body.students, p: dash.body.presentToday, f: dash.body.feesDue },
      { c: 1, s: 2, p: 1, f: 30000 },
    );
  });

  it('creates tests and validates marks', async () => {
    const t = await api()
      .post(`/api/v1/classes/${classId}/tests`)
      .set(H)
      .send({ subject: 'Mathematics', maxMarks: 50 })
      .expect(201);
    const testId = t.body.test.id;
    await api()
      .put(`/api/v1/tests/${testId}`)
      .set(H)
      .send({ marks: [{ student: ganesh.id, marks: 60 }] })
      .expect(400);
    const ok = await api()
      .put(`/api/v1/tests/${testId}`)
      .set(H)
      .send({
        marks: [
          { student: ganesh.id, marks: 42, remarks: 'Good' },
          { student: roshan.id, marks: null },
        ],
      })
      .expect(200);
    assert.equal(ok.body.test.gradedCount, 1);
    const results = await api().get(`/api/v1/students/${ganesh.id}/results`).set(H).expect(200);
    assert.equal(results.body.results[0].marks, 42);
  });

  it('collects fees and rejects overpayment', async () => {
    const pay = await api()
      .post(`/api/v1/students/${ganesh.id}/fees/payments`)
      .set(H)
      .send({ amount: 5000 })
      .expect(201);
    assert.equal(pay.body.student.feesDue, 10000);
    await api()
      .post(`/api/v1/students/${ganesh.id}/fees/payments`)
      .set(H)
      .send({ amount: 10001 })
      .expect(400);

    const fees = await api().get(`/api/v1/classes/${classId}/fees`).set(H).expect(200);
    assert.deepEqual(fees.body.summary, { total: 30000, collected: 5000, due: 25000 });
    const dues = await api().get('/api/v1/fees/dues').set(H).expect(200);
    assert.equal(dues.body.students.length, 2);
    assert.equal(dues.body.students[0].className, 'Class 5');
    const history = await api().get(`/api/v1/students/${ganesh.id}/fees/payments`).set(H).expect(200);
    assert.equal(history.body.payments[0].collectedBy, 'Asha Patil');
  });

  it('builds reports', async () => {
    const r = await api().get('/api/v1/reports').set(H).expect(200);
    assert.equal(r.body.attendance[0].presentPercent, 50);
    assert.equal(r.body.attendance[0].absentPercent, 50);
    assert.equal(r.body.fees[0].due, 25000);
  });

  it('keeps institutes isolated', async () => {
    const other = await registerOwner('other@example.com', '9833333333');
    const O = auth(other.token);
    await api().get(`/api/v1/classes/${classId}/students`).set(O).expect(404);
    await api().get(`/api/v1/students/${ganesh.id}`).set(O).expect(404);
    await api().delete(`/api/v1/classes/${classId}`).set(O).expect(404);
    const mine = await api().get('/api/v1/classes').set(O).expect(200);
    assert.equal(mine.body.classes.length, 0);
  });

  it('staff: plan limit, blocking, fee permission, owner-only actions', async () => {
    const created = await api()
      .post('/api/v1/users')
      .set(H)
      .send({ name: 'Tanmay', email: 'tanmay@example.com', password: 'secret1' })
      .expect(201);
    const staff = created.body.user;
    assert.equal(staff.active, false); // plan includes 0 staff logins

    const blocked = await api()
      .post('/api/v1/auth/login')
      .send({ identifier: 'tanmay@example.com', password: 'secret1' })
      .expect(403);
    assert.equal(blocked.body.error.code, 'ACCOUNT_BLOCKED');

    const limit = await api().patch(`/api/v1/users/${staff.id}`).set(H).send({ active: true }).expect(403);
    assert.equal(limit.body.error.code, 'PLAN_LIMIT');

    // You raise the limit with the admin API after the teacher pays.
    await api()
      .patch(`/api/v1/admin/institutes/${owner.institute.id}`)
      .set('x-admin-key', 'test-admin-key')
      .send({ staffLoginLimit: 1 })
      .expect(200);
    await api().patch(`/api/v1/users/${staff.id}`).set(H).send({ active: true }).expect(200);

    const login = await api()
      .post('/api/v1/auth/login')
      .send({ identifier: 'tanmay@example.com', password: 'secret1' })
      .expect(200);
    const S = auth(login.body.token);

    // Staff can work with classes but not fees, users or deletes.
    const st = await api().get(`/api/v1/classes/${classId}/students`).set(S).expect(200);
    assert.equal(st.body.students[0].totalFees, undefined);
    await api().get(`/api/v1/classes/${classId}/fees`).set(S).expect(403);
    await api().patch(`/api/v1/students/${ganesh.id}`).set(S).send({ totalFees: 1 }).expect(403);
    await api().get('/api/v1/users').set(S).expect(403);
    await api().delete(`/api/v1/students/${ganesh.id}`).set(S).expect(403);
    const dash = await api().get('/api/v1/dashboard').set(S).expect(200);
    assert.equal(dash.body.feesDue, null);

    // Grant fee access; blocking signs them out immediately.
    await api().patch(`/api/v1/users/${staff.id}`).set(H).send({ canAccessFees: true }).expect(200);
    await api().get(`/api/v1/classes/${classId}/fees`).set(S).expect(200);
    await api().patch(`/api/v1/users/${staff.id}`).set(H).send({ active: false }).expect(200);
    await api().get('/api/v1/classes').set(S).expect(403);
  });

  it('admin API needs the key', async () => {
    await api().get('/api/v1/admin/institutes?email=owner@example.com').expect(401);
  });

  it('deleting a student removes their marks, attendance and payments', async () => {
    await api().delete(`/api/v1/students/${roshan.id}`).set(H).expect(204);
    await api().get(`/api/v1/students/${roshan.id}`).set(H).expect(404);
    const tests = await api().get(`/api/v1/classes/${classId}/tests`).set(H).expect(200);
    for (const t of tests.body.tests) {
      assert.ok(t.marks.every((m) => m.student !== roshan.id));
    }
    const att = await api().get(`/api/v1/classes/${classId}/attendance?date=${today}`).set(H).expect(200);
    assert.ok(att.body.records.every((r) => r.student !== roshan.id));
  });

  it('answers keep-alive and health checks', async () => {
    await api().get('/api/ping').expect(200, { ok: true });
    const res = await api().get('/api/health').expect(200);
    assert.equal(res.body.database, 'connected');
  });

  it('deleting a class removes its data', async () => {
    await api().delete(`/api/v1/classes/${classId}`).set(H).expect(204);
    await api().get(`/api/v1/students/${ganesh.id}`).set(H).expect(404);
    const dash = await api().get('/api/v1/dashboard').set(H).expect(200);
    assert.equal(dash.body.students, 0);
  });
});
