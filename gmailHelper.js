// gmailHelper.js
const fs = require('fs');
const path = require('path');
const {google} = require('googleapis');

const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];
const TOKEN_PATH = path.join(__dirname, 'token.json');

const oAuth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);

async function authorize() {
  try {
    const token = fs.readFileSync(TOKEN_PATH);
    oAuth2Client.setCredentials(JSON.parse(token));
  } catch (err) {
    throw new Error('No token found. Please authorize your app first.');
  }
  return oAuth2Client;
}

const imaps = require('imap-simple');

async function fetchLatestCodeFromEmail(email, password) {
  const config = {
    imap: {
      user: email,
      password: password,
      host: 'imap.gmail.com', // adjust if not Gmail
      port: 993,
      tls: true,
      authTimeout: 3000,
      tlsOptions: { rejectUnauthorized: false }
    }
  };

  try {
    const connection = await imaps.connect(config);
    await connection.openBox('INBOX');

    // Search for latest email FROM Netflix
    const searchCriteria = [
      ['FROM', 'no-reply@netflix.com']
    ];

    // Fetch full body
    const fetchOptions = { bodies: ['TEXT'], markSeen: false };

    const messages = await connection.search(searchCriteria, fetchOptions);

    if (messages.length === 0) {
      await connection.end();
      return null;
    }

    // Take the newest email (last in array)
    const latestEmail = messages[messages.length - 1];
    const allParts = latestEmail.parts.find(part => part.which === 'TEXT');

    const body = allParts.body; // whole email body (usually plain text)

    await connection.end();
    return body;

  } catch (error) {
    console.error('Error fetching email:', error);
    return null;
  }
}


module.exports = { fetchLatestCodeFromEmail };
