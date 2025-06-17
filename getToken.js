const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { google } = require('googleapis');

const CREDENTIALS_PATH = path.join(__dirname, 'credentials.json');
const TOKEN_DIR = path.join(__dirname, 'tokens');

const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];

function authorize() {
  const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
  const { client_secret, client_id, redirect_uris } = credentials.installed;

  return new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
}

function getNewToken(oAuth2Client, email, callback) {
  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
  });
  console.log('Authorize this app by visiting this url:', authUrl);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  rl.question('Enter the code from that page here: ', (code) => {
    rl.close();
    oAuth2Client.getToken(code, (err, token) => {
      if (err) return console.error('Error retrieving access token', err);
      if (!fs.existsSync(TOKEN_DIR)) {
        fs.mkdirSync(TOKEN_DIR);
      }
      const tokenPath = path.join(TOKEN_DIR, `token-${email}.json`);
      fs.writeFileSync(tokenPath, JSON.stringify(token));
      console.log(`Token stored to ${tokenPath}`);
      callback(oAuth2Client);
    });
  });
}

function main() {
  const oAuth2Client = authorize();
  const email = process.argv[2]; // pass email as argument

  if (!email) {
    console.error('Please provide an email as a command line argument.');
    process.exit(1);
  }

  getNewToken(oAuth2Client, email, () => {
    console.log('Token saved successfully!');
  });
}

main();
