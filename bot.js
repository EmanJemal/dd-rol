require('dotenv').config();
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');
const { google } = require('googleapis');
const { fetchLatestCodeFromEmail } = require('./gmailHelper');

// ✅ Load Firebase Admin SDK with secret from environment
const admin = require('firebase-admin');
const fs = require('fs');

const serviceAccountPath = process.env.FIREBASE_KEY_PATH;
if (!fs.existsSync(serviceAccountPath)) {
  console.error('❌ service account file not found');
  process.exit(1);
}

const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8'));

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: process.env.FIREBASE_DB_URL
});

const database = admin.database();
module.exports = { database };

// ✅ Bot & admin setup
const token = process.env.TELEGRAM_BOT_TOKEN;
const BOT_OWNER_ID = process.env.BOT_OWNER_ID;

if (!token) {
  console.error("❌ TELEGRAM_BOT_TOKEN is not defined in .env");
  process.exit(1);
}

// ✅ Data stores
const pendingPhotos = {}; // userId => true/false
const pendingConfirmations = {}; // key: ownerMessageId, value: { clientId, fileId, fileLink }
const activeCodeRequests = {}; // { [chatId_accountKey]: timestamp }
let usersMap = {};     // holds all users info by telegramCode
let expiredUsers = []; // holds users with expired/expiring accounts

function isAdmin(userId) {
  return userId.toString() === BOT_OWNER_ID;
}

// ✅ Initialize bot
const bot = new TelegramBot(token, { polling: true });
console.log("✅ Bot is up and running...");

// ✅ Handle /start command
bot.onText(/\/start/, async (msg) => {
  await showMainMenu(msg.chat.id, msg); // Pass full msg for user info
});

