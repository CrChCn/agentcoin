# RUNBOOK: рестарт 9336 (Tailscale VM) с новым издателем паспортов

Состояние конфликта на 2026-10-20: издатель паспортов на основной ноде ротирован,
живой fingerprint — `sha256:ef653a519f71e484b1b2b84ddb45f298886f600b72f388f8881b55ac5752af9c`.
Удалённый доступ в VM по SSH из этой сессии закрыт (`Tailscale SSH` не включён на VM),
поэтому рестарт выполняется человеком/агентом на самой VM по этому runbook.
9336 продолжала отдавать кабинет v2 (site-sync) и синхронна по цепи, но её
`/identity/meta` всё ещё опирается на её собственный локальный издатель/пины.

## 0. Что должно быть на VM

- `git -C <repo> pull` к актуальному `main` (нужны: [run-node-ts.cmd](../run-node-ts.cmd)
  с pin `ef653a51…`, [restart-ts-node.cmd](../tools/restart-ts-node.cmd),
  [verify-node.mjs](../tools/verify-node.mjs));
- если VM держит свой висевший на main копик — после pull сверить
  `type run-node-ts.cmd | findstr AGT_PASSPORT_ISSUER_FINGERPRINT` → должен быть `sha256:ef653a51…`.

## 1. Снять состояние ДО рестарта (PID → командлайн → высота)

```bat
netstat -ano | findstr :9336 | findstr LISTENING
type data-agtx\ts-bind.txt 2>nul
curl -s http://127.0.0.1:9336/life
curl -s http://127.0.0.1:9336/identity/meta
```

Записать высоту/tip: после рестарта нода обязана вернуть те же блоки (продолжение),
не считать цепь заново.

## 2. Рестарт точным процессом

```bat
cd <repo>
tools\restart-ts-node.cmd
```

Скрипт сам: найдёт PID слушающего 9336 → `taskkill /PID` (никогда по имени
node.exe — соседей можно поранить, и никогда taskkill /IM) → дождётся
освобождения порта → стартует `run-node-ts.cmd` → ждёт прослушивания порта.
Выход 0 = порт слушает; НЕ контракт успеха — дальше шаг 3.

## 3. Верификация (обязательна)

```bat
node tools\verify-node.mjs http://127.0.0.1:9336 sha256:ef653a519f71e484b1b2b84ddb45f298886f600b72f388f8881b55ac5752af9c
```

Ожидаемо 10 строк `[ok]`, код возврата 0. Ключевые проверки:
- `issuerFingerprint == ef653a51…` (pin живой, из нового издателя);
- `issuerFingerprint == DER(issuerPub)` — fingerprint считается канонической DER-схемой,
  а НЕ sha256(PEM-текст): после ротации tool печатает именно DER, несовпадение =
  пин остались на старой схеме (это был баг ротации на hostе, правки `4371a93`);
- `passportIssuerFingerprint == issuerFingerprint` — pin реплики не отстал от issuer;
- честные негативы кабинета AGIP-45/46: `autologin` без CSRF-заголовка → 400,
  `op-request` без сессии → `session_invalid_or_foreign`;
- `site/release` → `site-v2-…` (bundle v2 подхвачен).

## 4. Обновить trusts сопутствующего каталога реплики

Если у VM есть свой `data-agtx\trusted-issuers.json` (у реплик он свой на своей
машине) — он должен содержать canonical PEM **нового** издателя (с хвостовым `\n`:

```
MCowBQYDK2VwAyEAmhuIvDvfo7V9kNcQvSEI4WLCcmX/c8EI0FuR1oUg0P4=
```

в блоке `-----BEGIN/END PUBLIC KEY-----`). У этого PEM не должно быть `.trim()` —
иначе нода на старте откажет `noncanonical_public_key` (loadIssuer нормализует,
но держим файл правильным сразу).

## 5. Наблюдать 10–15 минут (runbook общий с [ROLLOUT.md](ROLLOUT.md))

- высота растёт, tip совпадает с 9335/9341/9342 (локально: `curl -s http://127.0.0.1:9335/life`);
- `loopLag` в норме, `tips: []` (форков нет);
- 503/timeout дельта по log-node-ts.txt = 0;
- перезапусков процесса не случилось (watchdog не пинал REST в цикле).

## Мой статус (executed-from-elsewhere)

- [x] скрипты написаны, пины в репо верные, `restart-ts-node.cmd` и `verify-node.mjs`];
- [x] `verify-node.mjs` отрепетирован на живой 9335 — 10/10 ok;
- [ ] фактический рестарт на VM — недоступен из этой сессии (tcp 22 refused);
      выполняется по §2–§5 на самой VM.
