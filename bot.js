require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { database } = require('./firebaseConfig');
const pendingPhotos = {}; // userId => true/false
const BOT_OWNER_ID = process.env.BOT_OWNER_ID; // e.g., 123456789
const pendingConfirmations = {}; // key: ownerMessageId, value: { clientId, fileId, fileLink }

// Ensure bot token is available
const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error("❌ the token from the .env file is not defined");
  process.exit(1);
}

// Initialize bot
const bot = new TelegramBot(token, { polling: true });
console.log("✅ Bot is up and running...");

// Handle /start command
bot.onText(/\/start/, async (msg) => {
  await showMainMenu(msg.chat.id, msg); // Pass full msg for user info
});

// Handle button interactions
bot.on('callback_query', async (callbackQuery) => {
  const chatId = callbackQuery.message.chat.id;
  const data = callbackQuery.data;

  try {
    // ✅ Handle plan selection and purchase
    if (data.startsWith('select_plan_')) {
      const parts = data.split('_');
      const accountKey = parts[parts.length - 1]; // Account key is last
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

      // Deduct balance
      await database.ref(`users/${chatId}/balance`).set(balance - price);

      // Update user's account info
      await database.ref(`users/${chatId}/account`).set(accountKey);

      // Add user under account
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

    // ✅ Show available plans under an account
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

    // ✅ Static menu handling
    switch (data) {
      case 'back_to_menu':
        await showMainMenu(chatId);
        break;

      case 'add_fund':
        await bot.sendMessage(chatId, "💰 Add Fund\n\nPlease choose a payment method:", {
          reply_markup: {
            inline_keyboard: [
              [{ text: "📲 Telebirr", callback_data: 'pay_telebirr' }],
              [{ text: "🏦 CBE", callback_data: 'pay_cbe' }],
              [{ text: "⬅️ Back to Menu", callback_data: 'back_to_menu' }]
            ]
          }
        });
        break;

      case 'purchase_netflix':
        try {
          const snapshot = await database.ref('/').once('value');
          const allData = snapshot.val();
          const buttons = [];

          for (const accountKey of Object.keys(allData)) {
            if (accountKey.startsWith('Account-')) {
              const users = allData[accountKey].users || {};
              const userCount = Object.keys(users).length;
              buttons.push([{
                text: `${accountKey} (${userCount} users)`,
                callback_data: `select_account_${accountKey}`
              }]);
            }
          }

          if (buttons.length === 0) {
            await bot.sendMessage(chatId, "❌ No Netflix accounts found.");
          } else {
            await bot.sendMessage(chatId, "📺 Select a Netflix account to view available plans:", {
              reply_markup: { inline_keyboard: buttons }
            });
          }

        } catch (error) {
          console.error("❌ Error loading accounts:", error);
          await bot.sendMessage(chatId, "⚠️ Failed to load Netflix accounts.");
        }
        break;

      case 'contact_support':
        await bot.sendMessage(chatId, "📞 Contact Support:\nTelegram: @YourSupportUsername\nEmail: support@example.com", {
          reply_markup: {
            inline_keyboard: [
              [{ text: "⬅️ Back to Menu", callback_data: 'back_to_menu' }]
            ]
          }
        });
        break;

      case 'view_account':
        await bot.sendMessage(chatId, "📺 Your Netflix account details will appear here.", {
          reply_markup: {
            inline_keyboard: [
              [{ text: "⬅️ Back to Menu", callback_data: 'back_to_menu' }]
            ]
          }
        });
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
        await bot.sendMessage(chatId, "❓ Unknown option. Please try again.", {
          reply_markup: {
            inline_keyboard: [
              [{ text: "⬅️ Back to Menu", callback_data: 'back_to_menu' }]
            ]
          }
        });
    }

    await bot.answerCallbackQuery(callbackQuery.id);

  } catch (error) {
    console.error("❌ Error handling callback_query:", error);
    await bot.sendMessage(chatId, "⚠️ An error occurred. Please try again later.");
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




// Show the main menu
async function showMainMenu(chatId, msg = null) {
  const userRef = database.ref(`users/${chatId}`);

  try {
    const snapshot = await userRef.once('value');
    const userData = snapshot.val();

    const inlineButtons = [
      [{ text: '➕ Add Fund', callback_data: 'add_fund' }],
      [{ text: '💳 Purchase Netflix', callback_data: 'purchase_netflix' }],
      [{ text: '📞 Contact Support', callback_data: 'contact_support' }]
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

      await bot.sendMessage(chatId, "✅ Account registered! 👋 Welcome! Please choose an option:", {
        reply_markup: { inline_keyboard: inlineButtons }
      });

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