// Handle button interactions
bot.on('callback_query', async (callbackQuery) => {
  const chatId = callbackQuery.message.chat.id;
  const data = callbackQuery.data;

  try {
    await bot.answerCallbackQuery(callbackQuery.id); // Avoid "already answered" errors

    // ✅ Plan selection and purchase
    if (data.startsWith('select_plan_')) {
      const parts = data.split('_');
      const accountKey = parts[parts.length - 1];
      const planName = parts.slice(2, parts.length - 1).join(' ').replace(/_/g, ' ');

      const planSnapshot = await database.ref(`${accountKey}/plan/${planName}`).once('value');
      const price = planSnapshot.val();

      if (!price) {
        await bot.sendMessage(chatId, `❌ Plan "${planName}" not found.`);
        return;
      }

      const userSnapshot = await database.ref(`users/${chatId}`).once('value');
      const userData = userSnapshot.val();
      const balance = userData?.balance || 0;
      const username = userData?.contactInfo?.username || `user-${chatId}`;

      if (balance < price) {
        await bot.sendMessage(chatId, `❌ Insufficient balance. You need ${price} birr but only have ${balance} birr.`);
        return;
      }

      await database.ref(`users/${chatId}/balance`).set(balance - price);

      const purchaseDate = new Date().toISOString().split('T')[0];
      await database.ref(`users/${chatId}/accounts/${accountKey}`).set({
        plan: planName,
        purchaseDate,
        chance: 3
      });

      await database.ref(`${accountKey}/users/${username}`).set(true);

      await bot.sendMessage(chatId, `✅ Successfully purchased ${planName} from ${accountKey} for ${price} birr.`, {
        reply_markup: {
          inline_keyboard: [
            [{ text: "⬅️ Back to Menu", callback_data: 'back_to_menu' }]
          ]
        }
      });
      return;
    }

    // ✅ View plans under account
    if (data.startsWith('select_account_')) {
      const accountKey = data.replace('select_account_', '');
      const plansSnapshot = await database.ref(`${accountKey}/plan`).once('value');
      const plans = plansSnapshot.val();

      if (!plans) {
        await bot.sendMessage(chatId, `❌ No plans found for ${accountKey}.`);
        return;
      }

      const planButtons = Object.entries(plans).map(([planName, price]) => ([
        {
          text: `${planName} - ${price} birr`,
          callback_data: `select_plan_${planName.replace(/\s+/g, '_')}_${accountKey}`
        }
      ]));

      await bot.sendMessage(chatId, `📦 Plans for ${accountKey}:`, {
        reply_markup: {
          inline_keyboard: [
            ...planButtons,
            [{ text: "⬅️ Back to Accounts", callback_data: 'purchase_netflix' }]
          ]
        }
      });
      return;
    }

    // ✅ View individual account
    if (data.startsWith('view_account_')) {
      const accountKey = data.replace('view_account_', '');
      const userAccountSnap = await database.ref(`users/${chatId}/accounts/${accountKey}`).once('value');
      const accountData = userAccountSnap.val();
      const credentialSnap = await database.ref(`${accountKey}/credential`).once('value');
      const credentials = credentialSnap.val();
      const chance = accountData?.chance ?? 0;

      await bot.sendMessage(chatId, `<b>${accountKey}</b>\n ኮዱን ወደዚ <b><code>${credentials.email}</code></b>አካውንት ከላኩ ቡሃላ ብቻ, አንዴ Send code የሚለውን ይጫኑ`, {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [{ text: `✅ GET Code (${chance} chances)`, callback_data: `send_code_${accountKey}` }],
            [{ text: "🔗 Join Group", callback_data: `join_group_${accountKey}` }],
            [{ text: "➕ Add Chance", callback_data: `add_chance_${accountKey}` }],
            [{ text: "⬅️ Back to Accounts", callback_data: 'view_account' }]
          ]
        }
      });
      return;
    }

    // ✅ Send Gmail Code (limited attempts)
// ✅ Send Gmail Code (limited attempts)
if (data.startsWith('send_code_')) {
  const accountKey = data.replace('send_code_', '');
  const credentialSnap = await database.ref(`${accountKey}/credential`).once('value');
  const credentials = credentialSnap.val();

  if (!credentials || !credentials.email) {
    await bot.sendMessage(chatId, `❌ Credentials not found for ${accountKey}.`);
    return;
  }

  const requestKey = `${chatId}_${accountKey}`;
  if (activeCodeRequests[requestKey] && (Date.now() - activeCodeRequests[requestKey]) < 10000) {
    await bot.sendMessage(chatId, `⏳ Please wait a few seconds before requesting another code.`);
    return;
  }

  activeCodeRequests[requestKey] = Date.now();

  const code = await fetchLatestCodeFromEmail(credentials.email);

  setTimeout(() => delete activeCodeRequests[requestKey], 10000);

  if (!code) {
    await bot.sendMessage(chatId, `⚠️ No code found in your Gmail inbox yet. Please wait a few minutes and try again.`);
    return;
  }

  const userAccountRef = database.ref(`users/${chatId}/accounts/${accountKey}`);
  const accountSnap = await userAccountRef.once('value');
  const accountData = accountSnap.val();
  const currentChances = accountData?.chance || 0;

  if (currentChances === 0) {
    await bot.sendMessage(chatId, `❌ You don't have enough chances left.`);
    return;
  }

  const newChances = Math.max(currentChances - 1, 0);
  await userAccountRef.update({ chance: newChances });

  await bot.sendMessage(chatId, `📩 Latest Netflix Code:\n\n<code>${code}</code>\n\n🎯 Chances left: <b>${newChances}</b>`, {
    parse_mode: 'HTML'
  });
  return;
}


    // ✅ Menu handlers
    switch (data) {
      case 'back_to_menu':
        await showMainMenu(chatId);
        break;

      case 'add_fund':
        const photoPath = path.join(__dirname, 'plan.png');
        await bot.sendPhoto(chatId, photoPath, {
          caption: "💰 Add Fund\n\nPlease choose a payment method:",
          reply_markup: {
            inline_keyboard: [
              [{ text: "📲 Telebirr", callback_data: 'pay_telebirr' }],
              [{ text: "🏦 CBE", callback_data: 'pay_cbe' }],
              [{ text: "⬅️ Back to Menu", callback_data: 'back_to_menu' }]
            ]
          }
        }, { contentType: 'image/png' });
        break;

      case 'purchase_netflix':
        const snapshot = await database.ref('/').once('value');
        const allData = snapshot.val();
        const buttons = [];

        for (const accountKey of Object.keys(allData)) {
          if (accountKey.startsWith('Account-')) {
            buttons.push([{ text: accountKey, callback_data: `select_account_${accountKey}` }]);
          }
        }

        if (buttons.length === 0) {
          await bot.sendMessage(chatId, "❌ No Netflix accounts found.");
        } else {
          await bot.sendMessage(chatId, "📺 Select a Netflix account to view available plans:", {
            reply_markup: { inline_keyboard: buttons }
          });
        }
        break;

      case 'contact_support':
        await bot.sendMessage(chatId, "📞 Contact Support:\nTelegram: @bon_afro1\nEmail: bon_afro1@gmail.com", {
          reply_markup: {
            inline_keyboard: [
              [{ text: "⬅️ Back to Menu", callback_data: 'back_to_menu' }]
            ]
          }
        });
        break;

      case 'view_account':
        const userAccountsSnap = await database.ref(`users/${chatId}/accounts`).once('value');
        const accounts = userAccountsSnap.val();

        if (!accounts) {
          await bot.sendMessage(chatId, "😕 You haven't purchased any accounts yet.", {
            reply_markup: {
              inline_keyboard: [
                [{ text: "🎬 Purchase Netflix", callback_data: 'purchase_netflix' }],
                [{ text: "⬅️ Back to Menu", callback_data: 'back_to_menu' }]
              ]
            }
          });
        } else {
          const accountButtons = Object.keys(accounts).map(account => [
            { text: account, callback_data: `view_account_${account}` }
          ]);

          await bot.sendMessage(chatId, "📺 Your Netflix Accounts:\nSelect an account to view details:", {
            reply_markup: {
              inline_keyboard: [
                ...accountButtons,
                [{ text: "⬅️ Back to Menu", callback_data: 'back_to_menu' }]
              ]
            }
          });
        }
        break;

      case 'pay_telebirr':
        pendingPhotos[chatId] = true;
        await bot.sendMessage(chatId, "📲 Telebirr Payment Info:\nSend to +251912345678\nName: Bon_Afro\nThen send the screenshot here.", {
          reply_markup: {
            inline_keyboard: [
              [{ text: "⬅️ Back to Menu", callback_data: 'back_to_menu' }]
            ]
          }
        });
        break;

      case 'pay_cbe':
        pendingPhotos[chatId] = true;
        await bot.sendMessage(chatId, "🏦 CBE Payment Info:\nAcct: 1000123456789\nName: Bon_Afro\nThen send the screenshot here.", {
          reply_markup: {
            inline_keyboard: [
              [{ text: "⬅️ Back to Menu", callback_data: 'back_to_menu' }]
            ]
          }
        });
        break;

      default:
        await bot.sendMessage(chatId, "❓ Unknown option or under construction.", {
          reply_markup: {
            inline_keyboard: [
              [{ text: "⬅️ Back to Menu", callback_data: 'back_to_menu' }]
            ]
          }
        });
    }

  } catch (error) {
    console.error("❌ Error handling callback_query:", error);
    await bot.sendMessage(chatId, "⚠️ An error occurred. Please try again later.");
  }

  if (data === 'notify_expired') {
    if (!expiredUsers || expiredUsers.length === 0) {
      return bot.sendMessage(chatId, "❌ No expired users stored. Please run /listusers first.");
    }
  
    for (const user of expiredUsers) {
      try {
        await bot.sendMessage(user.telegramCode, "⚠️ Your subscription has expired or is about to expire. Please renew to avoid disconnection.");
      } catch (err) {
        console.error(`❌ Failed to notify ${user.telegramCode}:`, err.message);
      }
    }
    await bot.sendMessage(chatId, "✅ Notifications sent to all expired users.");
  }
  
  if (data === 'logout_expired') {
    bot.sendMessage(chatId, "✏️ Send the Telegram code of the user you want to logout:");
  
    bot.once('message', async (replyMsg) => {
      const targetId = replyMsg.text.trim();
      if (!/^\d+$/.test(targetId)) {
        return bot.sendMessage(chatId, "❌ Invalid Telegram code.");
      }
  
      try {
        const userSnapshot = await database.ref(`users/${targetId}`).once('value');
        const userData = userSnapshot.val();
  
        if (!userData || !userData.accounts) {
          return bot.sendMessage(chatId, "❌ This user has no accounts to remove.");
        }
  
        const username = userData.contactInfo?.username || `user-${targetId}`;
        const now = moment();
  
        let removedCount = 0;
  
        for (const accountKey in userData.accounts) {
          const acc = userData.accounts[accountKey];
          const plan = acc.plan || '1 Month';
          const purchaseDate = acc.purchaseDate;
  
          const planDays = {
            "1 Month": 30,
            "2 Months": 60,
            "3 Months": 90
          }[plan] || 30;
  
          const purchaseMoment = moment(purchaseDate, "YYYY-MM-DD");
          const expiryMoment = purchaseMoment.clone().add(planDays, 'days');
  
          if (expiryMoment.diff(now, 'days') < 0) {
            // Remove from user's account list
            await database.ref(`users/${targetId}/accounts/${accountKey}`).remove();
  
            // Remove from the global account's users list
            await database.ref(`${accountKey}/users/${username}`).remove();
  
            removedCount++;
          }
        }
  
        if (removedCount === 0) {
          await bot.sendMessage(chatId, `✅ User ${targetId} has no expired accounts to remove.`);
        } else {
          await bot.sendMessage(chatId, `✅ Removed ${removedCount} expired account(s) from user ${targetId}.`);
          await bot.sendMessage(targetId, "🚫 One or more of your accounts were logged out due to expired subscription.");
        }
  
      } catch (err) {
        console.error(err.message);
        await bot.sendMessage(chatId, `❌ Failed to logout expired accounts for user ${targetId}.`);
      }
    });
  }
  

});

