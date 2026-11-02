// One-time setup for sending email with the Gmail API.
// Needs GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET (a "Desktop app" OAuth client) in .env.
// Opens Google sign-in in the browser; after you allow access, saves
// GMAIL_REFRESH_TOKEN to .env. Run: npm run gmail-auth
const fs = require('fs');
const http = require('http');
const path = require('path');
const { exec } = require('child_process');

require('dotenv').config({ quiet: true });

const ENV_FILE = path.join(__dirname, '..', '.env');
const SCOPE = 'https://www.googleapis.com/auth/gmail.send';
const clientId = process.env.GMAIL_CLIENT_ID;
const clientSecret = process.env.GMAIL_CLIENT_SECRET;

if (!clientId || !clientSecret) {
  console.error('Set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET in .env first.');
  process.exit(1);
}

/** Sets KEY=value in .env, replacing an existing line. */
function saveEnv(key, value) {
  let text = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf8') : '';
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, 'm');
  text = re.test(text) ? text.replace(re, line) : `${text.replace(/\n*$/, '\n')}${line}\n`;
  fs.writeFileSync(ENV_FILE, text);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname !== '/') return res.writeHead(404).end();
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');
  const done = (msg) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<p style="font:16px sans-serif">${msg}</p>`);
    server.close();
  };
  if (!code) {
    console.error('Google returned:', error || 'no code');
    return done('Access was not granted. You can close this tab.');
  }
  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
    });
    const data = await tokenRes.json();
    if (!data.refresh_token) throw new Error(JSON.stringify(data));
    saveEnv('GMAIL_REFRESH_TOKEN', data.refresh_token);
    console.log('Saved GMAIL_REFRESH_TOKEN to .env');
    done('Done! Kaksha can now send email. You can close this tab.');
  } catch (err) {
    console.error('Token exchange failed:', err.message);
    done('Something went wrong; see the terminal. You can close this tab.');
    process.exitCode = 1;
  }
});

let redirectUri;
server.listen(0, '127.0.0.1', () => {
  redirectUri = `http://127.0.0.1:${server.address().port}`;
  const authUrl =
    'https://accounts.google.com/o/oauth2/v2/auth?' +
    new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: SCOPE,
      access_type: 'offline',
      prompt: 'consent',
    });
  console.log('Opening Google sign-in. If it does not open, visit:\n' + authUrl);
  const opener = process.platform === 'win32' ? `start "" "${authUrl}"` : `open "${authUrl}"`;
  exec(opener);
});
