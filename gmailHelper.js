// gmailHelper.js
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

const TOKEN_PATH = path.join(__dirname, 'token.json');
const CREDENTIALS_PATH = path.join(__dirname, 'credentials.json');

async function authorize() {
  const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
  const { client_secret, client_id, redirect_uris } = credentials.installed;
  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

  const token = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
  oAuth2Client.setCredentials(token);

  return oAuth2Client;
}

async function fetchLatestCodeFromEmail() {
  const auth = await authorize();
  const gmail = google.gmail({ version: 'v1', auth });

  const res = await gmail.users.messages.list({
    userId: 'me',
    maxResults: 5,
    q: 'from:account.netflix.com subject:(sign-in OR code) newer_than:1d'
  });
  

  const messages = res.data.messages;
  if (!messages || messages.length === 0) return null;

  const msg = await gmail.users.messages.get({ userId: 'me', id: messages[0].id });
  const payload = msg.data.payload;
  let body = '';

  if (payload.parts) {
    const part = payload.parts.find(p => p.mimeType === 'text/plain');
    body = Buffer.from(part.body.data, 'base64').toString('utf8');
  } else {
    body = Buffer.from(payload.body.data, 'base64').toString('utf8');
  }

  const match = body.match(/\b\d{4}\b/);
  return match ? match[0] : null;
}

module.exports = { fetchLatestCodeFromEmail };
