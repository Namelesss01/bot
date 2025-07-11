import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { NewMessage } from 'telegram/events/NewMessage.js';
import input from 'input';
import { Telegraf, Markup } from 'telegraf';
import fs from 'fs';
import 'dotenv/config';

const apiId = parseInt(process.env.API_ID);
const apiHash = process.env.API_HASH;
const botToken = process.env.BOT_TOKEN;
const session = new StringSession(process.env.STRING_SESSION);
const DB_FILE = './db.json';

// -------------------- JSON DB helpers --------------------
function loadJSON(path, fallback) {
  try {
    return fs.existsSync(path)
      ? JSON.parse(fs.readFileSync(path, 'utf-8'))
      : fallback;
  } catch {
    return fallback;
  }
}

function saveJSON(path, data) {
  fs.writeFileSync(
    path,
    JSON.stringify(data, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2)
  );
}

let db = loadJSON(DB_FILE, {
  pairs: [],
  filters: [],
  admins: [],
  forwardingEnabled: true,
  stats: []
});

// -------------------- TelegramClient --------------------
const client = new TelegramClient(session, apiId, apiHash, {
  connectionRetries: 5
});

await client.start({
  phoneNumber: async () => await input.text('📱 Телефон: '),
  password: async () => await input.text('🔐 2FA пароль (если есть): '),
  phoneCode: async () => await input.text('💬 Код из Telegram: '),
  onError: (err) => console.log('❌ Ошибка входа:', err)
});

console.log('✅ TelegramClient запущен');
console.log('🔑 StringSession:', client.session.save());

// -------------------- Telegraf Bot --------------------
const bot = new Telegraf(botToken);

function getMainKeyboard() {
  return Markup.keyboard([
    ['➕ Добавить связку', '📋 Список связок'],
    ['📛 Добавить фильтр', '📝 Список фильтров'],
    ['🔁 Включить/Выключить все', '📊 Статистика'],
    ['🆔 Получить ID']
  ]).resize();
}

bot.start((ctx) => {
  const welcomeText = '👋 Добро пожаловать! Используйте кнопки ниже или команды:\n' +
    '/addpair - добавить связку\n' +
    '/togglepair - переключить связку\n' +
    '/toggleall - переключить все\n' +
    '/listpairs - список связок\n' +
    '/getid - получить ID\n' +
    '/addfilter - добавить фильтр\n' +
    '/removefilter - удалить фильтр\n' +
    '/listfilters - список фильтров\n' +
    '/stats - статистика\n' +
    '/menu - показать меню кнопок';
  return ctx.reply(welcomeText, getMainKeyboard());
});

bot.command('menu', (ctx) => ctx.reply('Главное меню:', getMainKeyboard()));

// -------------------- Helpers --------------------
function isAdmin(id) {
  return db.admins.includes(id);
}

const getId = async (val) => {
  if (val.startsWith('@')) {
    const entity = await client.getEntity(val);
    return `-100${entity.id}`;
  }
  return val.startsWith('-100') ? val : `-100${val}`;
};

function sendStats(ctx) {
  const now = Date.now();
  const countSince = (msAgo) => db.stats.filter(s => now - s.time <= msAgo).length;
  ctx.reply([
    `📊 Статистика пересылок:`,
    `⏱️ За 10 минут: ${countSince(10 * 60 * 1000)}`,
    `🕧 За 30 минут: ${countSince(30 * 60 * 1000)}`,
    `🕐 За 1 час: ${countSince(60 * 60 * 1000)}`,
    `📅 За 24 часа: ${countSince(24 * 60 * 60 * 1000)}`,
    `🔢 Всего: ${db.stats.length}`,
  ].join('\n'));
}

// -------------------- Команды --------------------
bot.command('addpair', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const args = ctx.message.text.split(' ').slice(1);
  if (args.length < 2) return ctx.reply('⚠️ Пример: /addpair @source @target [threadId]');
  try {
    const source = (await getId(args[0])).toString();
    const target = (await getId(args[1])).toString();
    const threadId = args[2] ? parseInt(args[2]) : undefined;
    if (db.pairs.some(p => p.source === source && p.target === target && (!threadId || p.threadId === threadId)))
      return ctx.reply('⚠️ Такая связка уже существует');
    db.pairs.push({
      id: Date.now(),
      source,
      target,
      enabled: true,
      ...(threadId && { threadId })
    });
    saveJSON(DB_FILE, db);
    ctx.reply(`✅ Связка создана:\nИз: ${source}\nВ: ${target}${threadId ? `\n🧵 Thread ID: ${threadId}` : ''}`, getMainKeyboard());
  } catch (e) {
    console.error('❌ Ошибка при добавлении пары:', e);
    ctx.reply('❌ Ошибка при получении ID. Проверь ники или ID.', getMainKeyboard());
  }
});

