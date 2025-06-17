const fs = require('fs');
const readline = require('readline');
const path = require('path');
const { google } = require('googleapis');

const CREDENTIALS_PATH = path.join(__dirname, 'credentials.json'); // Your downloaded credentials from Google Cloud
const TOKEN_DIR = path.join(__dirname, 'tokens');
const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];

function getAccessToken(oAuth2Client, email) {
  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
  });
  console.log('👉 Authorize this app by visiting this url:\n', authUrl);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  rl.question('\n📥 Enter the code from that page here: ', (code) => {
    rl.close();
    oAuth2Client.getToken(code).then(({ tokens }) => {
      oAuth2Client.setCredentials(tokens);
      if (!fs.existsSync(TOKEN_DIR)) fs.mkdirSync(TOKEN_DIR);
      const tokenPath = path.join(TOKEN_DIR, `token-${email}.json`);
      fs.writeFileSync(tokenPath, JSON.stringify(tokens));
      console.log(`✅ Token stored at: ${tokenPath}`);
    }).catch(err => {
      console.error('❌ Error retrieving access token', err);
    });
  });
}

function start(email) {
  const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH));
  const { client_secret, client_id, redirect_uris } = credentials.installed;
  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
  getAccessToken(oAuth2Client, email);
}

const emailToAuth = 'pentawebdev1@gmail.com'; // ← Change this to the Gmail you're authorizing
start(emailToAuth);