bot.on('photo', async (msg) => {
  const chatId = msg.chat.id;

  if (!pendingPhotos[chatId]) return;
  pendingPhotos[chatId] = false;

  try {
    const photo = msg.photo[msg.photo.length - 1];
    const fileId = photo.file_id;

    console.log("fileId received:", fileId);

    const fileLink = await bot.getFileLink(fileId);
    console.log("fileLink resolved:", fileLink);

    if (!fileLink) throw new Error("❌ fileLink is undefined");

    await database.ref(`payments/${chatId}`).push({
      fileId,
      fileLink,
      timestamp: Date.now()
    });

    await bot.sendMessage(chatId, "✅ Screenshot received! We'll review it soon.");

    // 👇 Forward to owner & track confirmation
    const sentMessage = await bot.sendPhoto(BOT_OWNER_ID, fileId, {
      caption: `🧾 New payment screenshot from @${msg.from.username || 'unknown'} (ID: ${chatId})\n\nPlease reply with the amount in ETB.`,
    });

    pendingConfirmations[sentMessage.message_id] = {
      clientId: chatId,
      fileId,
      fileLink
    };

  } catch (error) {
    console.error("❌ Error handling photo:", error);
    await bot.sendMessage(chatId, "⚠️ Error while handling the image. Please try again.");
  }
});


