const admin = require("firebase-admin");

const serviceAccount = JSON.parse(
  Buffer.from(process.env.FIREBASE_KEY_B64, "base64").toString("utf-8")
);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://netflix-business-default-rtdb.firebaseio.com/"
});

const database = admin.database();
module.exports = { database };
