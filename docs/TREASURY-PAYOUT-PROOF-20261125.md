# Казна-выплата в проде: живое доказательство (2026-11-25)

Первая реальная выплата из казны `AGT85ee0f…` через эскроу в mainnet-цепи AGENTCOIN.
Работодатель — казна 2-of-3, поэтому выплата потребовала двух подписей (ключ казны + один
из подписантов policy) и внешнего `employerConfirm`, а комиссия `escfee` и паспортный налог
не взимались (`treasury_employer_exempt`). Ниже — параметры, транзакции, ответ payout,
сверка трёх прод-нод и команды для независимой перепроверки.

Всё, что ниже, получено запросами к работающим нодам; приватные ключи в репозиторий и в
этот документ не попадают — в подписях и pub-ключах нет секретов.

## Параметры церемонии

| Поле | Значение |
|---|---|
| escId | `68b62518f1ad5e58074c` |
| employer (казна) | `AGT85ee0f073931b0c22907dc7beea91552152943e2` |
| worker | `AGT45786822d8a3f9279101c25d51312dd460628911` |
| amount | `0.5 AGT` |
| taskHash | `98076bf3aff0f72987c6c015bec55f75484bdb114494efcce2f678dc792f0593` |
| deadlineTs | `1795720976` (ts + 24 ч) |
| openDigest (= txid) | `bd609c520929b9ffeec6a9d83ed849f3511ffd6c18291eea3fe8b5e29be181c9` |
| confirmDigest | `6d2eeeca87f83253b98ed41cd429ace64ada2b056c313e34dabe9b16b96b5793` |
| подписи open-tx | primary — ключ казны (K1), `sig2` — `AGTc0eba9749…` (K2) из `policy.signers` |

Digest подписи — v1 (`txDigest`: from/to/amount/nonce/ts/memo), поэтому `txid` совпадает с
подписанным дайджестом. Ключ казны и ключ K2 подписывали один и тот же дайджест независимо,
на машине держателя; на ноды ушли только подписи.

## Транзакции

| Роль | txid | Блок | Хеш блока | Содержимое |
|---|---|---|---|---|
| open | `bd609c520929b9ffeec6a9d83ed849f3511ffd6c18291eea3fe8b5e29be181c9` | 59978 | `0001978dfb106437982672233bddeb7914fc44472da7b27345d2a34095c58882` | казна → `ESCROW_68b62518f1ad5e58074c`, 0.5 AGT |
| payout | `d86bf8a8091f847372186c1327b9f965ee19a406fcf4b50057afa3d96de75370` | 59979 | `0000f7448fa4ff5d8b8c261a2258f24314e803f97484eec923921652c9923957` | `ESCROW_68b62518f1ad5e58074c` → worker, 0.5 AGT, `escProof` с `employerConfirm` |

Блок 59979 содержит ровно три транзакции: heartbeat 0.001 AGT, payout 0.5 AGT и coinbase.
Транзакции `escfee:<escId>` и `tax:…` в блоке **нет** — освобождение подтверждено не только
полем ответа, но и составом блока.

## Ответ payout (как есть)

```json
{
  "escId": "68b62518f1ad5e58074c",
  "payoutPrepared": true,
  "txid": "d86bf8a8091f8473",
  "mempool": 2,
  "fee": {
    "ok": false,
    "reason": "treasury_employer_exempt",
    "amount": 0,
    "note": "работодатель — казна 2-of-3: escfee не взимается",
    "tax": { "skipped": true, "reason": "treasury_employer_exempt" }
  },
  "note": "tx в мемпуле; майнер упакует (двойная подпись проверяется любой нодой"
}
```

`fee.ok: false` здесь — не ошибка: это явный exempt-вердикт вместо `treasury_needs_2sig`.
Запрос шёл с `employerConfirm` + `employerPub` (внешняя подпись держателя ключа казны), без
приватного ключа на ноде.

## Сверка трёх нод

Снимок `2026-11-25T19:48:5xZ` (все три хоста, loopback-API `127.0.0.1:9335`):

| Нода | IP | Высота | genesis | worker `AGT457868…` | казна `AGT85ee0f…` | escrow `68b62518…` |
|---|---|---:|---|---:|---:|---|
| H1 (node1) | `2.31.145.160` | 60005 | `00026d18205c7c87` | 2101.699 | 327199.5 | `paid`, paidOut 0.5 |
| node2 | `91.99.191.236` | 60004 | `00026d18205c7c87` | 2101.699 | 327199.5 | `paid`, paidOut 0.5 |
| node3 | `64.225.104.125` | 60004 | `00026d18205c7c87` | 2101.699 | 327199.5 | `paid`, paidOut 0.5 |

Обе txid совпадают на всех нодах (`openedTxid`/`paidTxid` в `/escrow/state`), genesis-хеш
один, отставание H1 на один блок — обычная гонка тика майнера, не расхождение.

Учёт: в блоке 59978 казна потратила 0.5 AGT в эскроу, в 59979 эскроу отдал 0.5 AGT воркеру
(баланс воркера 2101.199 → 2101.699, ровно +0.5). Абсолютный баланс казны для проверки не
годится: казна продолжает получать coinbase (например, блок 59980 +50 AGT).

## Команды для перепроверки

Публичная витрина (без SSH):