bot.on('message', async (msg) => {
  if (msg.chat.id.toString() !== BOT_OWNER_ID) return;
  if (!msg.reply_to_message) return;

  const originalId = msg.reply_to_message.message_id;
  const entry = pendingConfirmations[originalId];
  if (!entry) return;

  const amount = parseFloat(msg.text);
  if (isNaN(amount) || amount <= 0) {
    await bot.sendMessage(BOT_OWNER_ID, "❌ Please enter a valid numeric amount.");
    return;
  }

  const { clientId, fileId, fileLink } = entry;

  try {
    // 1. Save screenshot reference permanently
    await database.ref(`users/${clientId}/payments`).push({
      fileId,
      fileLink,
      timestamp: Date.now(),
      addedBy: 'owner',
      amount
    });

    // 2. Update user's balance
    const balanceRef = database.ref(`users/${clientId}/balance`);
    const snapshot = await balanceRef.once('value');
    const oldBalance = snapshot.val() || 0;
    await balanceRef.set(oldBalance + amount);

    // 3. Notify both parties
    await bot.sendMessage(clientId, `✅ Your fund of ${amount} birr has been approved and added to your account.`, {
      reply_markup: {
        inline_keyboard: [
          [{ text: "⬅️ Back to Menu", callback_data: 'back_to_menu' }]
        ]
      }
    });
    

    await bot.sendMessage(BOT_OWNER_ID, `✅ Updated balance of user ${clientId} (+${amount} birr).`);

    delete pendingConfirmations[originalId]; // Clean up
  } catch (error) {
    console.error("❌ Error updating balance:", error);
    await bot.sendMessage(BOT_OWNER_ID, "⚠️ Failed to update balance. Check logs.");
  }
});

