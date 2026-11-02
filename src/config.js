require('dotenv').config({ quiet: true });

const env = process.env;

const config = {
  env: env.NODE_ENV || 'development',
  port: Number(env.PORT) || 4000,
  databaseUrl: env.NEON_DB_URL || env.DATABASE_URL || '',
  jwtSecret: env.TOKEN_SECRET || env.JWT_SECRET || '',
  jwtExpiresIn: env.JWT_EXPIRES_IN || '30d',
  corsOrigins: (env.ALLOWED_ORIGINS || env.CORS_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  smtp: {
    host: env.SMTP_HOST || '',
    port: Number(env.SMTP_PORT) || 587,
    secure: env.SMTP_SECURE === 'true',
    user: env.SMTP_USER || '',
    pass: env.SMTP_PASS || '',
    from: env.MAIL_FROM || 'Kaksha <no-reply@example.com>',
  },
  trialDays: Number(env.TRIAL_DAYS) || 14,
  defaultStaffLoginLimit: Number(env.DEFAULT_STAFF_LOGIN_LIMIT) || 0,
  adminApiKey: env.ADMIN_API_KEY || '',
  otp: { length: 6, ttlMinutes: 10, maxAttempts: 5, resendSeconds: 30 },
};

config.isProd = config.env === 'production';
config.isTest = config.env === 'test';

if (config.isProd && (!config.jwtSecret || config.jwtSecret === 'change-me')) {
  throw new Error('TOKEN_SECRET must be set to a strong value in production');
}
if (!config.jwtSecret) config.jwtSecret = 'dev-only-insecure-secret';

module.exports = config;
