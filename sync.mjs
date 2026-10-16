#!/usr/bin/env node
/* ============================================================
   AGENTCOIN sync.mjs v3 — P2P без доверия (decentralization layer)
   Каждый узел — полноценный производный арбитр: не верит никому.

   1) genesisHash MUST match — иначе это другая сеть, отказ.
   2) HEADERS-FIRST: сначала тянут ЗАГОЛОВКИ (/headers) и проверяют
      PoW + prevHash + детерминированное правило сложности. Только
      потом грузят тела (/blocks?from=). Дешёвый отказ на дешёвом.
   3) BEST-CHAIN голосование: при развилке сравниваем СУММАРНУЮ
      работу (chainWork), а не высоту. Тяжелее — канон.
   4) STRIKES пира: невалидный блок/данные → +1 strike; 3 strike →
      пир отсекается на 24ч (peer-meta.json).
   5) TX-GOSSIP: принятая tx расходится между узлами признаётся
      только тем, у кого она новая (петля: дубликат не ре-экспорт).
   ============================================================ */
'use strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  computeBlockHash, hashMeetsDifficulty, merkleRoot, CHAIN_ID,
  chainWork, validateBlockAgainstChain, expectedDifficultyBits,
} from './core.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.AGT_DATA_DIR || path.join(__dirname, 'data'); // как в node.mjs: вторая нода = свой data-dir
const PEERS_FILE = path.join(DATA_DIR, 'peers.json');
const PEER_META_FILE = path.join(DATA_DIR, 'peer-meta.json');

const STRIKE_LIMIT = 3;
const STRIKE_COOLDOWN_MS = 24 * 3600 * 1000;

export function loadPeers() {
  try { return JSON.parse(fs.readFileSync(PEERS_FILE, 'utf8')); } catch { return []; }
}
export function savePeers(list) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(PEERS_FILE, JSON.stringify(list, null, 2));
}
export function addPeer(url) {
  const peers = loadPeers();
  if (!peers.includes(url)) peers.push(url);
  savePeers(peers);
  return peers;
}

export function loadPeerMeta() {
  try { return JSON.parse(fs.readFileSync(PEER_META_FILE, 'utf8')); } catch { return {}; }
}
export function savePeerMeta(meta) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(PEER_META_FILE, JSON.stringify(meta, null, 2));
}
export function peerStrike(peerUrl, reason) {
  const meta = loadPeerMeta();
  const m = (meta[peerUrl] ||= { strikes: 0, accepted: 0 });
  m.strikes++;
  m.lastStrike = { at: new Date().toISOString(), reason: String(reason).slice(0, 200) };
  if (m.strikes >= STRIKE_LIMIT) m.blockedUntil = Date.now() + STRIKE_COOLDOWN_MS;
  savePeerMeta(meta);
  return m;
}
export function peerAccept(peerUrl) {
  const meta = loadPeerMeta();
  const m = (meta[peerUrl] ||= { strikes: 0, accepted: 0 });
  m.accepted++;
  if (m.strikes > 0) m.strikes--; // честный пир восстанавливает репутацию медленно
  if (m.strikes === 0) delete m.blockedUntil;
  savePeerMeta(meta);
}
export function peerMetaStatus() {
  const meta = loadPeerMeta();
  const now = Date.now();
  for (const [url, m] of Object.entries(meta)) {
    if (m.blockedUntil && m.blockedUntil < now) delete m.blockedUntil;
  }
  return meta;
}

// === AGIP-7 (комиссия 2026-10-16): фонд-фикс изоляции ===
// Вердикт «fork_not_heavier» — это ВЫБОР ЦЕПИ, а не доказанное нарушение:
// валидный форк проиграл голосование по работе (или голос разошёлся) —
// ни Bitcoin Core (headers-first, headerssync), ни geth не штрафуют пира
// за проигравший, но валидный форк. Страйк на это создавал изоляцию:
// stale-нода: 1) отклоняет живые форки → strike → 2) пир заблокирован →
// 3) нода перестаёт слышать кластер → 4) майнер закрепляет собственный
// форк → 5) голосование вечно «not heavier» → карантин (инцидент 9342
// 2026-10-16: три пира по 3 strike «fork adopt failed: fork_not_heavier»).
export function isChainChoiceVerdict(reason) {
  const r = String(reason || '');
  return r.startsWith('fork_not_heavier') || r === 'no_blocks' || r === 'fork_height_mismatch';
}

