import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import input from 'input';
import 'dotenv/config';

const apiId = parseInt(process.env.API_ID);
const apiHash = process.env.API_HASH;
const stringSession = new StringSession('');

const client = new TelegramClient(stringSession, apiId, apiHash, {
  connectionRetries: 5,
});

(async () => {
  console.log('📲 Генерация строки сессии Telegram...');

  await client.start({
    phoneNumber: async () => await input.text('Введите номер телефона: '),
    password: async () => await input.text('Введите 2FA пароль (если включен): '),
    phoneCode: async () => await input.text('Введите код из Telegram: '),
    onError: (err) => console.log('❌ Ошибка:', err),
  });

  const session = client.session.save();
  console.log('\n✅ Сессия создана! Вставь её в .env как переменную STRING_SESSION:');
  console.log('\nSTRING_SESSION=' + session);
})();