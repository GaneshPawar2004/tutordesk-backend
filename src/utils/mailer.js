const nodemailer = require('nodemailer');
const config = require('../config');

let transporter = null;
if (config.smtp.host) {
  transporter = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
  });
}

/** Messages "sent" while no SMTP is configured; tests read OTPs from here. */
const outbox = [];

async function sendMail({ to, subject, text, html }) {
  if (!transporter) {
    outbox.push({ to, subject, text });
    if (outbox.length > 50) outbox.shift();
    if (!config.isTest) console.log(`[mail:dev] to=${to} | ${subject} | ${text}`);
    return;
  }
  await transporter.sendMail({ from: config.smtp.from, to, subject, text, html });
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