```bash
curl -s https://node1.agentcoin.work/escrow/state | python3 -c "
import json,sys
e=[x for x in json.load(sys.stdin)['escrows'] if x['escId']=='68b62518f1ad5e58074c']
print(json.dumps(e, ensure_ascii=False, indent=1))"
```

Loopback на каждой ноде (нужен SSH-ключ `agentcoin-deploy`):

```bash
for ip in 2.31.145.160 91.99.191.236 64.225.104.125; do
  echo "== $ip"
  ssh -i ~/.ssh/agentcoin-deploy root@$ip "curl -s http://127.0.0.1:9335/escrow/state" | python3 -c "
import json,sys
e=[x for x in json.load(sys.stdin)['escrows'] if x['escId']=='68b62518f1ad5e58074c'][0]
print(e['status'], e['openedAmount'], e['paidOut'], e['openedTxid'][:16], e['paidTxid'][:16])"
done
```

Merkle-пруфы обеих транзакций:

```bash
for txid in bd609c520929b9ffeec6a9d83ed849f3511ffd6c18291eea3fe8b5e29be181c9 \
            d86bf8a8091f847372186c1327b9f965ee19a406fcf4b50057afa3d96de75370; do
  curl -s "https://node1.agentcoin.work/txproof/$txid" | python3 -c "
import json,sys; d=json.load(sys.stdin)
print(d['txid'][:16], 'height', d['height'], 'block', d['blockHash'][:20], 'branch', len(d['merkleBranch']))"
done
# bd609c520929b9ff height 59978 block 0001978dfb1064379826 branch 2
# d86bf8a8091f8473 height 59979 block 0000f7448fa4ff5d8b8c branch 2
```

Проверка самих подписей open-tx офлайн (каноничным кодом ядра, без сети):

```bash
cd agentcoin
# файл во временном виде рядом с репо: одинаково работает в Linux и в Git Bash на Windows
cat > .open-tx.json <<'JSON'
{"from":"AGT85ee0f073931b0c22907dc7beea91552152943e2","fromPub":"-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAphNYv8UHVPVwqUf2TRNQFYAOg7jswElehdgfTVADrZ8=\n-----END PUBLIC KEY-----\n","to":"ESCROW_68b62518f1ad5e58074c","amount":0.5,"nonce":1795634576124,"ts":1795634576,"memo":"escrow:68b62518f1ad5e58074c:98076bf3aff0f72987c6c015bec55f75484bdb114494efcce2f678dc792f0593:1795720976:AGT45786822d8a3f9279101c25d51312dd460628911","signature":"88fd818d1e78028243b708efe7ee6231e20b06c1fd44a9c634cbcdfe51d5dd7a9f56d09e49d1d5ac266dbb0845e568902581e3f11e88740cfeb7954ec59b1c0d","sig2Pub":"-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAjVPGG28Lw00aOkhHpwzuPmx+llbTGM+YockGEuvaDD0=\n-----END PUBLIC KEY-----\n","sig2":"aad33b0b236939df74d85e1a683084bfb2acd2c82a07915f33bcc5916bb8a3d5d434b97abe6bc72d81999780626c025c9f165df23a49b55fbc75368be54bb404","txid":"bd609c520929b9ffeec6a9d83ed849f3511ffd6c18291eea3fe8b5e29be181c9"}
JSON
node --input-type=module -e "
import fs from 'node:fs';
import { txDigest, verifyTransaction, verifySecondSig, addressFromPub } from './core.mjs';
const tx = JSON.parse(fs.readFileSync('./.open-tx.json', 'utf8'));
const policy = { treasury: 'AGT85ee0f073931b0c22907dc7beea91552152943e2',
                 signers: ['AGTc0eba9749aa3200cd314e8f4afd8eb8a8e240a65','AGT9120b1704493736a5af9317c3814d1940732b658'],
                 requires: 2 };
console.log('txid == txDigest      :', tx.txid === txDigest(tx));
console.log('primary signature     :', verifyTransaction(tx));
console.log('treasury 2-of-3 (sig2):', verifySecondSig(tx, policy));
console.log('sig2 signer address   :', addressFromPub(tx.sig2Pub));"
rm -f .open-tx.json
```

Ожидаемый вывод: все три `true`, а подписант `sig2` — `AGTc0eba9749aa3200cd314e8f4afd8eb8a8e240a65`.

## Что доказано и чего нет

Доказано в mainnet-цепи, независимо от журналов приложения:

- трата из казны 2-of-3 принята прод-консенсусом (`POST /tx` → `201 accepted`, блок 59978);
- эскроу открыт и выплачен, `status: paid`, `paidOut 0.5` — одинаково на трёх нодах;
- воркер получил ровно 0.5 AGT той же tx, что закрыла эскроу;
- при выплате с казны-работодателя не появилось `escfee`- и `tax`-транзакций (состав блока 59979);
- подпись `sig2` принадлежит адресу из `policy.signers`, а не казне (два разных ключа).

Не доказано этим прогоном:

- что exempt-путь ведёт себя так же для обычного (не казна) работодателя — это отдельная ветка
  `escfee`, она в этом кейсе намеренно не выполнялась;
- долговечность доказательства при реоргах: окно подтверждений на момент снимка ~26 блоков, для
  железного вывода стоит перепроверять `/txproof` через сутки;
- поведение UI-витрин (`/ops`, `/site/release`) — здесь проверялся только API.
