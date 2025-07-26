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
  bot.start((ctx) => ctx.reply('👋 Добро пожаловать!', getMainKeyboard()));
  bot.command('menu', (ctx) => ctx.reply('Главное меню:', getMainKeyboard()));

  function isAdmin(id) {
    return db.admins.includes(id);
  }
  const getId = async (val) => {
    if (val.startsWith('@')) {
      try {
        const entity = await client.getEntity(val);
        return `-100${entity.id}`;
      } catch (e) {
        throw new Error(`Cannot access ${val}: ${e.message}`);
      }
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
    const fromId = msg.chatId?.toString();
    if (!fromId || !db.forwardingEnabled) return;

    for (const pair of db.pairs.filter(p => p.source === fromId && p.enabled)) {
      let text = msg.message || '';
      db.filters.forEach(word => {
        if (!word || typeof word !== 'string' || word.trim() === '') return;
        try {
          const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const regex = new RegExp(escaped, 'gi');
          text = text.replace(regex, m => '.'.repeat(m.length));
        } catch (e) {
          console.error(`❌ Невалидный фильтр: ${word}`, e.message);
        }
      });

      const pairKey = getPairKey(pair.source, pair.target);
      if (!messageBuffers[pairKey]) messageBuffers[pairKey] = { timer: null, messages: [] };
      messageBuffers[pairKey].messages.push({
        id: msg.id,
        text,
        media: msg.media,
        topicId: pair.threadId,
        fromId
      });

      if (messageBuffers[pairKey].timer) clearTimeout(messageBuffers[pairKey].timer);
      messageBuffers[pairKey].timer = setTimeout(async () => {
        const buffer = messageBuffers[pairKey];
        const messagesToSend = buffer.messages;
        buffer.messages = [];
        buffer.timer = null;

        try {
          const entity = await client.getEntity(fromId);
          for (let m of messagesToSend) {
            let messageLink = entity.username
              ? `https://t.me/${entity.username}/${m.id}`
              : `https://t.me/c/${Math.abs(Number(fromId)) - 1000000000000}/${m.id}`;

            if (m.media) {
              const params = {
                peer: pair.target,
                media: m.media,
                message: '',
                noWebpage: true
              };
              if (pair.threadId) params.replyToMsgId = Number(m.topicId);
              await client.invoke(new Api.messages.SendMedia(params));
            } else {
              const finalText = `${m.text?.trim() || ''}\n💸`;
              const entities = [new Api.MessageEntityTextUrl({
                offset: finalText.length - 2,
                length: 2,
                url: messageLink
              })];
              const params = {
                peer: pair.target,
                message: finalText,
                entities,
                noWebpage: true
              };
              if (pair.threadId) params.replyToMsgId = Number(m.topicId);
              await client.invoke(new Api.messages.SendMessage(params));
            }
          }

          db.stats.push({ source: pair.source, target: pair.target, time: Date.now(), threadId: pair.threadId });
          saveJSON(DB_FILE, db);
          console.log(`📤 Переслано из ${pair.source} в ${pair.target} (тема ${pair.threadId || 'без темы'}, ${messagesToSend.length} сообщений)`);
        } catch (e) {
          console.error(`❌ Ошибка пересылки в ${pair.target} (тема ${pair.threadId || 'без темы'}):`, e.message);
          if (e.message.includes('TOPIC_CLOSED') || e.message.includes('TOPIC_NOT_FOUND')) {
            pair.enabled = false;
            saveJSON(DB_FILE, db);
            if (db.admins.length > 0) {
              bot.telegram.sendMessage(
                db.admins[0],
                `⚠️ Связка ${pair.source} → ${pair.target} (${pair.threadId ? `тема ${pair.threadId}` : 'без темы'}) отключена: тема закрыта или удалена`
              );
            }
          }
        }
      }, MESSAGE_BATCH_DELAY);
    }
  }, new NewMessage());

  bot.command('listtopics', async (ctx) => {
    const input = ctx.message.text.split(' ')[1];
    if (!input) return ctx.reply('⚠️ Пример: /listtopics @yourgroup');
    try {
      const entity = await client.getEntity(input);
      const res = await client.invoke(new Api.channels.GetForumTopics({
        channel: entity,
        offsetDate: 0,
        offsetId: 0,
        offsetTopic: 0,
        limit: 100
      }));
      if (!res.topics.length) return ctx.reply('📭 Темы не найдены');
      const chatId = entity.id < 0 ? Math.abs(parseInt(entity.id)) - 1000000000000 : parseInt(entity.id);
      const topics = res.topics.map(t => `👗 ${t.title}\n🆔 ID: ${t.id}\n🔗 https://t.me/c/${chatId}/${t.topMessage}`).join('\n\n');
      ctx.reply(`📋 Список тем:\n\n${topics}`);
    } catch (e) {
      ctx.reply(`❌ Ошибка при получении тем: ${e.message}`);
    }
  });

  bot.command('addpair', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.reply('⚠️ Доступ только для админов');
    const args = ctx.message.text.split(' ').slice(1);
    if (args.length < 2) return ctx.reply('⚠️ Пример: /addpair @source @target [topicId]');
    try {
      const source = (await getId(args[0])).toString();
      const target = (await getId(args[1])).toString();
      const threadId = args[2] ? parseInt(args[2]) : undefined;

      if (threadId) {
        const entity = await client.getEntity(target);
        const res = await client.invoke(new Api.channels.GetForumTopics({
          channel: entity,
          offsetDate: 0,
          offsetId: 0,
          offsetTopic: 0,
          limit: 100
        }));
        if (!res.topics.some(t => t.id === threadId)) {
          return ctx.reply(`⚠️ Тема с ID ${threadId} не найдена в ${target}`);
        }
      }

      if (db.pairs.find(p => p.source === source && p.target === target && (!threadId || p.threadId === threadId)))
        return ctx.reply('⚠️ Такая связка уже существует');
      db.pairs.push({ id: Date.now(), source, target, enabled: true, ...(threadId && { threadId }) });
      saveJSON(DB_FILE, db);
      ctx.reply(`✅ Связка создана: из ${source} в ${target}${threadId ? ` (тема ${threadId})` : ''}`, getMainKeyboard());
    } catch (e) {
      ctx.reply(`❌ Ошибка при создании связки: ${e.message}`);
    }
  });

  bot.command('toggleall', (ctx) => {
    db.forwardingEnabled = !db.forwardingEnabled;
    saveJSON(DB_FILE, db);
    ctx.reply(`🔁 Все связки: ${db.forwardingEnabled ? 'включены' : 'выключены'}`, getMainKeyboard());
  });

  bot.command('listpairs', (ctx) => {
    if (db.pairs.length === 0) return ctx.reply('📭 Связок нет');
    db.pairs.forEach(p => ctx.reply(
      `🔗 ID: ${p.id}\nИз: ${p.source}\nВ: ${p.target}\nСтатус: ${p.enabled ? '✅' : '❌'}\n🧵 Topic: ${p.threadId || 'не указан'}`,
      Markup.inlineKeyboard([Markup.button.callback(p.enabled ? 'Отключить' : 'Включить', `toggle_${p.id}`)])
    ));
  });

  bot.command('getid', async (ctx) => {
    const username = ctx.message.text.split(' ')[1];
    if (!username) return ctx.reply('⚠️ Пример: /getid @channel');
    try {
      const entity = await client.getEntity(username);
      ctx.reply(`🆔 ID: \`${entity.id}\`\n📦 Тип: ${entity.className}`, { parse_mode: 'Markdown' });
    } catch {
      ctx.reply('❌ Ошибка. Проверь username.');
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

  bot.on('callback_query', async (ctx) => {
    try {
      const id = parseInt(ctx.callbackQuery.data.replace('toggle_', ''));
      const pair = db.pairs.find(p => p.id === id);
      if (!pair) return await ctx.answerCbQuery('❌ Связка не найдена');
      pair.enabled = !pair.enabled;
      saveJSON(DB_FILE, db);
      await ctx.editMessageText(
        `🔗 ID: ${p.id}\nИз: ${p.source}\nВ: ${p.target}\nСтатус: ${p.enabled ? '✅' : '❌'}\n🧵 Topic: ${p.threadId || 'не указан'}`,
        {
          reply_markup: Markup.inlineKeyboard([
            Markup.button.callback(p.enabled ? 'Отключить' : 'Включить', `toggle_${p.id}`)
          ])
        }
      );
      await ctx.answerCbQuery(p.enabled ? '✅ Включена' : '⛔ Выключена');
    } catch (e) {
      await ctx.answerCbQuery('❌ Ошибка обработки');
    }
  });

  // Обработчик нажатий на кнопки главного меню
  bot.on('text', async (ctx) => {
    const text = ctx.message.text;
    switch (text) {
      case '➕ Добавить связку':
        if (!isAdmin(ctx.from.id)) {
          return ctx.reply('⚠️ Доступ только для админов');
        }
        return ctx.reply('⚠️ Введите: /addpair @source @target [topicId]');
      case '📋 Список связок':
        if (db.pairs.length === 0) return ctx.reply('📭 Связок нет');
        db.pairs.forEach(p => ctx.reply(
          `🔗 ID: ${p.id}\nИз: ${p.source}\nВ: ${p.target}\nСтатус: ${p.enabled ? '✅' : '❌'}\n🧵 Topic: ${p.threadId || 'не указан'}`,
          Markup.inlineKeyboard([Markup.button.callback(p.enabled ? 'Отключить' : 'Включить', `toggle_${p.id}`)])
        ));
        break;
      case '📛 Добавить фильтр':
        return ctx.reply('⚠️ Введите: /addfilter слово');
      case '📝 Список фильтров':
        ctx.reply(`📃 Слова-фильтры:\n${db.filters.map((w, i) => `${i + 1}. ${w}`).join('\n') || '📭 пусто'}`, getMainKeyboard());
        break;
      case '🔁 Включить/Выключить все':
        db.forwardingEnabled = !db.forwardingEnabled;
        saveJSON(DB_FILE, db);
        ctx.reply(`🔁 Все связки: ${db.forwardingEnabled ? 'включены' : 'выключены'}`, getMainKeyboard());
        break;
      case '📊 Статистика':
        const now = Date.now();
        const count = (ms) => db.stats.filter(s => now - s.time <= ms).length;
        ctx.reply(`📊 За 10мин: ${count(10*60*1000)}\n🕐 За час: ${count(60*60*1000)}\n📅 За день: ${count(24*60*60*1000)}\n🔢 Всего: ${db.stats.length}`, getMainKeyboard());
        break;
      case '🆔 Получить ID':
        return ctx.reply('⚠️ Введите: /getid @channel');
      default:
        break;
    }
  });

  // Автоматическое создание связки @TesterO2 → @AliTest001 (тема 58)
  async function createPair() {
    try {
      const source = await getId('@TesterO2');
      const target = await getId('@AliTest001');
      const threadId = 58;

      // Проверка существования каналов
      await client.getEntity(source);
      const targetEntity = await client.getEntity(target);

      // Проверка, является ли @AliTest001 форум-группой
      try {
        const res = await client.invoke(new Api.channels.GetForumTopics({
          channel: targetEntity,
          offsetDate: 0,
          offsetId: 0,
          offsetTopic: 0,
          limit: 100
        }));
        if (!res.topics.some(t => t.id === threadId)) {
          console.error(`❌ Тема с ID ${threadId} не найдена в @AliTest001`);
          return;
        }
      } catch (e) {
        if (e.message.includes('CHANNEL_INVALID') || e.message.includes('CHAT_INVALID')) {
          console.error(`❌ @AliTest001 не является форум-группой или бот не имеет доступа: ${e.message}`);
          // Создаём связку без threadId, если темы не поддерживаются
          if (db.pairs.find(p => p.source === source && p.target === target && !p.threadId)) {
            console.log(`⚠️ Связка @TesterO2 → @AliTest001 (без темы) уже существует`);
            return;
          }
          db.pairs.push({
            id: Date.now(),
            source,
            target,
            enabled: true
          });
          saveJSON(DB_FILE, db);
          console.log(`✅ Связка создана: @TesterO2 → @AliTest001 (без темы, так как @AliTest001 не поддерживает темы)`);
          return;
        }
        throw e;
      }

      // Проверка, не существует ли уже такая связка
      if (db.pairs.find(p => p.source === source && p.target === target && p.threadId === threadId)) {
        console.log(`⚠️ Связка @TesterO2 → @AliTest001 (тема ${threadId}) уже существует`);
        return;
      }

      // Создание связки с threadId
      db.pairs.push({
        id: Date.now(),
        source,
        target,
        enabled: true,
        threadId
      });
      saveJSON(DB_FILE, db);
      console.log(`✅ Связка создана: @TesterO2 → @AliTest001 (тема ${threadId})`);
    } catch (e) {
      console.error(`❌ Ошибка при создании связки @TesterO2 → @AliTest001: ${e.message}`);
    }
  }

  // Запуск создания связки после инициализации бота
  createPair();

  bot.launch({ dropPendingUpdates: false });
  console.log('🤖 Бот запущен');
  console.log('📡 Готов к пересылке сообщений...');
  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));