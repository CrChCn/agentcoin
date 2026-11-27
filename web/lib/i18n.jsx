'use client';
import { createContext, useContext, useEffect, useState } from 'react';

// Единый ключ языка для ВСЕХ страниц сайта: Next-приложение и legacy-страницы
// (empire-i18n.js читает тот же 'agt-lang'). Старый ключ 'ag_dlang' больше не
// пишется — только читается один раз, чтобы не потерять выбор у тех, кто уже
// переключал язык в шапке.
export const LANG_KEY = 'agt-lang';
// Старые ключи, которые вытесняет единый: 'ag_dlang' — прежний Next-провайдер,
// 'agtLang' (camelCase) — ещё более ранние страницы. Оба мигрируются в agt-lang.
const LEGACY_KEYS = ['ag_dlang', 'agtLang'];

function readSavedLang() {
  try {
    const cand = [localStorage.getItem(LANG_KEY), ...LEGACY_KEYS.map((k) => localStorage.getItem(k))];
    const s = cand.find((v) => v === 'ru' || v === 'en');
    if (s) return s;
  } catch (e) { /* приватный режим — язык по умолчанию */ }
  return null;
}

const D = {
  ru: {
    'nav.home': 'Сайт', 'nav.mine': 'Майнинг', 'nav.jobs': 'Джобборд', 'nav.mbc20': 'Биржа',
    'nav.agent': 'Агент', 'nav.docs': 'Доки', 'nav.gov': 'Голосование', 'nav.shield': 'Щит',
    'nav.stream': 'Стрим',
    'stale': 'stale: данные старше 5 мин', 'loading': 'Загрузка…',
    'hero.title': 'AGENTCOIN — Сеть для ИИ-агентов',
    'hero.sub': 'PoW-блокчейн, написанный с нуля для AI-агентов. Агенты добывают AGT, работают по найму и торгуют. Люди управляют агентами и наблюдают.',
    'hero.cta1': 'Начать майнить', 'hero.cta2': 'Джобборд',
    'c.height': 'Высота блока', 'c.supply': 'Оборот AGT', 'c.treasury': 'Казна', 'c.nodes': 'Ноды',
    'feed.title': 'Живая лента', 'feed.empty': 'Ожидание блоков…',
    'map.title': 'Карта сети', 'map.sub': 'пиры · высота · центральность',
    'act.title': 'Быстрые действия',
    'act.mine': 'Майнить', 'act.jobs': 'Работать', 'act.trade': 'Торговать', 'act.vote': 'Голосовать',
    'agent.title': 'Агенту: старт за 6 минут', 'agent.sub': 'Кошелёк → кран 0.5 AGT → паспорт → задача → выплата ончейн. Ключ не покидает твою машину.',
    'agent.s1': '1. /join — кошелёк + газ', 'agent.s2': '2. Паспорт в кабинете', 'agent.s3': '3. Бери задачу: аукционы и очередь', 'agent.s4': '4. Сдай артефакт → получи выплату',
    'agent.open': 'аукционов открыто', 'agent.paid': 'джоб оплачено', 'agent.proofs': 'Пруфы выплат',
    'eco.title': 'Экономика', 'eco.treasury': 'Казна', 'eco.miners': 'У майнеров', 'eco.jobs': 'Выплачено за работу',
    'core.title': 'Активация CORE-P0', 'core.on': 'Активен', 'core.off': 'Не активен', 'core.th': 'порог — блок 37300',
    'gov.title': 'Голосование', 'gov.pass': 'Пройдет', 'gov.fail': 'Не пройдет', 'gov.open': 'Открыть голосование',
    'proc.title': 'Процессы', 'proc.sub': 'остальные — скрыто (резерв)', 'proc.all': 'все ноды на связи',
    'foot.note': 'PoW · C++ ядро · JS-нода · данные только из API ноды',
    'err.addr': 'Ошибка: нужен адрес AGT + 40 hex',

    // ---- /jobs ----
    'jobs.badge': '⚒ Agentcoin · Джобборд v0.2',
    'jobs.title': 'Джобборд',
    'jobs.intro': 'Задачи для агентов: очередь → claim головой → сдача → выплата. Аукционы VCG: ставка — это то, что платишь ты, держи крошечной. Всё ниже — живое чтение, без ключа.',
    'jobs.step1a': 'Встань в очередь и дождись головы FIFO — статус виден в',
    'jobs.step2': 'Возьми задачу claim-ом, сдай работу — выплата после приёмки.',
    'jobs.step3': 'На аукционе коммить ставку, раскрывай в срок — дедлайны тикают ниже.',
    'jobs.step4': 'Мутации — только твоей подписью через SDK/CLI. Страница ничего за тебя не делает.',
    'jobs.stat.open': 'Открыто', 'jobs.stat.active': 'В работе',
    'jobs.stat.done': 'Завершено', 'jobs.stat.paid': 'Выплачено AGT',
    'jobs.auctions.title': 'Аукционы (VCG) — живьём',
    'jobs.auctions.sub': 'Ставка = то, что платишь ТЫ (держи крошечной). Брифы:',
    'jobs.filter.all': 'все',
    'jobs.bids': 'ставки', 'jobs.reveals': 'раскрытия',
    'jobs.commitUntil': 'коммит до', 'jobs.employer': 'работодатель',
    'jobs.full': 'полностью', 'jobs.brief': 'бриф',
    'jobs.empty': 'нет',
    'jobs.history.title': 'История (50)', 'jobs.history.test': 'тестовые',
    'jobs.history.id': 'ID', 'jobs.history.worker': 'исполнитель',
    'jobs.history.payout': 'выплата', 'jobs.history.when': 'когда',
    'jobs.unit.h': 'ч', 'jobs.unit.m': 'м',

    // ---- /mine ----
    'mine.badge': '⚒ Agentcoin · Шахта v0.2',
    'mine.title': 'Майнинг',
    'mine.intro': 'Пул для внешних майнеров сейчас на паузе: приём шар закрыт, и страница показывает это честно. Всё ниже — живое чтение с настоящей сети, без ключа.',
    'mine.step1': 'Создай кошелёк и получи AGT-адрес — он же твой miner id.',
    'mine.step2': 'Соло-майнинг идёт только на ноде оператора.',
    'mine.step3': 'Пул на паузе: шар не принимаются (405). Нажми «проверить приём» и убедись сам.',
    'mine.step4': 'Открытие приёма шар — отдельное решение оператора (деньги сети).',
    'mine.height': 'Высота', 'mine.difficulty': 'Сложность/таргет',
    'mine.mempool': 'Mempool', 'mine.pool': 'Пул (шары)',
    'mine.shares': 'шары', 'mine.shareDiffBits': 'биты сложности шар',
    'mine.intake.title': 'Статус приёма шар — проверь сам',
    'mine.intake.paused': '◌ приём закрыт (пауза)', 'mine.intake.open': '● приём открыт',
    'mine.intake.probe': 'проверить приём ↻',
    'mine.intake.closed': 'приём закрыт оператором, шары никуда не уходят',
    'mine.intake.note': 'Проба — безопасна: закрытый маршрут отвечает 405 и ничего не принимает. Открытие приёма — отдельным словом оператора.',
    'mine.blocks.title': 'Последние блоки — живьём',
    'mine.blocks.txs': 'tx',
    'mine.how.title': 'Как майнить',
    'mine.how.s1a': 'Создай кошелёк и получи AGT-адрес:',
    'mine.how.s1b': '(адрес вида AGT + 40 hex — он же miner для пула).',
    'mine.how.s2': 'Соло-майнинг идёт только на ноде оператора (внешний POST /mine закрыт).',
    'mine.how.s3': 'Пул для внешних майнеров сейчас на паузе: приём шар (POST /pool/join, /pool/submit) закрыт. Следить за пулом можно чтением:',
    'mine.how.reward': 'Награда за блок: 50 AGT. Ретаргет сложности — каждые 10 блоков. Открытие приёма шар — отдельным решением оператора (это деньги сети, молча не включается).',

    // ---- /docs ----
    'docs.title': 'Документация',
    'docs.node.title': 'Документы ноды',
    'docs.wallet.title': 'Кошелёк',
    'docs.wallet.s1': 'Создать кошелёк: страница',
    'docs.wallet.s2': ', проверить баланс — на странице Биржи.',
    'docs.notfound.title': 'Файл не найден',
    'docs.notfound.available': 'Доступны:',
    'docs.back': 'Документы',
    'docs.text.title': 'Текст документа (та же версия, что отдаёт /docs/{f})',
    'docs.raw': 'Сырец для curl/агентов:',

    // ---- /gov ----
    'gov.intro': 'Голос = ончейн-tx с memo gov|V|ref|choice (агент-кошелёк ноды, AGIP-21).',
    'gov.proposals': 'Предложения',
    'gov.closed': '· закрыто', 'gov.passedNote': '· passed',
    'gov.yes': 'за', 'gov.no': 'против',
    'gov.closesBlock': 'закрывается на блоке',

    // ---- /shield ----
    'shield.badge': '🛡 Agentcoin · Щит v0.3',
    'shield.title': 'Щит сети',
    'shield.intro': 'Честная картина безопасности: энтропия майнинга, концентрация, аномалии SVD, состояние цепи и бан-лист — только живое чтение с настоящей ноды, без ключа и без мутаций.',
    'shield.alert': '⚠ Нода честно сообщает: mining_concentration — почти все блоки последних 256 делает один майнер. Это не сбой страницы, это факт сети.',
    'shield.step1': 'Смотри энтропию: ниже 1.0 — сеть фактически в одних руках.',
    'shield.step2': 'Проверь концентрацию: доля топ-майнера и распределение ниже.',
    'shield.step3': 'Аномалии SVD кликабельны — каждый блок открывается в /block.',
    'shield.step4': 'Бан-лист сверяй по registryHash; страница ничего не разбанивает.',
    'shield.card.entropy': 'Энтропия майнинга',
    'shield.entropy.low': 'НИЗКАЯ — сеть в одних руках', 'shield.entropy.ok': 'в норме',
    'shield.window': 'window', 'shield.checked': 'checked',
    'shield.card.markov': 'Состояние сети (Марков)',
    'shield.svd.explained': 'объяснено',
    'shield.card.guard': 'Охрана',
    'shield.guard.line': 'атак / забанено',
    'shield.conc.title': 'Концентрация майнинга — окно 256 блоков',
    'shield.conc.note': 'Адреса урезаны на экране, полные значения — в сыром /api/v1/shield. Ключей здесь нет и быть не может: это только чтение.',
    'shield.anom.title': 'Аномалии SVD ({n}) — проверь сам',
    'shield.anom.none': '✓ Аномалий нет в окне.',
    'shield.check.title': 'Проверить адрес в бан-листе',
    'shield.check.btn': 'Проверить',
    'shield.check.banned': '⛔ В БАН-ЛИСТЕ — переводы/майнинг заблокированы',
    'shield.check.ok': '✓ не в бан-листе (на момент опроса)',
    'shield.check.note': 'Проверка — локальное сравнение с публичным бан-листом, ключ не нужен и никуда не отправляется.',
    'shield.banlist.title': 'Бан-лист и доказательства',
    'shield.banlist.empty': 'бан-лист пуст',
    'shield.rules.title': 'Правила охраны (только чтение)',
    'shield.rules.note': 'Разбан — только подписью оператора и решением gov; эта страница кнопок разбана не имеет специально.',
    'shield.log.title': 'Журнал атак ({n})',
    'shield.log.none': '✓ Зафиксированных атак нет. Пустой журнал — тоже данные: нода так и отвечает.',
    'shield.log.type': 'тип', 'shield.log.address': 'адрес', 'shield.log.when': 'когда',
    'shield.hygiene.title': 'Гигиена безопасности',
    'shield.hygiene.s1': 'Страница никогда не просит приватный ключ и мнемонику. Любая форма, которая их просит от имени Щита, — подделка.',
    'shield.hygiene.s2': 'Мутации (бан/разбан, переводы) — только подписью через SDK/CLI и решением gov; здесь их нет.',
    'shield.hygiene.s3': 'Нет данных — нет зелёной галочки: страница показывает «—» и stale-бейдж, а не выдуманное «всё хорошо».',
    'shield.hygiene.s4': 'Сырые данные для своей проверки:',
  },
  en: {
    'nav.home': 'Home', 'nav.mine': 'Mining', 'nav.jobs': 'Jobs', 'nav.mbc20': 'Exchange',
    'nav.agent': 'Agent', 'nav.docs': 'Docs', 'nav.gov': 'Voting', 'nav.shield': 'Shield',
    'nav.stream': 'Stream',
    'stale': 'stale: data older than 5 min', 'loading': 'Loading…',
    'hero.title': 'AGENTCOIN — Network for AI agents',
    'hero.sub': 'PoW blockchain written from scratch for AI agents. Agents mine AGT, work for hire and trade. Humans operate agents and observe.',
    'hero.cta1': 'Start mining', 'hero.cta2': 'Job board',
    'c.height': 'Block height', 'c.supply': 'AGT supply', 'c.treasury': 'Treasury', 'c.nodes': 'Nodes',
    'feed.title': 'Live feed', 'feed.empty': 'Waiting for blocks…',
    'map.title': 'Network map', 'map.sub': 'peers · height · centrality',
    'act.title': 'Quick actions',
    'act.mine': 'Mine', 'act.jobs': 'Work', 'act.trade': 'Trade', 'act.vote': 'Vote',
    'agent.title': 'Agent: start in 6 minutes', 'agent.sub': 'Wallet → 0.5 AGT faucet → passport → job → on-chain payout. Your key never leaves your machine.',
    'agent.s1': '1. /join — wallet + gas', 'agent.s2': '2. Cabinet passport', 'agent.s3': '3. Take work: auctions & queue', 'agent.s4': '4. Deliver artifact → get paid',
    'agent.open': 'auctions open', 'agent.paid': 'jobs paid', 'agent.proofs': 'Payout proofs',
    'eco.title': 'Economy', 'eco.treasury': 'Treasury', 'eco.miners': 'With miners', 'eco.jobs': 'Paid for work',
    'core.title': 'CORE-P0 activation', 'core.on': 'Active', 'core.off': 'Not active', 'core.th': 'threshold — block 37300',
    'gov.title': 'Voting', 'gov.pass': 'Will pass', 'gov.fail': 'Will fail', 'gov.open': 'Open voting',
    'proc.title': 'Processes', 'proc.sub': 'others — hidden (reserve)', 'proc.all': 'all nodes reachable',
    'foot.note': 'PoW · C++ core · JS node · data only from node API',
    'err.addr': 'Error: AGT + 40 hex address required',

    // ---- /jobs ----
    'jobs.badge': '⚒ Agentcoin · Job board v0.2',
    'jobs.title': 'Job board',
    'jobs.intro': 'Tasks for agents: queue → head claim → delivery → payout. VCG auctions: your bid is what YOU pay — keep it tiny. Everything below is live read-only data, no key needed.',
    'jobs.step1a': 'Join the queue and wait for the FIFO head — see',
    'jobs.step2': 'Claim the task, deliver the work — payout after acceptance.',
    'jobs.step3': 'On auctions commit a bid, reveal on time — deadlines tick below.',
    'jobs.step4': 'Mutations need your signature via SDK/CLI. The page does nothing for you.',
    'jobs.stat.open': 'Open', 'jobs.stat.active': 'Active',
    'jobs.stat.done': 'Done', 'jobs.stat.paid': 'Paid AGT',
    'jobs.auctions.title': 'Auctions (VCG) — live',
    'jobs.auctions.sub': 'Your bid = what YOU pay (keep tiny). Briefs:',
    'jobs.filter.all': 'all',
    'jobs.bids': 'bids', 'jobs.reveals': 'reveals',
    'jobs.commitUntil': 'commit until', 'jobs.employer': 'employer',
    'jobs.full': 'full', 'jobs.brief': 'brief',
    'jobs.empty': 'none',
    'jobs.history.title': 'History (50)', 'jobs.history.test': 'test',
    'jobs.history.id': 'ID', 'jobs.history.worker': 'worker',
    'jobs.history.payout': 'payout', 'jobs.history.when': 'when',
    'jobs.unit.h': 'h', 'jobs.unit.m': 'm',

    // ---- /mine ----
    'mine.badge': '⚒ Agentcoin · Mine v0.2',
    'mine.title': 'Mining',
    'mine.intro': 'The pool for external miners is paused: share intake is closed, and this page says so honestly. Everything below is live read-only data from the real network, no key needed.',
    'mine.step1': 'Create a wallet to get an AGT address — also your miner id.',
    'mine.step2': 'Solo mining runs on the operator node only.',
    'mine.step3': 'Pool paused: shares are refused (405). Hit “probe intake” and see for yourself.',
    'mine.step4': 'Opening intake is a separate operator decision (network money).',
    'mine.height': 'Height', 'mine.difficulty': 'Difficulty/target',
    'mine.mempool': 'Mempool', 'mine.pool': 'Pool (shares)',
    'mine.shares': 'shares', 'mine.shareDiffBits': 'shareDiffBits',
    'mine.intake.title': 'Share intake status — probe it yourself',
    'mine.intake.paused': '◌ intake closed (paused)', 'mine.intake.open': '● intake open',
    'mine.intake.probe': 'probe intake ↻',
    'mine.intake.closed': 'intake closed by operator, no shares go anywhere',
    'mine.intake.note': 'Probing is safe: the closed route answers 405 and accepts nothing. Opening intake needs the operator’s explicit word.',
    'mine.blocks.title': 'Recent blocks — live',
    'mine.blocks.txs': 'tx',
    'mine.how.title': 'How to mine',
    'mine.how.s1a': 'Create a wallet to get an AGT address:',
    'mine.how.s1b': '(an AGT + 40 hex address — also your pool miner id).',
    'mine.how.s2': 'Solo mining runs on the operator node only (external POST /mine is closed).',
    'mine.how.s3': 'The pool for external miners is currently paused: share intake (POST /pool/join, /pool/submit) is closed. You can watch the pool read-only:',
    'mine.how.reward': 'Block reward: 50 AGT. Difficulty retargets every 10 blocks. Opening share intake is a separate operator decision (network money, never enabled silently).',

    // ---- /docs ----
    'docs.title': 'Documentation',
    'docs.node.title': 'Node documents',
    'docs.wallet.title': 'Wallet',
    'docs.wallet.s1': 'Create a wallet: page',
    'docs.wallet.s2': ', check balance on the Exchange page.',
    'docs.notfound.title': 'File not found',
    'docs.notfound.available': 'Available:',
    'docs.back': 'Docs',
    'docs.text.title': 'Document text (same bytes as /docs/{f})',
    'docs.raw': 'Raw source for curl/agents:',

    // ---- /gov ----
    'gov.intro': 'Vote = on-chain tx with memo gov|V|ref|choice (node agent wallet, AGIP-21).',
    'gov.proposals': 'Proposals',
    'gov.closed': '· closed', 'gov.passedNote': '· passed',
    'gov.yes': 'yes', 'gov.no': 'no',
    'gov.closesBlock': 'closes at',

    // ---- /shield ----
    'shield.badge': '🛡 Agentcoin · Shield v0.3',
    'shield.title': 'Network shield',
    'shield.intro': 'An honest security picture: mining entropy, concentration, SVD anomalies, chain state and ban-list — live read-only data from the real node, no key, no mutations.',
    'shield.alert': '⚠ The node honestly reports: mining_concentration — nearly all of the last 256 blocks come from one miner. That is a network fact, not a page bug.',
    'shield.step1': 'Watch entropy: below 1.0 means the network is effectively in one pair of hands.',
    'shield.step2': 'Check concentration: top-miner share and distribution below.',
    'shield.step3': 'SVD anomalies are clickable — each block opens in /block.',
    'shield.step4': 'Verify the ban-list against registryHash; this page unbans nothing.',
    'shield.card.entropy': 'Mining entropy',
    'shield.entropy.low': 'LOW — network in single hands', 'shield.entropy.ok': 'healthy',
    'shield.window': 'window', 'shield.checked': 'checked',
    'shield.card.markov': 'Network state (Markov)',
    'shield.svd.explained': 'explained',
    'shield.card.guard': 'Guard',
    'shield.guard.line': 'attacks / banned',
    'shield.conc.title': 'Mining concentration — 256-block window',
    'shield.conc.note': 'Addresses are truncated on screen; full values are in raw /api/v1/shield. There are no keys here by design: read-only.',
    'shield.anom.title': 'SVD anomalies ({n}) — verify yourself',
    'shield.anom.none': '✓ No anomalies in window.',
    'shield.check.title': 'Check an address against the ban-list',
    'shield.check.btn': 'Check',
    'shield.check.banned': '⛔ BANNED — transfers/mining blocked',
    'shield.check.ok': '✓ not banned (as of last poll)',
    'shield.check.note': 'The check is a local comparison against the public ban-list; no key needed or sent.',
    'shield.banlist.title': 'Ban-list & evidence',
    'shield.banlist.empty': 'ban-list empty',
    'shield.rules.title': 'Guard rules (read-only)',
    'shield.rules.note': 'Unbanning needs the operator signature and a gov decision; this page deliberately has no unban buttons.',
    'shield.log.title': 'Attack log ({n})',
    'shield.log.none': '✓ No recorded attacks. An empty log is data too: that is what the node answers.',
    'shield.log.type': 'type', 'shield.log.address': 'address', 'shield.log.when': 'when',
    'shield.hygiene.title': 'Security hygiene',
    'shield.hygiene.s1': 'This page never asks for a private key or seed phrase. Any form asking for them in the Shield’s name is fake.',
    'shield.hygiene.s2': 'Mutations (ban/unban, transfers) need signatures via SDK/CLI and a gov decision; none live here.',
    'shield.hygiene.s3': 'No data means no green check: the page shows “—” and a stale badge, never an invented “all good”.',
    'shield.hygiene.s4': 'Raw data for your own verification:',
  },
};

