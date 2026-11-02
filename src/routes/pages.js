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
in the app at any time. To delete your whole account, email us and we will remove it.</p>

<h2>Contact</h2>
<p>Questions or requests: <a href="mailto:ganeshpawardev@gmail.com">ganeshpawardev@gmail.com</a></p>`,
    ),
  );
});

module.exports = router;
