// Живая котировка из пула Sepolia: только чтение (eth_call), без кошелька и подписей.
import { formatWei } from './math.js';

const RPCS = [
  'https://ethereum-sepolia-rpc.publicnode.com',
  'https://rpc.sepolia.org',
];
const ROUTER = '0xeE567Fe1712Faf6149d80dA1E6934e354124CfE3';
const WAGT = '0x64fea6b5a6be1ca8f8301ad63b33356ea548b590';
const TAGT = '0x3fdd80f38e2f8678d669cc329fc25cf642fc1a50';
const AMT_IN = 2000000000000000000n;

// Снимок, сверенный вручную: блок 12103142, getAmountsOut(2 wAGT) = 17268890760796809396,
// совпадает с посчитанным по резервам 42 / 381.006810496737629186 того же блока.
export const SNAPSHOT = {
  block: 12103142,
  outWei: 17268890760796809396n,
};

// Декодирует ответ getAmountsOut (uint[]: offset, len, amounts...). Бросает на мусоре.
export function decodeAmountsOut(hex) {
  if (typeof hex !== 'string' || !/^0x[0-9a-fA-F]+$/.test(hex)) throw new Error('Не hex-ответ RPC.');
  const w = (i) => BigInt('0x' + hex.slice(2 + i * 64, 2 + (i + 1) * 64));
  if (hex.length < 2 + 64 * 4) throw new Error('Короткий ответ RPC.');
  if (w(0) !== 32n || w(1) !== 2n) throw new Error('Ответ — не массив из 2 сумм.');
  return [w(2), w(3)];
}

const enc = (v, n = 64) => v.toString(16).padStart(n, '0');
const addr = (a) => a.replace('0x', '').padStart(64, '0');
const CALLDATA = '0xd06ca61f' + enc(AMT_IN) + enc(64n) + enc(2n) + addr(WAGT) + addr(TAGT);

async function rpc(rpc, method, params) {
  const r = await fetch(rpc, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error('RPC: ' + JSON.stringify(j.error).slice(0, 160));
  return j.result;
}

export async function fetchLiveQuote() {
  let lastErr;
  for (const rpcUrl of RPCS) {
    try {
      const blockHex = await rpc(rpcUrl, 'eth_blockNumber', []);
      const raw = await rpc(rpcUrl, 'eth_call', [{ to: ROUTER, data: CALLDATA }, blockHex]);
      const [, out] = decodeAmountsOut(raw);
      return { block: parseInt(blockHex, 16), outWei: out, rpc: rpcUrl };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('Нет ответа RPC.');
}

if (typeof window !== 'undefined') window.addEventListener('DOMContentLoaded', () => {
  const btn = document.getElementById('live-refresh');
  if (!btn) return;
  btn.onclick = async () => {
    const msg = document.getElementById('live-msg');
    btn.disabled = true;
    msg.textContent = 'Запрашиваю котировку чтением из сети…';
    try {
      const q = await fetchLiveQuote();
      document.getElementById('live-out').textContent = formatWei(q.outWei) + ' tAGT';
      document.getElementById('live-block').textContent = 'блок ' + q.block;
      msg.textContent = 'Живая котировка (' + q.rpc + '). Транзакция не отправлялась, газ не тратился.';
    } catch (e) {
      msg.textContent = 'Не удалось прочитать сеть (' + e.message + '). Ниже — сверенный снимок.';
    }
    btn.disabled = false;
  };
});