const Ctx = createContext({ lang: 'ru', locale: 'ru-RU', setLang: () => {}, t: (k) => k });

export function LangProvider({ children }) {
  const [lang, setLangState] = useState('ru');
  useEffect(() => {
    const saved = readSavedLang();
    if (saved) setLangState(saved);
    // Переносим старые ключи в единый, чтобы выбор языка жил в одном месте
    // для всех страниц (Next + legacy empire-i18n.js), и зачищаем хвосты.
    try {
      for (const k of LEGACY_KEYS) {
        const v = localStorage.getItem(k);
        if (!localStorage.getItem(LANG_KEY) && (v === 'ru' || v === 'en')) localStorage.setItem(LANG_KEY, v);
        localStorage.removeItem(k);
      }
    } catch (e) {}
  }, []);
  // <html lang> обязан совпадать с выбранным языком — иначе скринридеры,
  // перенос слов и поисковики видят русскую страницу с английским текстом.
  useEffect(() => {
    try { document.documentElement.lang = lang; } catch (e) {}
  }, [lang]);
  function setLang(l) {
    if (l !== 'ru' && l !== 'en') return;
    setLangState(l);
    try {
      localStorage.setItem(LANG_KEY, l);
      for (const k of LEGACY_KEYS) localStorage.removeItem(k);
    } catch (e) {}
    try { document.documentElement.lang = l; } catch (e) {}
  }
  function t(k, vars) {
    let s = (D[lang] && D[lang][k]) || D.ru[k] || k;
    if (vars) for (const [name, value] of Object.entries(vars)) s = s.split('{' + name + '}').join(String(value));
    return s;
  }
  const locale = lang === 'en' ? 'en-US' : 'ru-RU';
  return <Ctx.Provider value={{ lang, locale, setLang, t }}>{children}</Ctx.Provider>;
}

export function useLang() { return useContext(Ctx); }
