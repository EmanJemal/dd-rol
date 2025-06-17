const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { google } = require('googleapis');

const SCOPES = ['https://mail.google.com/'];
const CREDENTIALS_PATH = 'credentials.json';

fs.readFile(CREDENTIALS_PATH, (err, content) => {
  if (err) return console.error('Error loading credentials.json', err);
  const credentials = JSON.parse(content);
  const { client_secret, client_id, redirect_uris } = credentials.installed;

  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
  });

  console.log('Authorize this app by visiting this URL:', authUrl);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question('Enter the code from that page here: ', (code) => {
    rl.close();
    oAuth2Client.getToken(code, (err, token) => {
      if (err) return console.error('Error retrieving access token', err);
      oAuth2Client.setCredentials(token);

      // ✅ Ensure token directory exists
      const tokenDir = path.join(__dirname, 'tokens');
      if (!fs.existsSync(tokenDir)) {
        fs.mkdirSync(tokenDir);
      }

      const tokenPath = path.join(tokenDir, 'token-pentawebdev1@gmail.com.json');
      fs.writeFileSync(tokenPath, JSON.stringify(token));
      console.log('✅ Token stored to', tokenPath);
    });
  });
});
