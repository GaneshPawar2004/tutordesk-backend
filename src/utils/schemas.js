const { z } = require('zod');

const mobile = z
  .string()
  .trim()
  .regex(/^[6-9]\d{9}$/, 'Enter a valid 10-digit mobile number');

/** Optional mobile: '' or a valid number. */
const optionalMobile = z.union([z.literal(''), mobile]);

const email = z.string().trim().toLowerCase().pipe(z.email('Enter a valid email address'));
const optionalEmail = z.union([z.literal(''), email]);

const password = z.string().min(6, 'Password must be at least 6 characters').max(128);

const otpCode = z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code');

const objectId = z.string().regex(
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  'Invalid id',
);

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use date format YYYY-MM-DD');

/** Accepts 'YYYY-MM-DD' or full ISO date strings; null clears the value. */
const nullableDate = z
  .union([z.null(), z.literal(''), z.iso.date(), z.iso.datetime({ offset: true })])
  .transform((v) => (v ? new Date(v) : null));

const money = z.number().min(0).max(1e9);

module.exports = {
  z,
  mobile,
  optionalMobile,
  email,
  optionalEmail,
  password,
  otpCode,
  objectId,
  isoDate,
  nullableDate,
  money,
};
