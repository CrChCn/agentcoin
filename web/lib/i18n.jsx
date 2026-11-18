'use client';
import { createContext, useContext, useEffect, useState } from 'react';

const D = {
  ru: {
    'nav.home': 'Сайт', 'nav.mine': 'Майнинг', 'nav.jobs': 'Джобборд', 'nav.mbc20': 'Биржа',
    'nav.agent': 'Агент', 'nav.docs': 'Доки', 'nav.gov': 'Голосование', 'nav.shield': 'Щит',
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
  },
  en: {
    'nav.home': 'Home', 'nav.mine': 'Mining', 'nav.jobs': 'Jobs', 'nav.mbc20': 'Exchange',
    'nav.agent': 'Agent', 'nav.docs': 'Docs', 'nav.gov': 'Voting', 'nav.shield': 'Shield',
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
  },
};

const Ctx = createContext({ lang: 'ru', setLang: () => {}, t: (k) => k });

export function LangProvider({ children }) {
  const [lang, setLangState] = useState('ru');
  useEffect(() => {
    try {
      const s = localStorage.getItem('ag_dlang');
      if (s === 'ru' || s === 'en') setLangState(s);
    } catch (e) {}
  }, []);
  function setLang(l) {
    setLangState(l);
    try { localStorage.setItem('ag_dlang', l); } catch (e) {}
  }
  function t(k) { return (D[lang] && D[lang][k]) || D.ru[k] || k; }
  return <Ctx.Provider value={{ lang, setLang, t }}>{children}</Ctx.Provider>;
}

export function useLang() { return useContext(Ctx); }
