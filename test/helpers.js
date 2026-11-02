process.env.NODE_ENV = 'test';
process.env.ADMIN_API_KEY = 'test-admin-key';

const request = require('supertest');

const db = require('../src/db');
const { createApp } = require('../src/app');
const { outbox } = require('../src/utils/mailer');

const app = createApp();
const api = () => request(app);

/** Fresh in-process Postgres (PGlite) per test file. */
async function setup() {
  await db.connect('memory');
}

async function teardown() {
  await db.disconnect();
}

/** Latest OTP emailed to [email]. */
function lastOtp(email) {
  const mail = [...outbox].reverse().find((m) => m.to === email);
  return mail && /\b(\d{6})\b/.exec(mail.subject)[1];
}

const auth = (token) => ({ Authorization: `Bearer ${token}` });

/** Registers + verifies an owner; returns { token, user, institute }. */
async function registerOwner(email, mobile, password = 'secret1') {
  await api()
    .post('/api/v1/auth/register')
    .send({ name: 'Asha Patil', email, mobile, password })
    .expect(201);
  const res = await api()
    .post('/api/v1/auth/verify-email')
    .send({ email, code: lastOtp(email) })
    .expect(200);
  return res.body;
}

module.exports = { api, setup, teardown, lastOtp, auth, registerOwner, outbox };
