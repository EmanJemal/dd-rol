const fs = require('fs');
const readline = require('readline');
const { google } = require('googleapis');

const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];
const TOKEN_PATH = 'token.json';
const CREDENTIALS_PATH = 'credentials.json';

function authorizeAndFetchCode(callback) {
  fs.readFile(CREDENTIALS_PATH, (err, content) => {
    if (err) return console.error('Error loading credentials.json:', err);
    const credentials = JSON.parse(content);
    const { client_secret, client_id, redirect_uris } = credentials.installed;

    const oAuth2Client = new google.auth.OAuth2(
      client_id, client_secret, redirect_uris[0]
    );

    fs.readFile(TOKEN_PATH, (err, token) => {
      if (err) return getNewToken(oAuth2Client, callback);
      oAuth2Client.setCredentials(JSON.parse(token));
      callback(oAuth2Client);
    });
  });
}

function getNewToken(oAuth2Client, callback) {
  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES
  });

  console.log('🔑 Authorize this app by visiting this URL:', authUrl);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question('Enter the code from that page here: ', (code) => {
    rl.close();
    oAuth2Client.getToken(code, (err, token) => {
      if (err) return console.error('Error retrieving token:', err);
      oAuth2Client.setCredentials(token);
      fs.writeFile(TOKEN_PATH, JSON.stringify(token), () => {});
      callback(oAuth2Client);
    });
  });
}

function fetchLatestVerificationCode(auth) {
  const gmail = google.gmail({ version: 'v1', auth });

  gmail.users.messages.list({
    userId: 'me',
    maxResults: 5,
    q: 'subject:code OR subject:verification newer_than:1d'
  }, (err, res) => {
    if (err) return console.error('API returned an error:', err);
    const messages = res.data.messages;
    if (!messages || messages.length === 0) {
      console.log('No matching emails found.');
      return;
    }

    const msgId = messages[0].id;
    gmail.users.messages.get({
      userId: 'me',
      id: msgId
    }, (err, res) => {
      if (err) return console.error('Failed to get message:', err);
      const body = res.data.snippet;
      const codeMatch = body.match(/\b\d{6}\b/); // 6-digit code
      if (codeMatch) {
        console.log('✅ Latest code:', codeMatch[0]);
      } else {
        console.log('No code found in message.');
      }
    });
  });
}

authorizeAndFetchCode(fetchLatestVerificationCode);