bot.command('toggleall', (ctx) => {
  db.forwardingEnabled = !db.forwardingEnabled;
  saveJSON(DB_FILE, db);
  ctx.reply(`🔁 Все связки: ${db.forwardingEnabled ? 'включены' : 'выключены'}`, getMainKeyboard());
});

bot.command('togglepair', (ctx) => {
  const id = parseInt(ctx.message.text.split(' ')[1]);
  const pair = db.pairs.find(p => p.id === id);
  if (!pair) return ctx.reply('❌ Связка не найдена', getMainKeyboard());
  pair.enabled = !pair.enabled;
  saveJSON(DB_FILE, db);
  ctx.reply(`🔁 Связка ${id}: ${pair.enabled ? 'включена' : 'выключена'}`, getMainKeyboard());
});

bot.command('listpairs', (ctx) => {
  if (db.pairs.length === 0) return ctx.reply('📭 Связок нет', getMainKeyboard());
  db.pairs.forEach(p => {
    ctx.reply(
      `🔗 ID: ${p.id}\nИз: ${p.source}\nВ: ${p.target}\nСтатус: ${p.enabled ? '✅' : '❌'}${p.threadId ? `\n🧵 Thread: ${p.threadId}` : ''}`,
      Markup.inlineKeyboard([Markup.button.callback(p.enabled ? 'Отключить' : 'Включить', `toggle_${p.id}`)])
    );
  });
});

bot.command('getid', async (ctx) => {
  const username = ctx.message.text.split(' ')[1];
  if (!username) return ctx.reply('⚠️ Пример: /getid @channel', getMainKeyboard());
  try {
    const entity = await client.getEntity(username);
    ctx.reply(`ℹ️ Username: ${username}\n🆔 ID: \`${entity.id}\`\n📦 Тип: ${entity.className}`, { 
      parse_mode: 'Markdown'
    });
  } catch {
    ctx.reply('❌ Ошибка. Проверь username.', getMainKeyboard());
  }
});

bot.command('addfilter', (ctx) => {
  const word = ctx.message.text.split(' ')[1]?.toLowerCase();
  if (!word) return ctx.reply('⚠️ Пример: /addfilter срочно', getMainKeyboard());
  if (db.filters.includes(word)) return ctx.reply('⚠️ Это слово уже есть', getMainKeyboard());
  db.filters.push(word);
  saveJSON(DB_FILE, db);
  ctx.reply(`✅ Слово "${word}" добавлено в фильтры`, getMainKeyboard());
});

bot.command('removefilter', (ctx) => {
  const word = ctx.message.text.split(' ')[1]?.toLowerCase();
  if (!word) return ctx.reply('⚠️ Пример: /removefilter срочно', getMainKeyboard());
  const index = db.filters.indexOf(word);
  if (index === -1) return ctx.reply('⚠️ Такого слова нет', getMainKeyboard());
  db.filters.splice(index, 1);
  saveJSON(DB_FILE, db);
  ctx.reply(`🗑️ Слово "${word}" удалено из фильтров`, getMainKeyboard());
});

bot.command('listfilters', (ctx) => {
  if (db.filters.length === 0) return ctx.reply('📭 Список фильтров пуст', getMainKeyboard());
  ctx.reply(`📃 Слова-фильтры:\n\n${db.filters.map((w, i) => `${i + 1}. ${w}`).join('\n')}`, getMainKeyboard());
});

bot.command('stats', sendStats);

// -------------------- Кнопки
bot.hears('➕ Добавить связку', (ctx) =>
  ctx.reply('✍️ Введите команду:\n`/addpair @source @target [threadId]`', { parse_mode: 'Markdown' }));

bot.hears('📋 Список связок', (ctx) => {
  if (db.pairs.length === 0) return ctx.reply('📭 Связок нет', getMainKeyboard());
  db.pairs.forEach(p => {
    ctx.reply(
      `🔗 ID: ${p.id}\nИз: ${p.source}\nВ: ${p.target}\nСтатус: ${p.enabled ? '✅' : '❌'}${p.threadId ? `\n🧵 Thread: ${p.threadId}` : ''}`,
      Markup.inlineKeyboard([Markup.button.callback(p.enabled ? 'Отключить' : 'Включить', `toggle_${p.id}`)])
    );
  });
});

