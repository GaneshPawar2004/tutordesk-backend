const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { api, setup, teardown, auth, registerOwner } = require('./helpers');

describe('class import (from the old Teachers App export)', () => {
  let H;
  let S;
  let classId;

  // What the app sends after parsing Class_8.csv.
  const body = {
    source: 'Teachers App',
    students: [
      {
        name: 'Ravi Kumar',
        fatherName: 'Suresh Kumar',
        contact: '9876500001',
        parentMobile: '9876500002',
        rollNo: '1',
        email: 'ravi@example.com',
        totalFees: 12000,
        feesDueDate: '2026-11-30',
        payments: [{ amount: 5000, paidAt: '2026-11-22' }],
        attendance: { '2026-11-21': 'present', '2026-11-22': 'present' },
      },
      {
        name: 'Sita Sharma',
        parentMobile: '9876500003',
        rollNo: '2',
        totalFees: 10000,
        attendance: { '2026-11-21': 'present', '2026-11-22': 'absent' },
      },
      { name: 'Mohan Das', rollNo: '3', attendance: { '2026-11-22': 'leave' } },
    ],
    tests: [{ subject: 'Maths', maxMarks: 50, marks: { 0: 40, 1: 35 } }],
  };

  before(async () => {
    await setup();
    const owner = await registerOwner('import@example.com', '9866660000');
    H = auth(owner.token);
    await api()
      .post('/api/v1/users')
      .set(H)
      .send({ name: 'Staff', email: 'istaff@example.com', password: 'secret1' })
      .expect(201);
    S = auth(
      (await api().post('/api/v1/auth/login').send({ identifier: 'istaff@example.com', password: 'secret1' })).body
        .token,
    );
    classId = (await api().post('/api/v1/classes').set(H).send({ name: 'Class 8' })).body.class.id;
  });
  after(teardown);

  it('imports students, payments, attendance history and marks', async () => {
    const res = await api().post(`/api/v1/classes/${classId}/import`).set(H).send(body).expect(201);
    assert.deepEqual(res.body.imported, { students: 3, skipped: 0, payments: 1, attendanceDays: 2, tests: 1 });

    const list = await api().get(`/api/v1/classes/${classId}/students`).set(H).expect(200);
    const ravi = list.body.students.find((s) => s.name === 'Ravi Kumar');
    assert.equal(ravi.feesPaid, 5000);
    assert.equal(ravi.feesDue, 7000);
    assert.equal(ravi.parentMobile, '9876500002');

    const hist = await api().get(`/api/v1/students/${ravi.id}/attendance`).set(H).expect(200);
    assert.equal(hist.body.history.length, 2);
    const day = await api().get(`/api/v1/classes/${classId}/attendance?date=2026-11-22`).set(H).expect(200);
    assert.equal(day.body.saved, true);
    assert.equal(day.body.counts.absent, 1);

    const tests = await api().get(`/api/v1/classes/${classId}/tests`).set(H).expect(200);
    assert.equal(tests.body.tests[0].gradedCount, 2);
    const pays = await api().get(`/api/v1/students/${ravi.id}/fees/payments`).set(H).expect(200);
    assert.equal(pays.body.payments[0].amount, 5000);
  });

  it('importing the same file again adds nothing', async () => {
    const res = await api().post(`/api/v1/classes/${classId}/import`).set(H).send(body).expect(400);
    assert.match(res.body.error.message, /already in the class/);
    const list = await api().get(`/api/v1/classes/${classId}/students`).set(H).expect(200);
    assert.equal(list.body.students.length, 3);
  });

  it('staff cannot import; bad data changes nothing', async () => {
    await api().post(`/api/v1/classes/${classId}/import`).set(S).send(body).expect(403);
    const other = (await api().post('/api/v1/classes').set(H).send({ name: 'Class 9' })).body.class.id;
    await api()
      .post(`/api/v1/classes/${other}/import`)
      .set(H)
      .send({ students: [{ name: 'A' }, { name: '' }] })
      .expect(400);
    const list = await api().get(`/api/v1/classes/${other}/students`).set(H).expect(200);
    assert.equal(list.body.students.length, 0);
  });
});
