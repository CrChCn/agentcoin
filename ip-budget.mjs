// ip-budget.mjs — ключ суточного бюджета по клиентскому IP (общий для /join и /faucet/drip).
//
// Зачем: каждый /join выдаёт НОВЫЙ адрес + 0.5 AGT, поэтому лимит «на адрес» накрутку не держит.
// Лимит по IP ломается двумя способами, и оба закрыты здесь:
//   1) IPv6: у одной машины/подсети обычно целая /64 (2^64 адресов) — считаем бюджет на /64,
//      а не на отдельный адрес;
//   2) X-Forwarded-For: при прямом доступе к ноде клиент подставляет что угодно. Заголовки
//      принимаем только от доверенного прокси (loopback/RFC1918/CGNAT/link-local/ULA),
//      иначе берём адрес сокета — подделка заголовка не даёт нового бюджета.
import net from 'node:net';

function strip(raw) {
  return String(raw == null ? '' : raw).trim().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
}

const MAPPED_RE = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;

/** Канонический вид IP без скобок/порта/zone-id; '' для пустого значения. */
export function normalizeIp(raw) {
  const ip = strip(raw);
  if (!ip) return '';
  const mapped = ip.match(MAPPED_RE);
  if (mapped) return mapped[1]; // dual-stack сокет Caddy отдаёт как ::ffff:1.2.3.4
  return ip.toLowerCase();
}

function groups(ip) {
  const [head, tail] = ip.includes('::') ? ip.split('::') : [ip, ''];
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const fill = Math.max(0, 8 - h.length - t.length);
  return [...h, ...Array(fill).fill('0'), ...t].map((g) => (parseInt(g || '0', 16) || 0).toString(16));
}

/** Ключ бюджета: IPv4 — адрес как есть, IPv6 — подсеть /64. */
export function ipBucket(raw) {
  const ip = normalizeIp(raw);
  if (!ip) return 'unknown';
  if (net.isIPv4(ip)) return ip;
  if (net.isIPv6(ip)) return groups(ip).slice(0, 4).join(':') + '::/64';
  return ip;
}

const PRIVATE_V4 = [/^10\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./, /^169\.254\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./];

/** Прокси, чьим заголовкам можно верить: локальный Caddy/cloudflared/nginx и частные сети. */
export function isTrustedProxy(raw) {
  const ip = normalizeIp(raw);
  if (!ip) return false;
  if (ip === '127.0.0.1' || ip === '::1') return true;
  if (net.isIPv4(ip)) return PRIVATE_V4.some((re) => re.test(ip));
  if (!net.isIPv6(ip)) return false;
  const first = parseInt(groups(ip)[0], 16);
  return (first & 0xfe00) === 0xfc00   // fc00::/7 — ULA
    || (first & 0xffc0) === 0xfe80;    // fe80::/10 — link-local
}

/**
 * IP клиента для бюджета: доверенный прокси → последний хоп X-Forwarded-For
 * (его дописывает наш прокси; первый хоп клиент подделывает сам) → X-Real-IP /
 * CF-Connecting-IP → адрес сокета. Недоверенный пир = заголовки игнорируются.
 */
export function clientIp(req) {
  const peer = normalizeIp(req && req.socket && req.socket.remoteAddress);
  if (!isTrustedProxy(peer)) return peer || 'unknown';
  const headers = (req && req.headers) || {};
  const xff = String(headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (xff.length) return normalizeIp(xff[xff.length - 1]) || peer;
  const real = normalizeIp(headers['x-real-ip'] || headers['cf-connecting-ip']);
  return real || peer;
}
