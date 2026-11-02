const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');

const config = require('../config');
const db = require('../db');
const User = require('../models/User');
const validate = require('../middleware/validate');
const { requireAuth } = require('../middleware/auth');
const { issueOtp, consumeOtp } = require('../utils/otp');
const { isId } = require('../utils/scope');
const { signAuthToken, signResetToken, verifyToken } = require('../utils/tokens');
const { ApiError, badRequest, conflict, forbidden } = require('../utils/errors');
const s = require('../utils/schemas');

const router = express.Router();

router.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 50,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    skip: () => config.isTest,
    message: { error: { code: 'RATE_LIMITED', message: 'Too many attempts. Try again later.' } },
  }),
);

const hashPassword = (pw) => bcrypt.hash(pw, 10);

async function instituteSummary(instituteId) {
  const inst = await db.one('select * from institutes where id = $1', [instituteId]);
  if (!inst) return null;
  const msLeft = inst.trial_ends_at.getTime() - Date.now();
  return {
    id: inst.id,
    name: inst.name,
    trialEndsAt: inst.trial_ends_at,
    trialDaysRemaining: Math.max(0, Math.ceil(msLeft / 86400000)),
    staffLoginLimit: inst.staff_login_limit,
  };
}

async function sessionResponse(user) {
  return {
    token: signAuthToken(user),
    user: User.toPublic(user),
    institute: await instituteSummary(user.institute_id),
  };
}

const userByEmail = (email) => db.one('select * from users where email = $1', [email]);

// ---- Register (owner) → OTP to email ---------------------------------------
const registerSchema = s.z.object({
  name: s.z.string().trim().min(2, 'Enter your full name').max(100),
  email: s.email,
  mobile: s.mobile,
  password: s.password,
  referralCode: s.optionalMobile.optional(),
});

router.post('/register', validate(registerSchema), async (req, res) => {
  const { name, email, mobile, password } = req.body;
  const referralCode = req.body.referralCode || '';

  const byMobile = await db.one('select * from users where mobile = $1', [mobile]);
  if (byMobile && byMobile.email !== email) {
    if (byMobile.email_verified || byMobile.role !== 'owner') {
      throw conflict('This mobile number is already registered', 'MOBILE_TAKEN');
    }
    // An unfinished signup (e.g. a mistyped email) must not hold the number:
    // drop it with its empty institute.
    await db.query('delete from institutes where id = $1', [byMobile.institute_id]);
    await db.query("delete from otps where email = $1 and purpose = 'signup'", [byMobile.email]);
  }

  const user = await userByEmail(email);
  if (user && user.email_verified) {
    throw conflict('An account with this email already exists. Please sign in.', 'EMAIL_TAKEN');
  }
  if (user && user.role !== 'owner') {
    throw conflict('This email is used by a staff login', 'EMAIL_TAKEN');
  }

  const passwordHash = await hashPassword(password);
  await db.tx(async (t) => {
    if (user) {
      // Unverified signup retried: update details and resend the code.
      await t.query('update users set name = $2, mobile = $3, password_hash = $4 where id = $1', [
        user.id,
        name,
        mobile,
        passwordHash,
      ]);
      await t.query('update institutes set referred_by_mobile = $2 where id = $1', [user.institute_id, referralCode]);
      return;
    }
    const inst = await t.one(
      `insert into institutes (name, trial_ends_at, staff_login_limit, referred_by_mobile)
       values ($1, $2, $3, $4) returning id`,
      [
        `${name}'s Institute`,
        new Date(Date.now() + config.trialDays * 86400000),
        config.defaultStaffLoginLimit,
        referralCode,
      ],
    );
    const owner = await t.one(
      `insert into users (institute_id, role, name, email, mobile, password_hash)
       values ($1, 'owner', $2, $3, $4, $5) returning id`,
      [inst.id, name, email, mobile, passwordHash],
    );
    await t.query('update institutes set owner_id = $2 where id = $1', [inst.id, owner.id]);
  });

  await issueOtp(email, 'signup');
  res.status(201).json({ message: 'Verification code sent to your email', email });
});