async function fetchJson(url, timeoutMs = 20_000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally { clearTimeout(t); }
}

// Синк с одним пиром. Вносит блоки строго по правилам, отказ в любой момент
// фиксируется strike'ом. Возвращает массив строк лога для /sync-now.
export async function syncOne(bc, peerUrl) {
  const log = [];
  const meta = peerMetaStatus();
  const pm = meta[peerUrl];
  if (pm?.blockedUntil && pm.blockedUntil > Date.now()) {
    log.push(`${peerUrl}: SKIPPED (peer reputation blocked, strikes=${pm.strikes} until ${new Date(pm.blockedUntil).toISOString()})`);
    return log;
  }
  try {
    const info = await fetchJson(peerUrl + '/info');
    if (!info || info.chainId !== CHAIN_ID) { log.push(`${peerUrl}: not AGENTCOIN, skip`); return log; }
    if (!bc.genesisHeader || computeBlockHash(bc.genesisHeader) !== info.genesisHash) {
      log.push(`${peerUrl}: genesis mismatch (different network), skip`);
      return log;
    }
    const myH = bc.blockCount();
    const peerH = info.blocks;
      log.push(`${peerUrl}: peer height ${peerH}, ours ${myH} (our work ${chainWork(bc.chain)})`);
    if (peerH <= myH) { log.push(`  → our chain ≥ peer's, ok`); return log; }

    // ---- HEADERS-FIRST: сначала дешёвая проверка всех заголовков ----
    let headers = null;
    try {
      const hr = await fetchJson(`${peerUrl}/headers?from=${myH}&limit=${peerH - myH + 1}`);
      headers = hr.headers || [];
      log.push(`  → headers-first: ${headers.length} заголовков проверяем дешёво...`);
    } catch {
      log.push(`  → /headers не доступен у пира (старый код), fallback на /blocks`);
    }

    let divergedAt = -1;   // -1 = продолжение нашей цепи; иначе высота развилки
    if (headers && headers.length) {
      // проверяем линию заголовков: prev-сцепка + PoW + правило сложности
      const base = bc.chain.slice(); // наша цепь (референс для правила сложности)
      if (headers[0].height !== myH) { log.push(`  → заголовки не с нашей высоты (${headers[0].height} ≠ ${myH}), skip`); return log; }
      const interim = base.slice();
      for (const hd of headers) {
        if (hd.height !== interim.length) { log.push(`  → header ${hd.height} не стыкуется, reject`); peerStrike(peerUrl, 'headers height gap'); return log; }
        if (hd.header.prevHash !== (interim.length ? interim[interim.length - 1].hash : null) && interim.length) {
          log.push(`  → header ${hd.height} prevHash ≠ наш tip → развилка, ищем divergence...`);
          divergedAt = hd.height;
          break;
        }
        if (computeBlockHash(hd.header) !== hd.hash) { log.push(`  → header ${hd.height} hash mismatch, reject`); peerStrike(peerUrl, 'header hash mismatch'); return log; }
        if (!hashMeetsDifficulty(hd.hash, hd.header.difficultyBits)) { log.push(`  → header ${hd.height} PoW fail, reject`); peerStrike(peerUrl, 'header PoW fail'); return log; }
        // правило сложности (детерминированный ретарджет) — дешёвый отказ на заголовках:
        // чужой блок с заниженным difficultyBits не пройдёт сюда даже с валидным PoW.
        if (expectedDifficultyBits(interim) !== hd.header.difficultyBits) {
          log.push(`  → header ${hd.height} нарушает правило сложности (${hd.header.difficultyBits} ≠ ожидаемых ${expectedDifficultyBits(interim)}), reject`);
          peerStrike(peerUrl, `header difficulty rule violation at ${hd.height}`);
          return log;
        }
        interim.push({ height: hd.height, hash: hd.hash, header: hd.header });
      }
      if (divergedAt < 0) {
        log.push(`  → headers line OK: ${headers.length} заголовков валидны (PoW + prev + difficulty)`);
      }
    } else if (headers && headers.length === 0) {
      log.push(`  → peer вернул 0 заголовков при большей высоте, skip`);
      return log;
    }    // ---- Развилка: голосование по суммарной работе ----
    if (divergedAt >= 0) {
      // первый заголовок окна не сцепился с нашим tip: настоящая точка развилки
      // может быть РАНЬШЕ окна — ищем первое расхождение полных линий заголовков.
      // ВАЖНО: /headers на ноде имеет кап limit=2000 (node.mjs "/headers") — один
      // запрос from=0&limit=myH+1 МОЛЧА урезается до 0..1999, и развилка на высоте
      // >2000 теряется (инцидент 2026-10-15: ноды отсекали пиры с 3 strike
      // "fork adopt failed: prevHash_mismatch" именно из-за этого). Поэтому —
      // пагинация по ≤2000 и честный поиск первого несовпавшего height.
      let d = -2; // -2 = развилка не найдена / скан не удался
      let scanDone = true;
      let scanFrom = 0;
      while (scanFrom < myH && d < 0) {
        const n = Math.min(2000, myH - scanFrom);
        if (n <= 0) break;
        const part = (await fetchJson(`${peerUrl}/headers?from=${scanFrom}&limit=${n}`).catch(() => null))?.headers;
        if (!part || !part.length) { scanDone = false; break; }
        for (const hd of part) {
          if (hd.height >= myH) break; // дошли до конца нашей цепи без расхождений — развилки нет
          const ours = bc.chain[hd.height];
          if (ours && ours.hash !== hd.hash) { d = hd.height; break; }
        }
        if (d >= 0) break;
        scanFrom = part[part.length - 1].height + 1; // единственный ход вперёд (не «+= 2000» — иначе таблица пропусков!)
      }
      if (d === -2) {
        // реальный путь: пиры синхронизированы по 0..myH-1, а окно дало другой блок на myH —
        // но если full-скан не подтвердил общий префикс, безопаснее отказаться.
        if (!scanDone) {
          log.push(`  → не смогли проверить линию 0..${myH - 1} (пир отдал мало/обрыв), skip`);
          return log;
        }
        d = myH; // общий префикс 0..myH-1 сходится: расхождение — в следующем блоке (height myH)
      }
      log.push(`  → точка развилки: высота ${d}`);
      const fullHeaders = (await fetchJson(`${peerUrl}/headers?from=${d}&limit=${peerH - d + 1}`).catch(() => null))?.headers;
      if (!fullHeaders || !fullHeaders.length) { log.push(`  → не получили заголовки развилки, skip`); return log; }
      // сравниваем work от точки развилки
      const ourWork = chainWork(bc.chain.slice(d));
      const candWork = chainWork(fullHeaders.map(hd => ({ header: hd.header })));
      log.push(`  → fork vote: от высоты ${d}, наша работа ${ourWork}, кандидат ${candWork}`);
      if (candWork <= ourWork) {
        log.push(`  → fork слабее — голосуем ЗА НАШУ цепь, чужую отвергаем (не штрафуем: валидный форк проиграл выбор)`);
        return log;
      }
      log.push(`  → fork ТЯЖЕЛЕЕ — переключаемся на чужую цепь (загрузка тел с высоты ${d})...`);
      const bodies = await fetchJson(`${peerUrl}/blocks?from=${d}`);
      const incoming = (bodies.blocks || []).sort((a, b) => a.height - b.height);
      const r = bc.adoptFork(incoming, d);
      if (!r.ok) {
        log.push(`  → adoptFork отказ: ${r.reason}`);
        // AGIP-7: strike ТОЛЬКО за доказанное нарушение данных. Проигравшее
        // голосование по работе — чистый выбор цепи, пира не штрафуем (иначе
        // stale-нода карантинит живой кластер — инцидент 9342, 2026-10-16).
        // Транзиентные отказы (расхождение высот при гонке между peers) — без страйка.
        if (!isChainChoiceVerdict(r.reason)) peerStrike(peerUrl, `fork adopt failed: ${r.reason}`);
        return log;
      }
      log.push(`  → RE-ORG принят: dropped=${r.dropped}, добавлено=${r.added}`);
      peerAccept(peerUrl);
      return log;
    }

    // ---- Линейный append: грузим тела и валидируем КАЖДЫЙ блок строго ----
    const bodies = await fetchJson(`${peerUrl}/blocks?from=${myH}`);
    const incoming = (bodies.blocks || []).sort((a, b) => a.height - b.height);
    let accepted = 0;
    const interim = bc.chain.slice();
    for (const blk of incoming) {
      // дешёвая (headers-only) проверка уже была; здесь — полная, против нарастающего префикса
      const known = headers && headers.find(hd => hd.height === blk.height);
      if (known && known.hash !== blk.hash) { log.push(`  → hash заголовка/тела расходится на ${blk.height}`); peerStrike(peerUrl, `header/body hash divergence at ${blk.height}`); return log; }
      const reason = validateBlockAgainstChain(blk, interim, { treasury: bc.getTreasuryPolicy() });
      if (reason) {
        log.push(`  → block ${blk.height} REJECTED: ${reason} — плохой блок от пира не примем`);
        peerStrike(peerUrl, `invalid block ${blk.height}: ${reason}`);
        return log; // дальше цепь не может быть консистентной
      }
      interim.push(blk);
      accepted++;
    }
    if (accepted) {
      bc.chain = interim;
      bc.invalidateTxCache();
      bc.difficultyBits = bc.tip().header.difficultyBits;
      bc.refilterMempool();
      bc.save();
      peerAccept(peerUrl);
      log.push(`  → accepted ${accepted} blocks from peer (полная валидация всех)`);
    }
  } catch (e) {
    log.push(`${peerUrl}: ERROR ${e.message}`);
  }
  return log;
}

