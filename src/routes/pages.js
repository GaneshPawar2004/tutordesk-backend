const path = require('path');
const express = require('express');

/** Public web pages: homepage and privacy policy (linked from Google sign-in branding). */
const router = express.Router();

const page = (title, body) => `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  body { font: 16px/1.6 system-ui, sans-serif; max-width: 720px; margin: 40px auto; padding: 0 20px; color: #222; }
  h1 { color: #283593; } h2 { margin-top: 28px; }
</style>
</head>
<body>
${body}
<p style="margin-top:40px;color:#777">&copy; Intellectual Digital Solutions</p>
</body>
</html>`;

router.get('/', (_req, res) => {
  res.type('html').send(
    page(
      'Kaksha',
      `<h1>Kaksha</h1>
<p>Kaksha is a tuition-management app for teachers in India: classes, students,
attendance, tests and fees in one place. Crafted by a teacher, for teachers.</p>
<p><a href="/privacy">Privacy Policy</a></p>`,
    ),
  );
});

router.get('/privacy', (_req, res) => {
  res.type('html').send(
    page(
      'Kaksha — Privacy Policy',
      `<h1>Privacy Policy</h1>
<p>Last updated: 2 November 2026</p>
<p>This policy explains what the Kaksha app ("Kaksha", "we") collects and how it is used.</p>

<h2>Information we collect</h2>
<ul>
  <li><b>Account details:</b> your name, email address, mobile number and password
  (stored only as a secure hash).</li>
  <li><b>Records you enter:</b> classes, students and their contact details, attendance,
  test marks, fees and staff logins that you add to the app.</li>
</ul>

<h2>How we use it</h2>
<ul>
  <li>To provide the app's features to you and to the staff you allow.</li>
  <li>To email you verification codes when you sign up or reset your password.
  These emails are sent from our Gmail account; we only use Gmail to send them.</li>
</ul>
<p>We do not sell your information or use it for advertising. Each institute's data is
visible only to its own admin and staff logins.</p>

<h2>SMS and calls</h2>
<p>When you message or call a parent from the app, it opens your phone's own SMS or
dialer app. These messages are sent from your SIM; Kaksha does not receive them.</p>

<h2>Storage and deletion</h2>
<p>Data is stored on secured cloud servers. You can delete students, classes and staff
in the app at any time. To delete your whole account and all its data, use My Profile → Delete account
in the app, or email us.</p>

<h2>Contact</h2>
<p>Questions or requests: <a href="mailto:ganeshpawardev@gmail.com">ganeshpawardev@gmail.com</a></p>`,
    ),
  );
});

router.get('/terms', (_req, res) => {
  res.type('html').send(
    page(
      'Kaksha — Terms & Conditions',
      `<h1>Terms &amp; Conditions</h1>
<p>Last updated: 4 November 2026</p>
<p>By creating an account or using the Kaksha app you agree to these terms.</p>

<h2>Your account</h2>
<ul>
  <li>Kaksha is for tuition teachers and coaching institutes in India.</li>
  <li>You are responsible for the logins you create for your staff and for keeping passwords safe.</li>
  <li>You must have the consent of students and parents to store their details and contact them.</li>
</ul>

<h2>Free trial and access</h2>
<ul>
  <li>New accounts get a free trial. After it ends, continued access must be activated by us.</li>
  <li>We may pause an account that is misused, for example to send spam.</li>
</ul>

<h2>SMS and WhatsApp</h2>
<p>Messages to parents are sent from your own phone, SIM and WhatsApp. Your mobile operator's
charges and limits apply, and you are responsible for their content.</p>

<h2>Your data</h2>
<p>The records you enter belong to you. See our <a href="/privacy">Privacy Policy</a> for how
they are stored. You can delete your account and all its data from the app (My Profile).</p>

<h2>Availability</h2>
<p>We work to keep Kaksha available and your data safe, but the service is provided "as is",
without a guarantee that it will always be uninterrupted or error-free.</p>

<h2>Contact</h2>
<p>Questions: <a href="mailto:ganeshpawardev@gmail.com">ganeshpawardev@gmail.com</a></p>`,
    ),
  );
});

// Admin page (sign in with ADMIN_API_KEY); its script is a separate file because
// the security headers (helmet) do not allow inline scripts.
const PUBLIC = path.join(__dirname, '..', 'public');
router.get('/admin', (_req, res) => res.sendFile(path.join(PUBLIC, 'admin.html')));
router.get('/admin.js', (_req, res) => res.sendFile(path.join(PUBLIC, 'admin.js')));

module.exports = router;