const emailCodeSchema = s.z.object({ email: s.email, code: s.otpCode });

router.post('/verify-email', validate(emailCodeSchema), async (req, res) => {
  const { email, code } = req.body;
  const user = await db.one("select * from users where email = $1 and role = 'owner'", [email]);
  if (!user) throw badRequest('No signup found for this email');
  if (user.email_verified) throw conflict('Email already verified. Please sign in.', 'ALREADY_VERIFIED');
  await consumeOtp(email, 'signup', code);
  const verified = await db.one('update users set email_verified = true where id = $1 returning *', [user.id]);
  res.json(await sessionResponse(verified));
});

const resendSchema = s.z.object({ email: s.email, purpose: s.z.enum(['signup', 'reset']) });

router.post('/resend-otp', validate(resendSchema), async (req, res) => {
  const { email, purpose } = req.body;
  const user = await userByEmail(email);
  const eligible =
    purpose === 'signup' ? user && !user.email_verified : user && user.email_verified;
  if (eligible) await issueOtp(email, purpose);
  // Same answer either way so the API doesn't reveal which emails exist.
  res.json({ message: 'If the email is registered, a new code has been sent' });
});

// ---- Login -----------------------------------------------------------------
const loginSchema = s.z.object({
  identifier: s.z.string().trim().min(1, 'Enter your mobile number or email'),
  password: s.z.string().min(1, 'Enter your password'),
});

router.post('/login', validate(loginSchema), async (req, res) => {
  const id = req.body.identifier.toLowerCase();
  const user = id.includes('@')
    ? await userByEmail(id)
    : await db.one('select * from users where mobile = $1', [id]);
  const ok = user && (await bcrypt.compare(req.body.password, user.password_hash));
  if (!ok) throw new ApiError(401, 'INVALID_CREDENTIALS', 'Incorrect mobile/email or password');
  if (!user.email_verified) {
    throw forbidden('Please verify your email to continue', 'EMAIL_NOT_VERIFIED');
  }
  if (user.role === 'staff' && !user.active) {
    throw forbidden('Your login has been blocked by the admin', 'ACCOUNT_BLOCKED');
  }
  res.json(await sessionResponse(user));
});

// ---- Forgot / reset password ------------------------------------------------
const verifiedUserByEmail = (email) =>
  db.one('select * from users where email = $1 and email_verified', [email]);

router.post('/forgot-password', validate(s.z.object({ email: s.email })), async (req, res) => {
  const user = await verifiedUserByEmail(req.body.email);
  if (user) await issueOtp(user.email, 'reset');
  res.json({ message: 'If the email is registered, a verification code has been sent' });
});

router.post('/verify-reset-otp', validate(emailCodeSchema), async (req, res) => {
  const { email, code } = req.body;
  await consumeOtp(email, 'reset', code);
  const user = await verifiedUserByEmail(email);
  if (!user) throw badRequest('No account found for this email');
  res.json({ resetToken: signResetToken(user) });
});

const resetSchema = s.z.object({ resetToken: s.z.string().min(1), password: s.password });

router.post('/reset-password', validate(resetSchema), async (req, res) => {
  const payload = verifyToken(req.body.resetToken, 'reset');
  const user = payload && isId(payload.sub) && (await db.one('select * from users where id = $1', [payload.sub]));
  if (!user || user.token_version !== payload.v) {
    throw badRequest('This reset link has expired. Please start again.');
  }
  // Bumping token_version signs out all devices.
  await db.query('update users set password_hash = $2, token_version = token_version + 1 where id = $1', [
    user.id,
    await hashPassword(req.body.password),
  ]);
  res.json({ message: 'Password reset successfully. Please sign in.' });
});

// ---- Current session ----------------------------------------------------------
router.get('/me', requireAuth, async (req, res) => {
  res.json({ user: User.toPublic(req.user), institute: await instituteSummary(req.instituteId) });
});

module.exports = router;
module.exports.instituteSummary = instituteSummary;
