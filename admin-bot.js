require('dotnev').config();
const { database } = require('firebase-admin');
const TelegramBot = require('node-telegram-bot-api');

const token = process.env.ADMIN-TELEGRAM_BOT_TOKEN;
if(!token){
    console.error('❌ the token from the .env file is not defined');
    process.exit(1);
}

const bot = new TelegramBot(token, { polling: true });
console.log('Bot is up and running....');

//Handle the start command
bot.onText(/\/start/, async (msg) => {
    await showMainMenu(msg.chat.id, msg);
});

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
        await bot.sendMessage(chatId, `👋 Welcome back! Your balance: ${userData.balance} birr`, {
          reply_markup: { inline_keyboard: inlineButtons }
        });
      }
  
    } catch (error) {
      console.error("❌ Error in showMainMenu:", error);
      await bot.sendMessage(chatId, "⚠️ An error occurred. Please try again later.");
    }
  }