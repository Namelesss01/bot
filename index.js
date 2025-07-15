import pkg from 'telegram';
const { TelegramClient, Api } = pkg;

import { StringSession } from 'telegram/sessions/index.js';
import { NewMessage } from 'telegram/events/NewMessage.js';
import input from 'input';
import { Telegraf, Markup } from 'telegraf';
import fs from 'fs';
import 'dotenv/config';
import path from 'path';

const apiId = parseInt(process.env.API_ID);
const apiHash = process.env.API_HASH;
const botToken = process.env.BOT_TOKEN;
const session = new StringSession(process.env.STRING_SESSION);
const DB_FILE = './db.json';

function loadJSON(path, fallback) {
  try {
    return fs.existsSync(path) ? JSON.parse(fs.readFileSync(path, 'utf-8')) : fallback;
  } catch {
    return fallback;
  }
}
function saveJSON(path, data) {
  fs.writeFileSync(path, JSON.stringify(data, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
}
let db = loadJSON(DB_FILE, {
  pairs: [],
  filters: [],
  admins: [],
  forwardingEnabled: true,
  stats: []
});

const client = new TelegramClient(session, apiId, apiHash, { connectionRetries: 5 });
await client.start({
  phoneNumber: async () => await input.text('📱 Телефон: '),
  password: async () => await input.text('🔐 2FA пароль (если есть): '),
  phoneCode: async () => await input.text('💬 Код из Telegram: '),
  onError: (err) => console.log('❌ Ошибка входа:', err)
});
console.log('✅ TelegramClient запущен');
console.log('🔑 StringSession:', client.session.save());

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
  ctx.reply('👋 Добро пожаловать!', getMainKeyboard());
});
bot.command('menu', (ctx) => ctx.reply('Главное меню:', getMainKeyboard()));

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

const MESSAGE_BATCH_DELAY = 1500;
const messageBuffers = {};
function getPairKey(source, target) {
  return `${source}-${target}`;
}

client.addEventHandler(async (event) => {
  const msg = event.message;
  const fromId = msg.chatId?.value?.toString();
  if (!fromId || !db.forwardingEnabled) return;

  for (const pair of db.pairs.filter(p => p.source === fromId && p.enabled)) {
    let text = msg.message || '';
    db.filters.forEach(word => {
      const regex = new RegExp(word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
      text = text.replace(regex, m => '.'.repeat(m.length));
    });

    const pairKey = getPairKey(pair.source, pair.target);
    if (!messageBuffers[pairKey]) messageBuffers[pairKey] = { timer: null, messages: [] };
    messageBuffers[pairKey].messages.push({ id: msg.id, text, media: msg.media, threadId: pair.threadId, fromId });

    if (messageBuffers[pairKey].timer) clearTimeout(messageBuffers[pairKey].timer);
    messageBuffers[pairKey].timer = setTimeout(async () => {
      const buffer = messageBuffers[pairKey];
      const messagesToSend = buffer.messages;
      buffer.messages = [];
      buffer.timer = null;

      try {
        const entity = await client.getEntity(fromId);
        for (let m of messagesToSend) {
          let messageLink = '';
          if (entity.username) {
            messageLink = `https://t.me/${entity.username}/${m.id}`;
          } else {
            const internalChatId = Math.abs(Number(fromId)) - 1000000000000;
            messageLink = `https://t.me/c/${internalChatId}/${m.id}`;
          }

          if (m.media) {
            try {
              await client.invoke(new Api.messages.ForwardMessages({
                fromPeer: m.fromId,
                id: [m.id],
                toPeer: pair.target,
                dropAuthor: false
              }));
            } catch (err) {
              console.error('❌ Ошибка при пересылке медиа:', err.message);
            }
          }
           else {
            const originalText = m.text?.trim() || '';
            const linkText = '💸';
            const finalText = originalText ? `${originalText}\n${linkText}` : linkText;
            const entities = [new Api.MessageEntityTextUrl({
              offset: finalText.length - linkText.length,
              length: linkText.length,
              url: messageLink
            })];

            await client.invoke(new Api.messages.SendMessage({
              peer: pair.target,
              message: finalText,
              replyToMsgId: m.threadId,
              entities,
              noWebpage: true,
              linkPreview: false
            }));
          }
        }

        db.stats.push({ source: pair.source, target: pair.target, time: Date.now() });
        saveJSON(DB_FILE, db);
        console.log(`📤 Переслано из ${pair.source} в ${pair.target} (${messagesToSend.length})`);
      } catch (e) {
        console.error('❌ Ошибка пересылки:', e.message);
      }
    }, MESSAGE_BATCH_DELAY);
  }
}, new NewMessage({}));

// === Команды бота ===
bot.command('addpair', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const args = ctx.message.text.split(' ').slice(1);
  if (args.length < 2) return ctx.reply('⚠️ Пример: /addpair @source @target [threadId]');
  try {
    const source = (await getId(args[0])).toString();
    const target = (await getId(args[1])).toString();
    const threadId = args[2] ? parseInt(args[2]) : undefined;
    if (db.pairs.find(p => p.source === source && p.target === target && (!threadId || p.threadId === threadId)))
      return ctx.reply('⚠️ Такая связка уже существует');
    db.pairs.push({ id: Date.now(), source, target, enabled: true, ...(threadId && { threadId }) });
    saveJSON(DB_FILE, db);
    ctx.reply(`✅ Связка создана: из ${source} в ${target}${threadId ? ` (Thread ${threadId})` : ''}`, getMainKeyboard());
  } catch (e) {
    console.error('❌ Ошибка при addpair:', e);
    ctx.reply('❌ Ошибка при получении ID. Проверь ники или ID.', getMainKeyboard());
  }
});

