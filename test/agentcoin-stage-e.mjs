#!/usr/bin/env node
/* Этап E (ТЗ §12–§13): независимый поставщик ресурса и альтернативный клиент.
   Проверяем:
     - ресурс — измеримая квота, а не готовый результат: аренда задаёт потолок,
       потребление фиксирует поставщик, оплата идёт только за измеренное;
     - поставщик независим: у него свой endpoint, платформа его не вызывает и не
       проверяет (verified=false), а заказчик обращается к ресурсу сам;
     - альтернативный клиент (без импорта кода проекта) проходит тот же протокол
       с обеих сторон: и как поставщик, и как заказчик с оплатой. */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createStand } from '../sdk/js/stand-server.mjs';
import { makeClient } from '../sdk/js/agentcoin-sdk.mjs';
import { createAltClient, addressFromPublicKey } from '../clients/alt-client.mjs';
import { addressFromPub } from '../core.mjs';

let pass = 0, fail = 0;
const ok = (c, name, extra = '') => { c ? pass++ : fail++; console.log((c ? 'PASS  ' : 'FAIL  ') + name + (extra ? ' — ' + extra : '')); };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agte-'));
process.env.STAND_ALLOW_LOCAL_RESOURCE_ENDPOINT = '1'; // только для endpoint ресурса
let stand = await createStand(tmp);
const J = (n) => path.join(tmp, n + '.json');

const mk = (name) => {
  const k = crypto.generateKeyPairSync('ed25519');
  const pub = k.publicKey.export({ type: 'spki', format: 'pem' });
  const addr = addressFromPub(pub);
  const w = path.join(tmp, name + '.wallet.json');
  fs.writeFileSync(w, JSON.stringify({ address: addr, public_key_pem: pub, privateKeyPem: k.privateKey.export({ type: 'pkcs8', format: 'pem' }) }));
  return { addr, w };
};
const P = mk('provider'), C = mk('customer'), P2 = mk('provider2');
const sdk = (o, tag) => makeClient({ node: stand.url, address: o.addr, walletFile: o.w, journalFile: J(tag) });

// Альтернативный клиент: доказательство, что он не тянет код проекта.
{
  const src = fs.readFileSync(new URL('../clients/alt-client.mjs', import.meta.url), 'utf8');
  ok(!/from\s+['"]\.{1,2}\//.test(src) && !/require\(['"]\.{1,2}\//.test(src),
    'альтернативный клиент не импортирует код проекта');
  ok(addressFromPublicKey(JSON.parse(fs.readFileSync(P.w, 'utf8')).public_key_pem) === P.addr,
    'альтернативный клиент сам выводит адрес из ключа (формула совпала)');
}

// Поставщик поднимает СВОЙ ресурс — отдельный процесс, вне платформы.
let hits = 0;
const providerServer = http.createServer((req, res) => {
  hits++;
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ unit: 'second', servedBy: 'provider-process', path: req.url }));
});
await new Promise((r) => providerServer.listen(0, '127.0.0.1', r));
const providerUrl = `http://127.0.0.1:${providerServer.address().port}/quota`;

const altP = createAltClient({ node: stand.url, walletFile: P.w });
const cP = sdk(P, 'p'), cC = sdk(C, 'c'), cP2 = sdk(P2, 'p2');

