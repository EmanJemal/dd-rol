const { google } = require('googleapis');

async function authorize(email) {
  const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);

  const tokenVarName =
    `GOOGLE_TOKEN_${email.replace(/[@.-]/g, '_').toUpperCase()}`;

  const tokenString = process.env[tokenVarName];

  if (!tokenString) {
    throw new Error(
      `❌ No Railway token variable found for ${email}. Expected: ${tokenVarName}`
    );
  }

  const token = JSON.parse(tokenString);

  const { client_id, client_secret, redirect_uris } =
    credentials.installed;

  const oAuth2Client = new google.auth.OAuth2(
    client_id,
    client_secret,
    redirect_uris[0]
  );

  oAuth2Client.setCredentials(token);

  return oAuth2Client;
}

async function fetchLatestCodeFromEmail(email) {
  const auth = await authorize(email);

  const gmail = google.gmail({
    version: 'v1',
    auth
  });

  const res = await gmail.users.messages.list({
    userId: 'me',
    maxResults: 10,
    q: 'from:info@account.netflix.com subject:"Netflix: Your sign-in code" newer_than:1h'
  });

  const messages = res.data.messages;

  if (!messages || messages.length === 0) {
    return null;
  }

  const now = Date.now();
  const THREE_MINUTES = 3 * 60 * 1000;

  for (const message of messages) {
    const msg = await gmail.users.messages.get({
      userId: 'me',
      id: message.id
    });

    const internalDate = parseInt(msg.data.internalDate);

    if ((now - internalDate) > THREE_MINUTES) {
      continue;
    }

    const payload = msg.data.payload;
    let body = '';

    if (payload.parts) {
      const part = payload.parts.find(
        p => p.mimeType === 'text/plain'
      );

      if (part?.body?.data) {
        body = Buffer.from(
          part.body.data.replace(/-/g, '+').replace(/_/g, '/'),
          'base64'
        ).toString('utf8');
      }
    } else if (payload.body?.data) {
      body = Buffer.from(
        payload.body.data.replace(/-/g, '+').replace(/_/g, '/'),
        'base64'
      ).toString('utf8');
    }

    const match = body.match(/\b\d{4}\b/);

    if (match) {
      return match[0];
    }
  }

  return null;
}

module.exports = {
  fetchLatestCodeFromEmail
};