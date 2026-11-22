const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { api, setup, teardown, auth, registerOwner } = require('./helpers');
const { monthsBilled } = require('../src/models/Student');

const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
const month = (offset) => {
  const [y, m] = today.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + offset, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};

describe('monthly fees, receipts, copy students, notes, institute details', () => {
  let H;
  let classId;
  let otherClassId;
  let asha;

  before(async () => {
    await setup();
    H = auth((await registerOwner('f2@example.com', '9877770000')).token);
    classId = (await api().post('/api/v1/classes').set(H).send({ name: 'Class 6' })).body.class.id;
    otherClassId = (await api().post('/api/v1/classes').set(H).send({ name: 'Class 7' })).body.class.id;
  });
  after(teardown);

  it('counts billed months including the start month', () => {
    assert.equal(monthsBilled('2026-08', '2026-11-22'), 4);
    assert.equal(monthsBilled('2026-11', '2026-11-01'), 1);
    assert.equal(monthsBilled('2025-12', '2026-01-15'), 2);
    assert.equal(monthsBilled('2027-01', '2026-11-22'), 0); // starts in the future
    assert.equal(monthsBilled(null, '2026-11-22'), 0);
  });

  it('monthly fee accrues every month on top of one-time fees', async () => {
    await api().patch('/api/v1/account').set(H).send({ monthlyFees: true }).expect(200);
    const res = await api()
      .post(`/api/v1/classes/${classId}/students`)
      .set(H)
      .send({ name: 'Asha', rollNo: '1', totalFees: 500, monthlyFee: 1000, feeStart: month(-3) })
      .expect(201);
    asha = res.body.student;
    assert.equal(asha.monthsBilled, 4); // 3 months ago … this month
    assert.equal(asha.oneTimeFees, 500);
    assert.equal(asha.totalFees, 4500);
    assert.equal(asha.feesDue, 4500);

    await api()
      .post(`/api/v1/students/${asha.id}/fees/payments`)
      .set(H)
      .send({ amount: 4600 })
      .expect(400); // more than billed so far
    const dash = await api().get('/api/v1/dashboard').set(H).expect(200);
    assert.equal(dash.body.feesDue, 4500);
    const reports = await api().get('/api/v1/reports').set(H).expect(200);
    assert.equal(reports.body.fees.find((f) => f.class === classId).total, 4500);
  });

  it('payments get receipt numbers 1, 2, 3 per institute', async () => {
    const nos = [];
    for (const amount of [1000, 1000, 500]) {
      const r = await api().post(`/api/v1/students/${asha.id}/fees/payments`).set(H).send({ amount }).expect(201);
      nos.push(r.body.payment.receiptNo);
    }
    assert.deepEqual(nos, [1, 2, 3]);
    const list = await api().get(`/api/v1/students/${asha.id}/fees/payments`).set(H).expect(200);
    assert.deepEqual(list.body.payments.map((p) => p.receiptNo).sort(), [1, 2, 3]);
  });

  it('copies students (details only) to another class, skipping taken roll numbers', async () => {
    const ravi = (
      await api()
        .post(`/api/v1/classes/${classId}/students`)
        .set(H)
        .send({ name: 'Ravi', rollNo: '2', parentMobile: '9811111111', totalFees: 900 })
    ).body.student;
    await api().post(`/api/v1/classes/${otherClassId}/students`).set(H).send({ name: 'Old', rollNo: '2' }).expect(201);
    const res = await api()
      .post(`/api/v1/classes/${classId}/students/copy`)
      .set(H)
      .send({ to: otherClassId, students: [asha.id, ravi.id] })
      .expect(201);
    assert.equal(res.body.copied, 1);
    assert.deepEqual(res.body.skipped, ['Ravi']);
    const list = await api().get(`/api/v1/classes/${otherClassId}/students`).set(H).expect(200);
    const copy = list.body.students.find((s) => s.name === 'Asha');
    assert.equal(copy.rollNo, '1');
    assert.equal(copy.feesPaid, 0);
    assert.equal(copy.totalFees, 0);
    // Originals stay.
    const orig = await api().get(`/api/v1/classes/${classId}/students`).set(H).expect(200);
    assert.equal(orig.body.students.length, 2);
  });

  it('keeps a reason for "others" attendance', async () => {
    const day = await api().get(`/api/v1/classes/${classId}/attendance`).set(H).expect(200);
    const res = await api()
      .put(`/api/v1/classes/${classId}/attendance`)
      .set(H)
      .send({
        date: today,
        version: day.body.version,
        records: day.body.records.map((r) =>
          r.student === asha.id
            ? { student: r.student, status: 'others', note: 'Sick' }
            : { student: r.student, status: 'present', note: 'ignored' },
        ),
      })
      .expect(200);
    const rec = (id) => res.body.records.find((r) => r.student === id);
    assert.equal(rec(asha.id).note, 'Sick');
    assert.ok(res.body.records.filter((r) => r.student !== asha.id).every((r) => r.note === ''));
    const hist = await api().get(`/api/v1/students/${asha.id}/attendance`).set(H).expect(200);
    assert.equal(hist.body.history[0].note, 'Sick');
  });

  it('institute details and logo for receipts', async () => {
    const res = await api()
      .patch('/api/v1/account')
      .set(H)
      .send({ instituteName: 'Bright Tuition', institutePhone: '9877770000', instituteAddress: 'MG Road, Nashik' })
      .expect(200);
    assert.equal(res.body.institute.phone, '9877770000');
    assert.equal(res.body.institute.address, 'MG Road, Nashik');
    assert.equal(res.body.institute.monthlyFees, true);

    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 2)]);
    const up = await api().put('/api/v1/account/logo').set(H).send({ image: png.toString('base64') }).expect(200);
    assert.ok(up.body.institute.logoUpdatedAt);
    const got = await api().get('/api/v1/account/logo').set(H).expect(200);
    assert.equal(got.headers['content-type'], 'image/png');
    await api().delete('/api/v1/account/logo').set(H).expect(200);
    await api().get('/api/v1/account/logo').set(H).expect(404);
  });

  it('import keeps Teachers App attendance notes as "others" with a reason', async () => {
    const res = await api()
      .post(`/api/v1/classes/${otherClassId}/import`)
      .set(H)
      .send({ students: [{ name: 'Noted', rollNo: '9', attendance: { [today]: 'Function at home' } }] })
      .expect(201);
    assert.equal(res.body.imported.students, 1);
    const day = await api().get(`/api/v1/classes/${otherClassId}/attendance?date=${today}`).set(H).expect(200);
    const r = day.body.records.find((x) => x.status === 'others');
    assert.equal(r.note, 'Function at home');
  });
});
