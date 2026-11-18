#!/usr/bin/env node
/* Пакет среза SDK→CLI→MCP: воспроизводимый tar.gz + SHA-256 + commit ID.
   Исключаем: кошельки, пароли, .env, рабочие базы, журналы, node_modules. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILES = [
  'sdk/js/agentcoin-sdk.mjs', 'sdk/js/stand-server.mjs', 'sdk/js/schemas.mjs', 'sdk/js/agentcoin.example.json',
  'tools/agentcoin.mjs', 'mcp/agentcoin-mcp.mjs', 'scripts/agentcoin-stand.mjs',
  'test/agentcoin-sdk-slice.mjs', 'test/agentcoin-contract.mjs', 'test/agentcoin-mcp-client.mjs', 'test/agentcoin-market-b.mjs',
  'docs/AGENTCOIN-SDK.md', 'queue.mjs', 'queue-auth.mjs', 'queue-guards.mjs', 'core.mjs', 'vclock.mjs',
];
for (const f of FILES) if (!fs.existsSync(path.join(ROOT, f))) { console.error('missing: ' + f); process.exit(1); }
const commit = (() => { try { return execSync('git rev-parse HEAD', { cwd: ROOT }).toString().trim(); } catch { return 'unknown'; } })();
const ts = new Date().toISOString().replace(/[:.]/g, '-');
const dir = path.join(ROOT, 'dist', `agentcoin-sdk-${ts}`);
fs.mkdirSync(dir, { recursive: true });
for (const f of FILES) {
  const dst = path.join(dir, f);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(path.join(ROOT, f), dst);
}
const README = `# Agentcoin SDK slice v0.2 (commit ${commit})\n\nБезопасный вход стороннего агента. Без mainnet, без консенсуса.\n\n## Запуск в чистом каталоге\n\n\`\`\`bash\ntar -xzf agentcoin-sdk-<ts>.tar.gz\ncd agentcoin-sdk-<ts>\nnode --check sdk/js/agentcoin-sdk.mjs\nnode test/agentcoin-sdk-slice.mjs    # 8 PASS\nnode test/agentcoin-contract.mjs     # 17 PASS\nnode test/agentcoin-mcp-client.mjs   # 8 PASS\nnode scripts/agentcoin-stand.mjs     # полный проход + журнал\ncp sdk/js/agentcoin.example.json config.json  # впиши address/node/wallet\nnode tools/agentcoin.mjs status --address ADDR --node URL\nAGENTCOIN_NODE=URL AGENTCOIN_ADDRESS=ADDR node mcp/agentcoin-mcp.mjs\n\`\`\`\n\n## Поддерживается / нет\n\n- Да: чтение без ключа; signed join/claim/done на стенде (capabilities + verifyActionSig + nonce);\n  legacy только при AGENTCOIN_ALLOW_LEGACY_WRITE=1; журнал reserved/sent/acked/needs_reconcile;\n  отказы foreign_task/ownership_unknown/BODY_MISMATCH/WRONG_NETWORK; MCP stdio.\n- Нет: signed-мутации на рабочей ноде (там legacy-only — SDK отвечает signed_unsupported без fallback);\n  review/obligation (legacy /queue/done их не даёт); выплаты вне цепи (payments различает accepted/txSent/confirmed).\n\nЗависимости: только встроенные модули node (zero-deps). Секретов в пакете нет.\n`;
fs.writeFileSync(path.join(dir, 'README.md'), README);
const sums = [];
const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else { const h = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); sums.push(h + '  ' + path.relative(dir, p)); } } };
walk(dir);
sums.sort();
fs.writeFileSync(path.join(dir, 'SHA256SUMS'), sums.join('\n') + '\n');
execSync(`tar -czf dist/agentcoin-sdk-${ts}.tar.gz -C dist agentcoin-sdk-${ts}`, { cwd: ROOT });
const tgz = `dist/agentcoin-sdk-${ts}.tar.gz`;
const tgzHash = crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, tgz))).digest('hex');
console.log(tgz + '\nsha256: ' + tgzHash + '\ncommit: ' + commit + '\nfiles: ' + FILES.length);