bot.command('toggleall', (ctx) => {
  db.forwardingEnabled = !db.forwardingEnabled;
  saveJSON(DB_FILE, db);
  ctx.reply(`🔁 Все связки: ${db.forwardingEnabled ? 'включены' : 'выключены'}`, getMainKeyboard());
});

bot.command('listpairs', (ctx) => {
  if (db.pairs.length === 0) return ctx.reply('📭 Связок нет', getMainKeyboard());
  db.pairs.forEach(p => ctx.reply(
    `🔗 ID: ${p.id}\nИз: ${p.source}\nВ: ${p.target}\nСтатус: ${p.enabled ? '✅' : '❌'}${p.threadId ? `\n🧵 Thread: ${p.threadId}` : ''}`,
    Markup.inlineKeyboard([Markup.button.callback(p.enabled ? 'Отключить' : 'Включить', `toggle_${p.id}`)])
  ));
});

bot.command('togglepair', (ctx) => {
  const id = parseInt(ctx.message.text.split(' ')[1]);
  const pair = db.pairs.find(p => p.id === id);
  if (!pair) return ctx.reply('❌ Связка не найдена');
  pair.enabled = !pair.enabled;
  saveJSON(DB_FILE, db);
  ctx.reply(`🔁 Связка ${id}: ${pair.enabled ? 'включена' : 'выключена'}`, getMainKeyboard());
});

bot.command('getid', async (ctx) => {
  const username = ctx.message.text.split(' ')[1];
  if (!username) return ctx.reply('⚠️ Пример: /getid @channel');
  try {
    const entity = await client.getEntity(username);
    ctx.reply(`ℹ️ Username: ${username}\n🆔 ID: \`${entity.id}\`\n📦 Тип: ${entity.className}`, { parse_mode: 'Markdown' });
  } catch {
    ctx.reply('❌ Ошибка. Проверь username.', getMainKeyboard());
  }
});

bot.command('addfilter', (ctx) => {
  const word = ctx.message.text.split(' ')[1]?.toLowerCase();
  if (!word) return ctx.reply('⚠️ Пример: /addfilter срочно');
  if (db.filters.includes(word)) return ctx.reply('⚠️ Уже в списке');
  db.filters.push(word); saveJSON(DB_FILE, db);
  ctx.reply(`✅ Добавлено: ${word}`, getMainKeyboard());
});

bot.command('removefilter', (ctx) => {
  const word = ctx.message.text.split(' ')[1]?.toLowerCase();
  if (!word) return ctx.reply('⚠️ Пример: /removefilter срочно');
  const i = db.filters.indexOf(word);
  if (i === -1) return ctx.reply('⚠️ Нет такого слова');
  db.filters.splice(i, 1); saveJSON(DB_FILE, db);
  ctx.reply(`🗑️ Удалено: ${word}`, getMainKeyboard());
});

bot.command('listfilters', (ctx) => {
  ctx.reply(`📃 Слова-фильтры:\n${db.filters.map((w, i) => `${i + 1}. ${w}`).join('\n') || '📭 пусто'}`, getMainKeyboard());
});

bot.command('stats', (ctx) => {
  const now = Date.now();
  const count = (ms) => db.stats.filter(s => now - s.time <= ms).length;
  ctx.reply(`📊 За 10мин: ${count(10*60*1000)}\n🕐 За час: ${count(60*60*1000)}\n📅 За день: ${count(24*60*60*1000)}\n🔢 Всего: ${db.stats.length}`, getMainKeyboard());
});

bot.on('callback_query', (ctx) => {
  const id = parseInt(ctx.callbackQuery.data.replace('toggle_', ''));
  const pair = db.pairs.find(p => p.id === id);
  if (!pair) return;
  pair.enabled = !pair.enabled; saveJSON(DB_FILE, db);
  ctx.editMessageText(
    `🔗 ID: ${pair.id}\nИз: ${pair.source}\nВ: ${pair.target}\nСтатус: ${pair.enabled ? '✅' : '❌'}${pair.threadId ? `\n🧵 Thread: ${pair.threadId}` : ''}`,
    Markup.inlineKeyboard([Markup.button.callback(pair.enabled ? 'Отключить' : 'Включить', `toggle_${pair.id}`)])
  );
});

// === Запуск бота ===
bot.launch();
console.log('🤖 Бот запущен');
console.log('📡 Готов к пересылке сообщений...');
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