const adminSessions = {}; // store admin's ongoing store steps

bot.onText(/\/store/, async (msg) => {
  if (msg.chat.id.toString() !== BOT_OWNER_ID) {
    return bot.sendMessage(msg.chat.id, "❌ You are not authorized to use this command.");
  }

  adminSessions[msg.chat.id] = {
    step: 'askAccountKey',
    data: {}
  };

  await bot.sendMessage(msg.chat.id, "🛠️ Let's add a new Netflix account.\n\nPlease enter the **account key** (e.g. Account-1):", {parse_mode: 'Markdown'});
});

bot.on('message', async (msg) => {
  const chatId = msg.chat.id.toString();

  // Only proceed if admin has an active session
  if (!adminSessions[chatId]) return;

  // Ignore commands to avoid conflicts except /cancel
  if (msg.text && msg.text.startsWith('/') && msg.text !== '/cancel') return;

  const session = adminSessions[chatId];

  try {
    switch (session.step) {
      case 'askAccountKey':
        {
          const accountKey = msg.text.trim();
          if (!accountKey.match(/^Account-\d+$/i)) {
            await bot.sendMessage(chatId, "❌ Invalid format. Account key must look like 'Account-1' or 'Account-123'. Please enter again:");
            return;
          }
          session.data.accountKey = accountKey;

          // Check if account already exists
          const snap = await database.ref(accountKey).once('value');
          if (snap.exists()) {
            await bot.sendMessage(chatId, `❌ Account key "${accountKey}" already exists. Please enter a different one:`);
            return;
          }

          session.step = 'askPlanName';
          session.data.plans = {};
          await bot.sendMessage(chatId, "Great! Now enter the first plan name (e.g., '1 month'):");
        }
        break;

      case 'askPlanName':
        {
          const planName = msg.text.trim();
          if (!planName) {
            await bot.sendMessage(chatId, "❌ Plan name cannot be empty. Please enter again:");
            return;
          }
          session.currentPlanName = planName;
          session.step = 'askPlanPrice';

          await bot.sendMessage(chatId, `Enter the price (in birr) for plan "${planName}":`);
        }
        break;

      case 'askPlanPrice':
        {
          const price = parseFloat(msg.text.trim());
          if (isNaN(price) || price <= 0) {
            await bot.sendMessage(chatId, "❌ Invalid price. Please enter a positive number:");
            return;
          }

          // Save plan
          session.data.plans[session.currentPlanName] = price;
          session.currentPlanName = null;

          session.step = 'askMorePlansOrEmail';
          await bot.sendMessage(chatId, "Plan added. Would you like to add another plan? (yes/no)");
        }
        break;

      case 'askMorePlansOrEmail':
        {
          const text = msg.text.trim().toLowerCase();
          if (text === 'yes' || text === 'y') {
            session.step = 'askPlanName';
            await bot.sendMessage(chatId, "Enter the next plan name:");
            return;
          }
          if (text === 'no' || text === 'n') {
            session.step = 'askEmail';
            await bot.sendMessage(chatId, "Please enter the Netflix account email:");
            return;
          }
          await bot.sendMessage(chatId, "Please reply with 'yes' or 'no':");
        }
        break;

      case 'askEmail':
        {
          const email = msg.text.trim();
          if (!email.match(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)) {
            await bot.sendMessage(chatId, "❌ Invalid email format. Please enter a valid email:");
            return;
          }
          session.data.email = email;
          session.step = 'askPassword';
          await bot.sendMessage(chatId, "Please enter the Netflix account password:");
        }
        break;

      case 'askPassword':
        {
          const password = msg.text.trim();
          if (!password) {
            await bot.sendMessage(chatId, "❌ Password cannot be empty. Please enter again:");
            return;
          }
          session.data.password = password;

          // Save to Firebase
          const { accountKey, plans, email } = session.data;

          await database.ref(accountKey).set({
            plan: plans,
            credential: { email, password },
            users: {}
          });

          await bot.sendMessage(chatId, `✅ Successfully added account "${accountKey}" with ${Object.keys(plans).length} plan(s).`);

          // Clear session
          delete adminSessions[chatId];
        }
        break;

      default:
        await bot.sendMessage(chatId, "❌ Unknown step. Please /cancel and try again.");
        delete adminSessions[chatId];
    }
  } catch (error) {
    console.error("❌ Error in admin store flow:", error);
    await bot.sendMessage(chatId, "⚠️ Something went wrong. Please /cancel and try again.");
    delete adminSessions[chatId];
  }
});

