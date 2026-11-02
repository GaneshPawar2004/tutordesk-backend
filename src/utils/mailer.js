const nodemailer = require('nodemailer');
const MailComposer = require('nodemailer/lib/mail-composer');
const config = require('../config');

/**
 * Email goes out through, in order of preference:
 * 1. Gmail API over HTTPS (GMAIL_CLIENT_ID/SECRET/REFRESH_TOKEN): works on hosts
 *    that block SMTP ports, such as Render's free plan.
 *    Get the refresh token once with `npm run gmail-auth`.
 * 2. SMTP (SMTP_HOST).
 * 3. Neither: the message is kept in `outbox` and printed (development/tests).
 * Tests never send real email, even when .env has these settings.
 */
const useGmailApi = Boolean(config.gmail.refreshToken) && !config.isTest;

let transporter = null;
if (!useGmailApi && config.smtp.host && !config.isTest) {
  transporter = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
    // Fail fast instead of hanging the request if the mail server can't be reached.
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 20000,
  });
}

/** Messages "sent" while no email service is configured; tests read OTPs from here. */
const outbox = [];

// ---- Gmail API -----------------------------------------------------------------
let accessToken = null; // { value, expiresAt }

/** Short-lived access token from the stored refresh token (cached ~1 hour). */
async function gmailAccessToken() {
  if (accessToken && accessToken.expiresAt > Date.now() + 60000) return accessToken.value;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.gmail.clientId,
      client_secret: config.gmail.clientSecret,
      refresh_token: config.gmail.refreshToken,
      grant_type: 'refresh_token',
    }),
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`Google token error: ${data.error || res.status} ${data.error_description || ''}`);
    err.code = `GMAIL_${data.error || res.status}`;
    throw err;
  }
  accessToken = { value: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return accessToken.value;
}

/** Full RFC 822 message (headers + body) as a Buffer. */
const buildMessage = (mail) =>
  new Promise((resolve, reject) => {
    new MailComposer(mail).compile().build((err, raw) => (err ? reject(err) : resolve(raw)));
  });

async function sendViaGmailApi(message) {
  const raw = await buildMessage({ from: config.smtp.from, ...message });
  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${await gmailAccessToken()}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ raw: raw.toString('base64url') }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const err = new Error(`Gmail API responded ${res.status}: ${await res.text()}`);
    err.code = `GMAIL_${res.status}`;
    throw err;
  }
}

// --------------------------------------------------------------------------------
async function sendMail(message) {
  if (useGmailApi) return sendViaGmailApi(message);
  if (!transporter) {
    const { to, subject, text } = message;
    outbox.push({ to, subject, text });
    if (outbox.length > 50) outbox.shift();
    if (!config.isTest) console.log(`[mail:dev] to=${to} | ${subject} | ${text}`);
    return;
  }
  await transporter.sendMail({ from: config.smtp.from, ...message });
}

function sendOtpEmail(to, code, purpose) {
  const action = purpose === 'signup' ? 'verify your email' : 'reset your password';
  const minutes = config.otp.ttlMinutes;
  return sendMail({
    to,
    subject: `${code} is your Kaksha verification code`,
    text: `Use ${code} to ${action}. The code expires in ${minutes} minutes. If you did not request this, ignore this email.`,
    html: `<p>Use <b style="font-size:20px;letter-spacing:3px">${code}</b> to ${action}.</p>
<p>The code expires in ${minutes} minutes. If you did not request this, you can ignore this email.</p>
<p>— Kaksha</p>`,
  });
}

module.exports = { sendMail, sendOtpEmail, outbox };
