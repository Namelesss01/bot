// index.js — версия с автоматическим добавлением -100 и поддержкой username
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
const PAIRS_FILE = './channelPairs.json';

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
  filters: ['торг', 'цена', 'срочно', 'недорого', 'без посредников'],
  admins: [],
  forwardingEnabled: true,
  stats: []
});

const client = new TelegramClient(session, apiId, apiHash, { connectionRetries: 5 });
await client.start({
  phoneNumber: async () => await input.text('📱 Телефон: '),
  password: async () => await input.text('🔐 2FA пароль (если есть): '),
  phoneCode: async () => await input.text('💬 Код из Telegram: '),
  onError: (err) => console.log('❌ Ошибка входа:', err),
});

console.log('✅ TelegramClient запущен');
console.log('🔑 StringSession:', client.session.save());

const bot = new Telegraf(botToken);

bot.start((ctx) => ctx.reply('👋 Добро пожаловать! /addpair /togglepair /toggleall /listpairs /getid'));

bot.command('addpair', async (ctx) => {
  const [srcInput, tgtInput] = ctx.message.text.split(' ').slice(1);
  if (!srcInput || !tgtInput) return ctx.reply('⚠️ Пример: /addpair @source @target');

  try {
    const getId = async (val) => {
      if (val.startsWith('@')) {
        const entity = await client.getEntity(val);
        return BigInt(`-100${entity.id}`);
      }
      return BigInt(val.startsWith('-100') ? val : `-100${val}`);
    };

    const source = await getId(srcInput);
    const target = await getId(tgtInput);

    const newPair = { id: Date.now(), source, target, enabled: true };
    db.pairs.push(newPair);
    saveJSON(DB_FILE, db);
    saveJSON(PAIRS_FILE, db.pairs.map(p => ({ sourceId: p.source.toString(), targetId: p.target.toString() })));
    ctx.reply(`✅ Связка создана:\nИз: ${source}\nВ: ${target}`);
  } catch (e) {
    console.error('❌ Ошибка при добавлении пары:', e);
    ctx.reply('❌ Ошибка при получении ID. Проверьте ники или ID.');
  }
});

bot.command('toggleall', (ctx) => {
  db.forwardingEnabled = !db.forwardingEnabled;
  saveJSON(DB_FILE, db);
  ctx.reply(`🔁 Все связки: ${db.forwardingEnabled ? 'включены' : 'выключены'}`);
});

bot.command('togglepair', (ctx) => {
  const id = parseInt(ctx.message.text.split(' ')[1]);
  const pair = db.pairs.find(p => p.id === id);
  if (!pair) return ctx.reply('❌ Связка не найдена');
  pair.enabled = !pair.enabled;
  saveJSON(DB_FILE, db);
  ctx.reply(`🔁 Связка ${id}: ${pair.enabled ? 'включена' : 'выключена'}`);
});

bot.command('listpairs', (ctx) => {
  if (db.pairs.length === 0) return ctx.reply('📭 Связок нет');
  db.pairs.forEach(p => {
    ctx.reply(`🔗 ID: ${p.id}\nИз: ${p.source}\nВ: ${p.target}\nСтатус: ${p.enabled ? '✅' : '❌'}`,
      Markup.inlineKeyboard([
        Markup.button.callback(p.enabled ? 'Отключить' : 'Включить', `toggle_${p.id}`)
      ]));
  });
});

bot.command('getid', async (ctx) => {
  const username = ctx.message.text.split(' ')[1];
  if (!username) return ctx.reply('⚠️ Пример: /getid @channel');
  try {
    const entity = await client.getEntity(username);
    ctx.reply(`ℹ️ Username: ${username}\n🆔 ID: \`${entity.id}\`\n📦 Тип: ${entity.className}`, { parse_mode: 'Markdown' });
  } catch {
    ctx.reply('❌ Ошибка. Проверь username.');
  }
});

bot.on('callback_query', (ctx) => {
  const id = parseInt(ctx.callbackQuery.data.replace('toggle_', ''));
  const pair = db.pairs.find(p => p.id === id);
  if (!pair) return;
  pair.enabled = !pair.enabled;
  saveJSON(DB_FILE, db);
  ctx.editMessageText(`🔗 ID: ${pair.id}\nИз: ${pair.source}\nВ: ${pair.target}\nСтатус: ${pair.enabled ? '✅' : '❌'}`,
    Markup.inlineKeyboard([Markup.button.callback(pair.enabled ? 'Отключить' : 'Включить', `toggle_${pair.id}`)]));
});

bot.launch();
console.log('🤖 Telegraf-бот запущен');

client.addEventHandler(async (event) => {
  const msg = event.message;
  const fromId = msg.chatId?.value;
  if (!fromId || !db.forwardingEnabled) return;

  for (const pair of db.pairs.filter(p => p.source === fromId && p.enabled)) {
    const text = msg.message || '';
    if (db.filters.some(w => text.toLowerCase().includes(w))) return;

    try {
      if (msg.media) {
        await client.sendFile(pair.target, {
          file: msg.media,
          caption: text,
          forceDocument: false
        });
      } else {
        await client.sendMessage(pair.target, { message: text });
      }

      db.stats.push({ source: pair.source, target: pair.target, time: Date.now() });
      saveJSON(DB_FILE, db);
      console.log(`📤 Переслано из ${pair.source} в ${pair.target}`);
    } catch (e) {
      console.error('❌ Ошибка пересылки:', e.message);
    }
  }
}, new NewMessage({}));

console.log('📡 Готов к пересылке сообщений...');
