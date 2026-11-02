const nodemailer = require('nodemailer');
const config = require('../config');

/**
 * Email goes out through, in order of preference:
 * 1. Brevo's HTTPS API (BREVO_API_KEY): works on hosts that block SMTP ports,
 *    such as Render's free plan.
 * 2. SMTP (SMTP_HOST).
 * 3. Neither: the message is kept in `outbox` and printed (development/tests).
 * Tests never send real email, even when .env has these settings.
 */
const useBrevo = Boolean(config.brevoApiKey) && !config.isTest;

let transporter = null;
if (!useBrevo && config.smtp.host && !config.isTest) {
  transporter = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
    // Fail fast instead of hanging the request if the port is blocked.
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 20000,
  });
}

/** Messages "sent" while no email service is configured; tests read OTPs from here. */
const outbox = [];

/** "Kaksha <a@b.com>" -> { name: 'Kaksha', email: 'a@b.com' } */
function parseFrom(from) {
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(from);
  return m ? { name: m[1] || 'Kaksha', email: m[2] } : { name: 'Kaksha', email: from.trim() };
}

async function sendViaBrevo({ to, subject, text, html }) {
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': config.brevoApiKey, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      sender: parseFrom(config.smtp.from),
      to: [{ email: to }],
      subject,
      textContent: text,
      htmlContent: html || text,
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const err = new Error(`Brevo responded ${res.status}: ${await res.text()}`);
    err.code = `BREVO_${res.status}`;
    throw err;
  }
}

async function sendMail(message) {
  if (useBrevo) return sendViaBrevo(message);
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