// Optional: /cancel command to abort the flow
bot.onText(/\/cancel/, async (msg) => {
  const chatId = msg.chat.id.toString();
  if (adminSessions[chatId]) {
    delete adminSessions[chatId];
    await bot.sendMessage(chatId, "❎ Admin store flow cancelled.");
  }
});

// Show the main menu
async function showMainMenu(chatId, msg = null) {
  const userRef = database.ref(`users/${chatId}`);

  try {
    const snapshot = await userRef.once('value');
    const userData = snapshot.val();

    const inlineButtons = [
      [{ text: "💰 Add Fund", callback_data: 'add_fund' }],
      [{ text: "🎬 Purchase Netflix", callback_data: 'purchase_netflix' }],
      [{ text: "📺 View Accounts", callback_data: 'view_account' }],
      [{ text: "📞 Contact Support", callback_data: 'contact_support' }]
    ];

    if (userData && userData.account) {
      inlineButtons.push([{ text: `📺 View ${userData.account}`, callback_data: 'view_account' }]);
    }

    if (!userData) {
      let contactInfo = {
        first_name: null,
        last_name: null,
        username: null,
        user_id: null,
        language_code: null,
        phone: null,
        email: null
      };

      if (msg && msg.from) {
        const { from } = msg;
        contactInfo = {
          first_name: from.first_name || null,
          last_name: from.last_name || null,
          username: from.username || null,
          user_id: from.id || null,
          language_code: from.language_code || null,
          phone: null,
          email: null
        };
      }

      await userRef.set({
        balance: 0,
        purchases: [],
        account: null,
        codeRequests: [],
        contactInfo
      });

      // Send image with caption and inline buttons together
      const photoPath = path.join(__dirname, 'dfc05852-8422-433a-8017-de35ea5a2144.png');

      await bot.sendPhoto(chatId, photoPath, {
        caption: "👣 Here's how it works:\n\n✅ Account registered! 👋 Welcome! Please choose an option:",
        reply_markup: {
          inline_keyboard: inlineButtons
        }
      },{ contentType: 'image/png' });
      

    } else {
      await bot.sendMessage(chatId, `👋 Welcome back! Your balance: ETB 🇪🇹 <b>${userData.balance} birr</b>`, {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: inlineButtons }
      });
    }

  } catch (error) {
    console.error("❌ Error in showMainMenu:", error);
    await bot.sendMessage(chatId, "⚠️ An error occurred. Please try again later.");
  }
}


