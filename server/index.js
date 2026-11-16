import { createApp } from './app.js';

const { BOT_TOKEN = '', CLUB_API_KEY = '', APP_LINK = '', CLUB_NAME, CLUB_TZ, PORT = 3000, DB_PATH = './data/tennis.db' } = process.env;

const server = createApp({
  dbPath: DB_PATH,
  botToken: BOT_TOKEN,
  clubApiKey: CLUB_API_KEY,
  appLink: APP_LINK,
  clubName: CLUB_NAME || undefined,
  clubTz: CLUB_TZ || undefined,
});

server.listen(Number(PORT), () => {
  console.log(`Tennis mini app: http://localhost:${PORT}`);
  if (!BOT_TOKEN) console.warn('⚠️  BOT_TOKEN не задан — ДЕМО-режим: вход без проверки Telegram. Не используйте в продакшене!');
  if (!CLUB_API_KEY) console.warn('ℹ️  CLUB_API_KEY не задан — API клуба (/api/club/v1) выключен.');
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.close(() => process.exit(0)));