bot.hears('📛 Добавить фильтр', (ctx) =>
  ctx.reply('✍️ Введите команду:\n`/addfilter слово`', { parse_mode: 'Markdown' }));

bot.hears('📝 Список фильтров', (ctx) => {
  if (db.filters.length === 0) return ctx.reply('📭 Список фильтров пуст', getMainKeyboard());
  ctx.reply(`📃 Слова-фильтры:\n\n${db.filters.map((w, i) => `${i + 1}. ${w}`).join('\n')}`, getMainKeyboard());
});

bot.hears('🔁 Включить/Выключить все', (ctx) => {
  db.forwardingEnabled = !db.forwardingEnabled;
  saveJSON(DB_FILE, db);
  ctx.reply(`🔁 Все связки: ${db.forwardingEnabled ? 'включены' : 'выключены'}`, getMainKeyboard());
});

bot.hears('📊 Статистика', sendStats);

bot.hears('🆔 Получить ID', (ctx) =>
  ctx.reply('✍️ Введите команду:\n`/getid @username`', { parse_mode: 'Markdown' }));

bot.on('callback_query', (ctx) => {
  const id = parseInt(ctx.callbackQuery.data.replace('toggle_', ''));
  const pair = db.pairs.find(p => p.id === id);
  if (!pair) return;
  pair.enabled = !pair.enabled;
  saveJSON(DB_FILE, db);
  ctx.editMessageText(
    `🔗 ID: ${pair.id}\nИз: ${pair.source}\nВ: ${pair.target}\nСтатус: ${pair.enabled ? '✅' : '❌'}${pair.threadId ? `\n🧵 Thread: ${pair.threadId}` : ''}`,
    Markup.inlineKeyboard([Markup.button.callback(pair.enabled ? 'Отключить' : 'Включить', `toggle_${pair.id}`)])
  );
});

// -------------------- Пересылка сообщений --------------------
const MESSAGE_BATCH_DELAY = 1500;
const messageBuffers = {};
function getPairKey(source, target) {
  return `${source.toString()}-${target.toString()}`;
}

client.addEventHandler(async (event) => {
  const msg = event.message;
  const fromId = msg.chatId?.value?.toString();
  if (!fromId || !db.forwardingEnabled) return;

  for (const pair of db.pairs.filter(p => p.source === fromId && p.enabled)) {
    let text = msg.message || '';

    db.filters.forEach(word => {
      const safeWord = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(safeWord, 'gi');
      text = text.replace(regex, match => '.'.repeat(match.length));
    });

    const pairKey = getPairKey(pair.source, pair.target);
    if (!messageBuffers[pairKey]) {
      messageBuffers[pairKey] = { timer: null, messages: [] };
    }

    messageBuffers[pairKey].messages.push({
      id: msg.id,
      text,
      media: msg.media,
      threadId: pair.threadId,
      fromId
    });

    if (messageBuffers[pairKey].timer) clearTimeout(messageBuffers[pairKey].timer);

    messageBuffers[pairKey].timer = setTimeout(async () => {
      const buffer = messageBuffers[pairKey];
      const messagesToSend = buffer.messages;
      buffer.messages = [];
      buffer.timer = null;

      try {
        const internalChatId = Math.abs(Number(fromId)) - 1000000000000;
        const sourceLinkBase = `https://t.me/c/${internalChatId}`;
        const buttons = [[Markup.button.url('🔗 Перейти к источнику', `${sourceLinkBase}/${messagesToSend[0].id}`)]];

        for (let i = 0; i < messagesToSend.length; i++) {
          const m = messagesToSend[i];
          if (m.media) {
            await client.sendFile(pair.target, {
              file: m.media,
              caption: m.text,
              forceDocument: false,
              replyTo: m.threadId,
              buttons: i === 0 ? buttons : undefined,
            });
          } else if (m.text.trim()) {
            await client.sendMessage(pair.target, {
              message: m.text,
              replyTo: m.threadId,
              buttons: i === 0 ? buttons : undefined,
            });
          }
        }

        db.stats.push({ source: pair.source, target: pair.target, time: Date.now() });
        saveJSON(DB_FILE, db);
        console.log(`📤 Переслано из ${pair.source} в ${pair.target} (пакет из ${messagesToSend.length} сообщений)`);
      } catch (e) {
        console.error('❌ Ошибка пересылки:', e.message);
      }
    }, MESSAGE_BATCH_DELAY);
  }
}, new NewMessage({}));

// -------------------- Запуск --------------------
bot.launch();
console.log('🤖 Telegraf-бот запущен');
console.log('📡 Готов к пересылке сообщений...');

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