// 1. независимый поставщик публикует ресурс через альтернативный клиент
let leaseId;
{
  const caps = await altP.capabilities();
  ok(Array.isArray(caps?.actions) && caps.actions.includes('rlease') && caps.actions.includes('rconsume'),
    'альтернативный клиент находит действия ресурса через capabilities');

  const reg = await altP.registerResource({
    resourceId: 'cpu-sec', kind: 'compute', unit: 'second', priceAtomicPerUnit: 7,
    capacity: 10000, endpoint: providerUrl, terms: 'оплата по измеренному времени, остаток квоты не оплачивается',
    expiresAt: Date.now() + 3_600_000,
  });
  ok(reg.status === 200 && reg.data?.resource?.provider === P.addr && reg.data?.resource?.verified === false,
    'ресурс зарегистрирован, verified=false (платформа не ручается)', reg.data?.error || '');

  const badKind = await altP.registerResource({ resourceId: 'cpu-x', kind: 'magic', unit: 'second', priceAtomicPerUnit: 1, capacity: 10, expiresAt: Date.now() + 60000 });
  ok(badKind.status === 400 && badKind.data?.error === 'bad_kind', 'неизвестный вид ресурса отвергнут');

  const badPrice = await altP.registerResource({ resourceId: 'cpu-y', kind: 'compute', unit: 'second', priceAtomicPerUnit: 0, capacity: 10, expiresAt: Date.now() + 60000 });
  ok(badPrice.status === 400 && badPrice.data?.error === 'bad_price', 'нулевая цена за единицу отвергнута');

  delete process.env.STAND_ALLOW_LOCAL_RESOURCE_ENDPOINT;
  const ssrf = await altP.registerResource({ resourceId: 'cpu-z', kind: 'compute', unit: 'second', priceAtomicPerUnit: 2, capacity: 10, endpoint: providerUrl, expiresAt: Date.now() + 60000 });
  process.env.STAND_ALLOW_LOCAL_RESOURCE_ENDPOINT = '1';
  ok(ssrf.status === 400 && ssrf.data?.error === 'ssrf_denied', 'локальный endpoint без явного флага отвергнут (SSRF)');

  const list = await cC.listResources({ kind: 'compute' });
  ok(Array.isArray(list?.resources) && list.resources.some((r) => r.resourceId === 'cpu-sec' && r.leaseable === true),
    'заказчик находит ресурс по каталогу');
}

// 2. аренда квоты: потолок, а не списание
{
  const self = await altP.lease('cpu-sec', 10, { idempotencyKey: 'self' });
  ok(self.status === 409 && self.data?.error === 'self_lease', 'свой ресурс арендовать нельзя');

  const lease = await cC.leaseResource(C.addr, 'cpu-sec', 600, { idempotencyKey: 'lease-1' });
  leaseId = lease.result?.lease?.leaseId;
  ok(lease.ok === true && lease.result.lease.capAtomic === 4200 && lease.result.lease.usedUnits === 0,
    'аренда 600 единиц: потолок 4200, потреблено 0', lease.error || '');

  const again = await cC.leaseResource(C.addr, 'cpu-sec', 600, { idempotencyKey: 'lease-1' });
  ok(again.replay === true && again.result.lease.leaseId === leaseId, 'повтор аренды — та же квота (идемпотентность)');

  const overCap = await cC.leaseResource(C.addr, 'cpu-sec', 20000);
  ok(overCap.ok === false && overCap.error === 'capacity_exceeded', 'квота сверх capacity отвергнута');
}

// 3. измерение: только поставщик, идемпотентно по usageId, без перерасхода
{
  const foreign = await cC.consumeResource(C.addr, leaseId, 10, 'u-foreign');
  ok(foreign.ok === false && foreign.error === 'foreign_consume', 'заказчик не может фиксировать потребление');

  const u1 = await altP.consume(leaseId, 100, 'u-1');
  ok(u1.status === 200 && u1.data?.usage?.usedUnits === 100 && u1.data?.usage?.usedAtomic === 700,
    'поставщик записал 100 единиц → 700 атомарных', u1.data?.error || '');

  const u1again = await altP.consume(leaseId, 100, 'u-1');
  ok(u1again.status === 200 && u1again.data?.replay === true && u1again.data?.lease?.usedUnits === 100,
    'повтор того же измерения не списывает дважды');

  const u2 = await altP.consume(leaseId, 150, 'u-2');
  ok(u2.status === 200 && u2.data?.lease?.usedUnits === 250 && u2.data?.usage?.remainingUnits === 350,
    'второе измерение доводит до 250, остаток 350');

  const u3 = await altP.consume(leaseId, 5000, 'u-3');
  ok(u3.status === 409 && u3.data?.error === 'quota_exceeded', 'перерасход квоты отвергнут', u3.data?.error || '');
}

// 4. заказчик сам обращается к ресурсу поставщика — платформа этого не делает
{
  const direct = await fetch(providerUrl);
  const body = await direct.json();
  ok(direct.status === 200 && body.servedBy === 'provider-process' && hits === 1,
    'ресурс отдаёт процесс поставщика, а не платформа', `hits=${hits}`);
}

