const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { api, setup, teardown, lastOtp, auth, registerOwner } = require('./helpers');

describe('auth', () => {
  before(setup);
  after(teardown);

  it('registers, rejects login before verification, verifies via OTP', async () => {
    await api()
      .post('/api/v1/auth/register')
      .send({ name: 'Ravi', email: 'Ravi@Example.com', mobile: '9876543210', password: 'secret1' })
      .expect(201);

    const early = await api()
      .post('/api/v1/auth/login')
      .send({ identifier: 'ravi@example.com', password: 'secret1' })
      .expect(403);
    assert.equal(early.body.error.code, 'EMAIL_NOT_VERIFIED');

    const wrong = await api()
      .post('/api/v1/auth/verify-email')
      .send({ email: 'ravi@example.com', code: '000000' === lastOtp('ravi@example.com') ? '111111' : '000000' })
      .expect(400);
    assert.match(wrong.body.error.message, /Incorrect code/);

    const ok = await api()
      .post('/api/v1/auth/verify-email')
      .send({ email: 'ravi@example.com', code: lastOtp('ravi@example.com') })
      .expect(200);
    assert.ok(ok.body.token);
    assert.equal(ok.body.user.role, 'owner');
    assert.equal(ok.body.institute.trialDaysRemaining, 14);
  });

  it('logs in with email or mobile; rejects bad password', async () => {
    await api().post('/api/v1/auth/login').send({ identifier: '9876543210', password: 'secret1' }).expect(200);
    const res = await api()
      .post('/api/v1/auth/login')
      .send({ identifier: 'ravi@example.com', password: 'nope' })
      .expect(401);
    assert.equal(res.body.error.code, 'INVALID_CREDENTIALS');
  });

  it('blocks duplicate email and mobile', async () => {
    const dupEmail = await api()
      .post('/api/v1/auth/register')
      .send({ name: 'Xavier', email: 'ravi@example.com', mobile: '9000000001', password: 'secret1' })
      .expect(409);
    assert.equal(dupEmail.body.error.code, 'EMAIL_TAKEN');
    const dupMobile = await api()
      .post('/api/v1/auth/register')
      .send({ name: 'Xavier', email: 'other@example.com', mobile: '9876543210', password: 'secret1' })
      .expect(409);
    assert.equal(dupMobile.body.error.code, 'MOBILE_TAKEN');
  });

  it('lets a retry with a corrected email reuse the mobile of an unverified signup', async () => {
    await api()
      .post('/api/v1/auth/register')
      .send({ name: 'Typo', email: 'typo@exmaple.com', mobile: '9111111111', password: 'secret1' })
      .expect(201);
    await api()
      .post('/api/v1/auth/register')
      .send({ name: 'Typo', email: 'fixed@example.com', mobile: '9111111111', password: 'secret1' })
      .expect(201);
    await api()
      .post('/api/v1/auth/verify-email')
      .send({ email: 'fixed@example.com', code: lastOtp('fixed@example.com') })
      .expect(200);
    // The abandoned signup is gone.
    const old = await api()
      .post('/api/v1/auth/verify-email')
      .send({ email: 'typo@exmaple.com', code: lastOtp('typo@exmaple.com') })
      .expect(400);
    assert.match(old.body.error.message, /No signup found/);
  });

  it('validates input', async () => {
    const res = await api()
      .post('/api/v1/auth/register')
      .send({ name: 'X', email: 'bad', mobile: '123', password: '1' })
      .expect(400);
    assert.equal(res.body.error.code, 'BAD_REQUEST');
    assert.ok(res.body.error.details.length >= 3);
  });

  it('resets password with OTP and signs out old sessions', async () => {
    const login = await api()
      .post('/api/v1/auth/login')
      .send({ identifier: 'ravi@example.com', password: 'secret1' })
      .expect(200);

    await api().post('/api/v1/auth/forgot-password').send({ email: 'ravi@example.com' }).expect(200);
    const { body } = await api()
      .post('/api/v1/auth/verify-reset-otp')
      .send({ email: 'ravi@example.com', code: lastOtp('ravi@example.com') })
      .expect(200);
    await api()
      .post('/api/v1/auth/reset-password')
      .send({ resetToken: body.resetToken, password: 'newpass1' })
      .expect(200);

    await api().get('/api/v1/auth/me').set(auth(login.body.token)).expect(401);
    await api().post('/api/v1/auth/login').send({ identifier: 'ravi@example.com', password: 'newpass1' }).expect(200);
    // Reset token is single-use.
    await api()
      .post('/api/v1/auth/reset-password')
      .send({ resetToken: body.resetToken, password: 'again12' })
      .expect(400);
  });

  it('does not reveal unknown emails on forgot-password', async () => {
    const res = await api().post('/api/v1/auth/forgot-password').send({ email: 'ghost@example.com' }).expect(200);
    assert.match(res.body.message, /If the email is registered/);
  });

  it('enforces OTP resend cooldown', async () => {
    await registerOwner('cool@example.com', '9000000002');
    await api().post('/api/v1/auth/forgot-password').send({ email: 'cool@example.com' }).expect(200);
    const res = await api().post('/api/v1/auth/forgot-password').send({ email: 'cool@example.com' }).expect(429);
    assert.equal(res.body.error.code, 'OTP_COOLDOWN');
  });

  it('requires a token for protected routes', async () => {
    await api().get('/api/v1/classes').expect(401);
    await api().get('/api/v1/classes').set(auth('garbage')).expect(401);
  });
});