bot.onText(/\/send/, async (msg) => {
  const chatId = msg.chat.id;
  if (!isAdmin(chatId)) return;

  bot.sendMessage(chatId, "📣 Send the message:");
  
  bot.once('message', async (replyMsg) => {
    const broadcastText = replyMsg.text;
    if (!broadcastText || broadcastText.startsWith('/')) return;

    const usersSnapshot = await database.ref('users').once('value');
    const users = usersSnapshot.val();

    if (!users) return bot.sendMessage(chatId, "❌ No users found.");

    for (const userId in users) {
      try {
        await bot.sendMessage(userId, `📢:${broadcastText}`);
      } catch (err) {
        console.error(`❌ Failed to send to ${userId}:`, err.message);
      }
    }

    bot.sendMessage(chatId, "✅ Message sent to all users.");
  });
});


bot.onText(/\/sto (\d+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  if (!isAdmin(chatId)) return;

  const targetId = match[1];
  bot.sendMessage(chatId, `✉️ Enter the message to send to user ${targetId}:`);

  bot.once('message', async (replyMsg) => {
    const message = replyMsg.text;
    if (!message || message.startsWith('/')) return;

    try {
      await bot.sendMessage(targetId, `📬:${message}`);
      bot.sendMessage(chatId, `✅ Message sent to ${targetId}.`);
    } catch (error) {
      console.error(error.message);
      bot.sendMessage(chatId, `❌ Failed to send to ${targetId}.`);
    }
  });
});



const moment = require('moment'); // At the top of your file

bot.onText(/\/listusers/, async (msg) => {
  const chatId = msg.chat.id;
  if (!isAdmin(chatId)) return;

  try {
    const snapshot = await database.ref('users').once('value');
    usersMap = snapshot.val() || {};
    expiredUsers = [];

    if (!usersMap || Object.keys(usersMap).length === 0) {
      return bot.sendMessage(chatId, "❌ No users found.");
    }

    let messageChunks = [];
    let currentChunk = "";

    for (const telegramCode in usersMap) {
      const user = usersMap[telegramCode];
      const contact = user.contactInfo || {};
      const accounts = user.accounts || {};
      const balance = user.balance || 0;

      let userText = `👤 ${contact.username || contact.first_name || 'Unknown'}\n`;
      userText += `🆔 Telegram Code: ${telegramCode}\n`;
      userText += `💰 Balance: ${balance}\n`;

      if (Object.keys(accounts).length > 0) {
        userText += `📦 Accounts:\n`;

        let isExpired = false;

        for (const accName in accounts) {
          const acc = accounts[accName];
          const plan = acc.plan || 'Unknown';
          const startDate = acc.purchaseDate || null;
          const chance = acc.chance ?? '-';

          const planDays = {
            "1 Month": 30,
            "2 Months": 60,
            "3 Months": 90
          }[plan] || 0;

          let daysLeftText = 'Unknown';
          if (startDate) {
            const purchaseMoment = moment(startDate, "YYYY-MM-DD");
            const expiryMoment = purchaseMoment.clone().add(planDays, 'days');
            const now = moment();

            const daysLeft = expiryMoment.diff(now, 'days');

            if (daysLeft >= 0) {
              daysLeftText = `${daysLeft} day(s) left`;
              if (daysLeft <= 3) isExpired = true;
            } else {
              daysLeftText = `Expired ${Math.abs(daysLeft)} day(s) ago`;
              isExpired = true;
            }
          }

          userText += `  - ${accName} | ${plan} | ${startDate} | ${chance} chances | ⏳ ${daysLeftText}\n`;
        }

        if (isExpired) {
          expiredUsers.push({
            username: contact.username || contact.first_name || 'Unknown',
            telegramCode
          });
        }

      } else {
        userText += `📦 Accounts: None\n`;
      }

      userText += `\n`;

      if ((currentChunk + userText).length > 3500) {
        messageChunks.push(currentChunk);
        currentChunk = "";
      }
      currentChunk += userText;
    }

    if (currentChunk) {
      messageChunks.push(currentChunk);
    }

    for (const chunk of messageChunks) {
      await bot.sendMessage(chatId, chunk);
    }

    // Send second message listing expired/expiring users
    if (expiredUsers.length > 0) {
      let expireText = `⚠️ Expiring/Expired Subscriptions:\n\n`;

      for (const user of expiredUsers) {
        expireText += `👤 ${user.username}\n🆔 ${user.telegramCode}\n\n`;
      }

      await bot.sendMessage(chatId, expireText, {
        reply_markup: {
          inline_keyboard: [
            [{ text: "✅ Notify Expired Users", callback_data: 'notify_expired' }],
            [{ text: "🚫 Logout Specific User", callback_data: 'logout_expired' }]
          ]
        }
      });
    } else {
      await bot.sendMessage(chatId, "✅ No users with expired or near-expired subscriptions.");
    }

  } catch (error) {
    console.error("❌ Error listing users:", error.message);
    bot.sendMessage(chatId, "❌ Failed to fetch user list.");
  }
});