// 5. оплата только за измеренное, а не за квоту
{
  const accept = await cC.acceptOrder(C.addr, leaseId, 'accepted: ресурс использован');
  ok(accept.ok === true && accept.result.assignment.state === 'accepted', 'заказчик принял результат');

  const early = await cC.createSettlement(C.addr, leaseId);
  ok(early.ok === false && early.error === 'lease_open', 'до закрытия аренды расчёт не создаётся', early.error || '');

  const close = await altP.closeLease(leaseId);
  ok(close.status === 200 && close.data?.amountAtomic === 1750,
    'закрытие аренды: к оплате 250×7=1750, остаток квоты не оплачивается', String(close.data?.amountAtomic));

  await cC.faucet(C.addr, 5000);
  const st = await cC.createSettlement(C.addr, leaseId);
  ok(st.ok === true && st.result.settlement.amountAtomic === 1750,
    'расчёт выставлен по измеренному потреблению, а не по потолку 4200', String(st.result?.settlement?.amountAtomic));

  const sent = await cC.sendSettlement(C.addr, leaseId);
  const conf = await cC.confirmSettlement(C.addr, leaseId);
  const bal = await cP.testBalance(P.addr);
  ok(sent.ok === true && conf.ok === true && conf.result.settlement.state === 'confirmed' && bal.balanceTestAtomic === 1750,
    'оплата прошла: поставщик получил 1750', `balance=${bal.balanceTestAtomic}`);

  ok(hits === 1, 'за весь цикл платформа ни разу не обратилась к endpoint поставщика', `hits=${hits}`);
}

// 6. альтернативный клиент как ЗАКАЗЧИК: SDK-поставщик + оплата без SDK
{
  const reg = await cP.registerResource(P.addr, {
    resourceId: 'storage-gb', kind: 'storage', unit: 'gb-hour', priceAtomicPerUnit: 3,
    capacity: 100, terms: 'оплата за фактические гб-часы', expiresAt: Date.now() + 3_600_000,
  });
  ok(reg.ok === true, 'SDK-поставщик зарегистрировал второй ресурс', reg.error || '');

  const altC = createAltClient({ node: stand.url, walletFile: C.w });
  const lease = await altC.lease('storage-gb', 40, { idempotencyKey: 'alt-lease' });
  const l2 = lease.data?.lease?.leaseId;
  ok(lease.status === 200 && lease.data.lease.capAtomic === 120, 'альтернативный клиент арендовал 40 единиц (потолок 120)', lease.data?.error || '');

  const foreign = await altC.consume(l2, 5, 'alt-u0');
  ok(foreign.status === 403 && foreign.data?.error === 'foreign_consume', 'альтернативный заказчик не может фиксировать потребление');

  const used = await cP.consumeResource(P.addr, l2, 25, 'p-u1');
  ok(used.ok === true && used.result.lease.usedAtomic === 75, 'SDK-поставщик зафиксировал 25 единиц → 75');

  const closed = await altC.closeLease(l2);
  ok(closed.status === 200 && closed.data.amountAtomic === 75, 'альтернативный клиент закрыл аренду на 75');

  const acc = await altC.accept(l2);
  ok(acc.status === 200 && acc.data.assignment.state === 'accepted', 'альтернативный клиент принял результат');

  await altC.faucet(1000);
  const created = await altC.createSettlement(l2);
  ok(created.status === 200 && created.data.settlement.amountAtomic === 75, 'расчёт создан альтернативным клиентом на 75');
  const sent = await altC.sendSettlement(l2);
  const conf = await altC.confirmSettlement(l2);
  const bal = await cP.testBalance(P.addr);
  ok(sent.status === 200 && conf.status === 200 && conf.data.settlement.state === 'confirmed' && bal.balanceTestAtomic === 1825,
    'альтернативный клиент провёл оплату до confirmed', `balance=${bal.balanceTestAtomic}`);

  const p2 = await cP2.consumeResource(P2.addr, l2, 1, 'p2-u1');
  ok(p2.ok === false, 'чужой поставщик не может писать в чужую аренду');
}

// 7. состояние переживает рестарт
{
  stand.close();
  stand = await createStand(tmp);
  const g = createAltClient({ node: stand.url, walletFile: P.w });
  const ord = await g.getOrder(leaseId);
  ok(ord?.assignment?.kind === 'resource' && ord?.assignment?.billing?.finalized === true && ord?.assignment?.billing?.usedAtomic === 1750,
    'после рестарта: аренда закрыта, к оплате всё те же 1750', String(ord?.assignment?.billing?.usedAtomic));
  const res = await g.getResource('cpu-sec');
  ok(res?.resource?.provider === P.addr, 'после рестарта: ресурс и его поставщик на месте');
}

console.log(`\nитог: ${pass} PASS, ${fail} FAIL`);
stand.close();
providerServer.close();
process.exit(fail ? 1 : 0);
