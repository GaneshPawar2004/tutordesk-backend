const crypto = require('crypto');
const config = require('../config');
const db = require('../db');
const { sendOtpEmail } = require('./mailer');
const { ApiError, badRequest } = require('./errors');

const hash = (email, purpose, code) =>
  crypto
    .createHmac('sha256', config.jwtSecret)
    .update(`${email}:${purpose}:${code}`)
    .digest('hex');

const randomCode = () =>
  crypto.randomInt(0, 10 ** config.otp.length).toString().padStart(config.otp.length, '0');

/** Creates (or replaces) the OTP for email+purpose and emails it. */
async function issueOtp(email, purpose) {
  await db.query('delete from otps where expires_at < now()');
  const existing = await db.one('select sent_at from otps where email = $1 and purpose = $2', [email, purpose]);
  if (existing) {
    const waitMs = config.otp.resendSeconds * 1000 - (Date.now() - existing.sent_at.getTime());
    if (waitMs > 0) {
      throw new ApiError(
        429,
        'OTP_COOLDOWN',
        `Please wait ${Math.ceil(waitMs / 1000)} seconds before requesting a new code`,
      );
    }
  }
  const code = randomCode();
  await db.query(
    `insert into otps (email, purpose, code_hash, attempts, sent_at, expires_at)
     values ($1, $2, $3, 0, now(), $4)
     on conflict (email, purpose) do update
       set code_hash = excluded.code_hash, attempts = 0, sent_at = now(), expires_at = excluded.expires_at`,
    [email, purpose, hash(email, purpose, code), new Date(Date.now() + config.otp.ttlMinutes * 60 * 1000)],
  );
  try {
    await sendOtpEmail(email, code, purpose);
  } catch (err) {
    console.error(`OTP email to ${email} failed:`, err.code || '', err.message);
    // Let the user retry right away instead of waiting out the cooldown.
    await db.query('delete from otps where email = $1 and purpose = $2', [email, purpose]);
    throw new ApiError(
      502,
      'EMAIL_FAILED',
      'We could not send the verification email. Please try again in a few minutes.',
      [{ reason: err.code || 'unknown' }],
    );
  }
}

/** Checks the code; deletes the OTP on success. Throws on failure. */
async function consumeOtp(email, purpose, code) {
  const otp = await db.one('select * from otps where email = $1 and purpose = $2', [email, purpose]);
  if (!otp || otp.expires_at < new Date()) {
    throw badRequest('This code has expired. Please request a new one.');
  }
  if (otp.attempts >= config.otp.maxAttempts) {
    throw new ApiError(429, 'OTP_LOCKED', 'Too many wrong attempts. Please request a new code.');
  }
  const a = Buffer.from(otp.code_hash, 'hex');
  const b = Buffer.from(hash(email, purpose, code), 'hex');
  if (!crypto.timingSafeEqual(a, b)) {
    await db.query('update otps set attempts = attempts + 1 where email = $1 and purpose = $2', [email, purpose]);
    throw badRequest('Incorrect code. Please try again.');
  }
  await db.query('delete from otps where email = $1 and purpose = $2', [email, purpose]);
}

module.exports = { issueOtp, consumeOtp };
