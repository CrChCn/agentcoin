// Раннер v0 для редизайна AGENTCOIN: создаёт чаты по промптам и сохраняет код.
// Требует валидный V0_API_KEY в окружении. Установка: npm install v0-sdk
// Запуск: V0_API_KEY=... node run-v0.mjs
import { v0 } from 'v0-sdk';
import fs from 'node:fs';

const PROMPTS = {
  'mbc20': 'Создай React-страницу для биржи MBC-20. Темная тема, золотые акценты. Язык: RU. Все тексты интерфейса строго на русском, ни одного английского слова (кроме технических терминов: API, ticker, txid, memo). Вся локализация через словарь i18n, переключатель RU/EN в шапке, выбор хранить в localStorage. Компоненты: стакан (bid/ask) с ценами и объемами; график цены (24 часа) с помощью Recharts; список последних сделок (таблица); кнопка "Создать ордер" (если API позволяет) или "В разработке". Используй Tailwind CSS, TanStack Query. Данные: GET /dxe/orders, GET /dxe/items, GET /dxe/fills. Если API не отвечает — показать ошибку и retry, не падать.',
  'index': 'Создай главную страницу AGENTCOIN (темная тема, золотые акценты). Язык: RU. Все тексты интерфейса строго на русском, ни одного английского слова (кроме технических терминов: API, WASM). Вся локализация через i18n, переключатель RU/EN в шапке, выбор хранить в localStorage. Компоненты: статус сети (высота блока, мемпул, казна); живая лента (последние 20 событий); карта нод; кнопки "Стать агентом" (WASM), "Майнинг" (/mine), "Задачи" (/jobs), "Биржа" (/mbc20); блок "Экономика": распределение AGT. Данные: GET /stats-data, GET /blocks?n=20, GET /life, GET /network/nodes. Если API не отвечает — показать ошибку и retry, не падать.',
};

if (!process.env.V0_API_KEY) {
  console.error('V0_API_KEY is not set');
  process.exit(1);
}
for (const [name, message] of Object.entries(PROMPTS)) {
  console.log('creating chat:', name);
  const chat = await v0.chats.create({ name: 'agentcoin-' + name, message });
  fs.writeFileSync(`v0-${name}-chat.json`, JSON.stringify({ id: chat.id, webUrl: chat.webUrl }, null, 2));
  console.log('saved v0-' + name + '-chat.json', chat.id);
}
