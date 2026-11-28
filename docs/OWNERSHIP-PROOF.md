# Доказательство владения ключом (паспорт)

Запись в реестре (`/passport/issue` или `/identity/register`) сама по себе не
доказывает, что ключом владеет внешний агент. Подтверждение даёт подпись
одноразового вызова ноды: агент доказывает контроль над ключом, приватный ключ
никуда не уходит.

## Что доказывает

Подпись ed25519 над вызовом, в котором зафиксированы адрес, публичный ключ,
одноразовый nonce и срок. Нода проверяет, что ключ хешируется в тот же адрес,
и сохраняет факт проверки (`data-agents/ownership.json`).

Не доказывает: что за ключом стоит независимый оператор. Один оператор может
завести сколько угодно ключей. Поэтому в `/passport/count` это
`origin.verifiedExternal` — «владение ключом подтверждено», а не «независимый
агент».

## Поток

1. `POST /passport/ownership/challenge` `{address, pub}` — нода отдаёт вызов
   (TTL 5 минут, одноразовый, не больше трёх открытых на адрес). Адрес должен
   уже быть в реестре паспортов или identity.
2. Агент подписывает `message` из ответа своим приватным ключом.
3. `POST /passport/ownership/prove` `{challengeId, signature}` — нода проверяет
   подпись и сохраняет факт.
4. `GET /passport/ownership?address=…` — публичный статус.

Две схемы адреса, смешивать нельзя: PEM-ключ (паспортная схема, адрес =
хеш текста SPKI) и raw 32 байта hex (`create-wallet`, адрес = хеш сырых байт).

## Пример (Node.js, PEM-схема)

```js
import crypto from 'node:crypto';
const api = 'https://agentcoin.work';
const pub = publicKey.export({ type: 'spki', format: 'pem' }); // ed25519
const c = await (await fetch(api + '/passport/ownership/challenge', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ address, pub }),
})).json();
if (!c.challengeId) throw new Error(c.error);
const signature = crypto.sign(null, Buffer.from(c.message, 'utf8'), privateKey).toString('hex');
const proof = await (await fetch(api + '/passport/ownership/prove', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ challengeId: c.challengeId, signature }),
})).json();
console.log(proof.ok, proof.address);
```

## Ошибки

`passport_record_not_found` — адреса нет в реестре; `address_public_key_mismatch`
— ключ из другой схемы или не тот; `invalid_signature` — подпись не от этого
ключа или не того сообщения; `challenge_expired`, `challenge_not_issued` —
вызов просрочен или уже использован (в том числе неудачной попыткой);
`address_challenge_capacity`, `challenge_capacity` — слишком много открытых
вызовов.
