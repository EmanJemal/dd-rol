const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

const CREDENTIALS_PATH = path.join(__dirname, 'credentials.json');
const TOKENS_DIR = path.join(__dirname, 'tokens');

async function authorize(email) {
  const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
  const { client_secret, client_id, redirect_uris } = credentials.installed;

  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

  const TOKEN_PATH = path.join(__dirname, `tokens/token-${email}.json`);
  if (!fs.existsSync(TOKEN_PATH)) {
    throw new Error(`❌ No token file found for ${email}`);
  }


  const token = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
  oAuth2Client.setCredentials(token);

  return oAuth2Client;
}

async function fetchLatestCodeFromEmail(email) {
  const auth = await authorize(email);
  const gmail = google.gmail({ version: 'v1', auth });

  const res = await gmail.users.messages.list({
    userId: 'me',
    maxResults: 10,
    q: 'from:info@account.netflix.com subject:"Netflix: Your sign-in code" newer_than:1h'
  });

  const messages = res.data.messages;
  if (!messages || messages.length === 0) return null;

  const now = Date.now();
  const THREE_MINUTES = 3 * 60 * 1000;

  for (const message of messages) {
    const msg = await gmail.users.messages.get({ userId: 'me', id: message.id });
    const internalDate = parseInt(msg.data.internalDate);

    if ((now - internalDate) <= THREE_MINUTES) {
      const payload = msg.data.payload;
      let body = '';

      if (payload.parts) {
        const part = payload.parts.find(p => p.mimeType === 'text/plain');
        if (part?.body?.data) {
          body = Buffer.from(part.body.data, 'base64').toString('utf8');
        }
      } else if (payload.body?.data) {
        body = Buffer.from(payload.body.data, 'base64').toString('utf8');
      }

      const match = body.match(/\b\d{4}\b/); // Look for 4-digit code
      if (match) return match[0];
    }
  }

  return null;
}

module.exports = { fetchLatestCodeFromEmail };