bot.onText(/\/adddate/, async (msg) => {
  const chatId = msg.chat.id;
  if (!isAdmin(chatId)) return;

  bot.sendMessage(chatId, "📨 Please send the Telegram code of the user:");

  bot.once('message', async (codeMsg) => {
    const userCode = codeMsg.text.trim();
    if (!/^\d+$/.test(userCode)) {
      return bot.sendMessage(chatId, "❌ Invalid Telegram code.");
    }

    const userSnapshot = await database.ref(`users/${userCode}`).once('value');
    const userData = userSnapshot.val();

    if (!userData) {
      return bot.sendMessage(chatId, "❌ No user found with this Telegram code.");
    }

    const username = userData.contactInfo?.username || userData.contactInfo?.first_name || `user-${userCode}`;

    bot.sendMessage(chatId, "📂 Send the account name to update or add:");

    bot.once('message', async (accountMsg) => {
      const accountKey = accountMsg.text.trim();

      if (!accountKey) {
        return bot.sendMessage(chatId, "❌ Account name cannot be empty.");
      }

      bot.sendMessage(chatId, "🗓️ Send the new purchase date (format: YYYY-MM-DD):");

      bot.once('message', async (dateMsg) => {
        const dateText = dateMsg.text.trim();
        const isValidDate = /^\d{4}-\d{2}-\d{2}$/.test(dateText);

        if (!isValidDate) {
          return bot.sendMessage(chatId, "❌ Invalid date format. Please use YYYY-MM-DD.");
        }

        try {
          // Update the user's purchase date
          const userAccountRef = database.ref(`users/${userCode}/accounts/${accountKey}`);
          await userAccountRef.update({
            purchaseDate: dateText
          });

          // Ensure plan and chance exist
          const defaults = {};
          const accountSnapshot = await userAccountRef.once('value');
          if (!accountSnapshot.val()?.plan) defaults.plan = "1 Month";
          if (!accountSnapshot.val()?.chance) defaults.chance = 3;
          if (Object.keys(defaults).length > 0) await userAccountRef.update(defaults);

          // Add username to global account's user list
          await database.ref(`${accountKey}/users/${username}`).set(true);

          // Notify admin
          await bot.sendMessage(chatId, `✅ Purchase date for account "${accountKey}" of user ${userCode} set to ${dateText}.`);

          // Notify user
          await bot.sendMessage(userCode, `🗓️ Your subscription to *${accountKey}* has been updated.\nNew purchase date: *${dateText}*`, {
            parse_mode: "Markdown"
          });

        } catch (err) {
          console.error(err.message);
          await bot.sendMessage(chatId, "❌ Failed to update the purchase date.");
        }
      });
    });
  });
});