export async function syncAll(bc) {
  const peers = loadPeers();
  const out = [];
  const meta = peerMetaStatus();
  const allBlocked = peers.length > 0 && peers.every(u => meta[u]?.blockedUntil && meta[u].blockedUntil > Date.now());
  let valve = null;
  if (allBlocked && bc && typeof bc.tip === 'function') {
    const tipAge = Date.now() - ((bc.tip()?.header?.timestamp) || 0);
    if (tipAge > 300_000) {
      // === AGIP-7: клапан самопомощи изоляции ===
      // Если ВСЕ пиры заблокированы И наш tip протух (>300с) — сеть не слышна,
      // RC-script-карантин ведёт к вечному форку (инцидент 9342). Снимаем блоки
      // (страйки остаются в истории! только blockedUntil), чтобы sync мог слушаться.
      const freshMeta = loadPeerMeta();
      for (const u of peers) if (freshMeta[u]?.blockedUntil) delete freshMeta[u].blockedUntil;
      savePeerMeta(freshMeta);
      valve = `SAFETY VALVE: все ${peers.length} пиров заблокированы, tip протух ${Math.round(tipAge / 1000)}с → блокировка пиров снята (страйки не затёрты)`;
    }
  }
  if (valve) out.push(valve);
  for (const p of peers) out.push(...await syncOne(bc, p));
  return out;
}

// ---- TX-GOSSIP: разошлём принятую tx по пирам ----
// Пир, у которого tx уже есть, отвечает rejected (duplicate) и НЕ ре-экспортирует
// → петли нет. Самого себя исключаем по URL.
export async function gossipTx(tx, ownUrl, opts = {}) {
  const peers = loadPeers();
  const exclude = new Set([ownUrl, ...(opts.exclude || [])]);
  const results = [];
  for (const peer of peers) {
    if (exclude.has(peer)) continue;
    try {
      const r = await fetch(peer + '/tx', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(tx), signal: AbortSignal.timeout(8000),
      });
      const j = await r.json().catch(() => ({}));
      results.push({ peer, status: r.status, resp: j });
    } catch (e) {
      results.push({ peer, error: e.message });
    }
  }
  return results;
}
