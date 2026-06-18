const fs = require('fs');
const readline = require('readline');
const { google } = require('googleapis');

const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];
const TOKEN_PATH = 'token.json';
const CREDENTIALS_PATH = 'credentials.json';

/**
 * MAIN ENTRY
 */
function start(callback) {
  fs.readFile(CREDENTIALS_PATH, (err, content) => {
    if (err) {
      console.error('❌ Error loading credentials.json:', err);
      return;
    }

    const credentials = JSON.parse(content);
    const { client_secret, client_id, redirect_uris } = credentials.installed;

    const oAuth2Client = new google.auth.OAuth2(
      client_id,
      client_secret,
      redirect_uris[0]
    );

    // Check if token exists
    fs.readFile(TOKEN_PATH, (err, token) => {
      if (err) {
        return getNewToken(oAuth2Client, callback);
      }

      oAuth2Client.setCredentials(JSON.parse(token));
      callback(oAuth2Client);
    });
  });
}

/**
 * GET NEW TOKEN (first time login)
 */
function getNewToken(oAuth2Client, callback) {
  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent'
  });

  console.log('\n🔑 Open this URL in your browser:\n');
  console.log(authUrl, '\n');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  rl.question('👉 Paste the authorization code here: ', (code) => {
    rl.close();

    oAuth2Client.getToken(code, (err, token) => {
      if (err) {
        console.error('❌ Error retrieving token:', err);
        return;
      }

      oAuth2Client.setCredentials(token);

      fs.writeFileSync(TOKEN_PATH, JSON.stringify(token));
      console.log('✅ Token saved to', TOKEN_PATH);

      callback(oAuth2Client);
    });
  });
}

/**
 * FETCH LATEST EMAIL OTP (Netflix-style)
 */
function fetchLatestVerificationCode(auth, callback) {
  const gmail = google.gmail({ version: 'v1', auth });

  gmail.users.messages.list(
    {
      userId: 'me',
      maxResults: 10,
      q: 'newer_than:1d'
    },
    (err, res) => {
      if (err) {
        console.error('❌ Gmail API error:', err);
        return callback(null);
      }

      const messages = res.data.messages;

      if (!messages || messages.length === 0) {
        console.log('❌ No emails found');
        return callback(null);
      }

      const msgId = messages[0].id;

      gmail.users.messages.get(
        {
          userId: 'me',
          id: msgId,
          format: 'full'
        },
        (err, res) => {
          if (err) {
            console.error('❌ Failed to read email:', err);
            return callback(null);
          }

          const payload = res.data.payload;

          let body = '';

          try {
            if (payload.parts && payload.parts.length) {
              const part =
                payload.parts.find(p => p.mimeType === 'text/plain') ||
                payload.parts[0];

              if (part?.body?.data) {
                body = Buffer.from(part.body.data, 'base64').toString('utf-8');
              }
            } else if (payload.body?.data) {
              body = Buffer.from(payload.body.data, 'base64').toString('utf-8');
            }
          } catch (e) {
            console.error('❌ Decode error:', e);
            return callback(null);
          }

          // Extract 4–8 digit code (more flexible than 6 digits only)
          const match = body.match(/\b\d{4,8}\b/);

          if (match) {
            console.log('✅ OTP FOUND:', match[0]);
            return callback(match[0]);
          } else {
            console.log('⚠️ No OTP found in email');
            return callback(null);
          }
        }
      );
    }
  );
}

/**
 * RUN
 */
start((auth) => {
  fetchLatestVerificationCode(auth, (code) => {
    if (code) {
      console.log('\n🚀 FINAL CODE:', code);
    } else {
      console.log('\n❌ No code found');
    }
  });
});