# Чек-лист: бэкап/восстановление Passport-артефактов

Оффлайн-зашифрованный бэкап passport-артефактов (решение оператора 2026-10-20),
пока Passport-Drive (LaCie, D:) физически не смонтирован в системе.

## Что хранится (состав `pack`, фиксированный white-list)

| файл | что это | секрет? |
|---|---|---|
| `data/identity/identity-issuer.json` | живой издатель паспортов (ed25519, fp `sha256:ef653a51…`) | ДА |
| `data/identity/identity-issuer.rotated-1792451118765.json` | предыдущий издатель (forensic) | ДА |
| `data/identity/identity-issuer.backup-20261019.json` | ещё более старый издатель (forensic) | ДА |
| `data/identity/agent-identities.json` (+ backup до сброса) | реестр паспортов | паспортные данные |
| `data-agtx/trusted-issuers.json` | публичные пины реплик | нет |
| `data-agtx/passport.json` | паспорт платформы | паспортные данные |
| `data-agtx/holder-wallet.json` | холдер-кошелёк | ДА |
| `docs/KEY-COMPROMISE-2026-10-19.md` | документ об общих компрометированных ключах | нет |

## Где лежит текущий архив

- `<Desktop>/agt-backup-passport-20261020-102009/passport-backup-20261020.agtbak` (AES-256-GCM, scrypt N=2^15);
- рядом — `passphrase.agt.env` (одна строка, 48 hex-символов; пароль НЕ записывался в чат);
- Требование: скопировать ОБА файла минимум на 2 офлайн-носителя и записать
  пароль в свой менеджер паролей; потом удалить файл-подсказку.

## Команды

```bash
# перечислить содержимое (проверять после копирования):
node tools/passport-backup.mjs list  <path>/passport-backup-20261020.agtbak
# пароль спросит с stdin (без эха) или возьмёт AGT_BACKUP_PASS

# восстановление (в ОТДЕЛЬНЫЙ каталог; в живые data/ запрещено тулзой):
node tools/passport-backup.mjs unpack <path>/passport-backup-20261020.agtbak C:/restore-dir
```

## Чек-лист восстановления (когда нужен)

1. **Никогда** не распаковывать в живые `data/` / `data-agtx/` поверх работающей ноды.
2. Скопировать распакованный `identity-issuer.json` в `data/identity/` ТОЛЬКО при:
   - нода остановлена (точный PID kill, runbook [RESTART-9336](RESTART-9336-RUNBOOK.md) §2);
   - у файла права 0600 (`icacls file /inheritance:r /grant:r "$env:USERNAME:R"`);
   - после старта сверить `node tools/verify-node.mjs http://127.0.0.1:9335 sha256:ef653a519f71e484b1b2b84ddb45f298886f600b72f388f8881b55ac5752af9c`
     — должно быть 10 `[ok]`.
3. Если издатель восстанавливается «старый» (rotated) — это осознанная ручная операция
   компромисса: убедиться, что соответствующий pin/`identity-issuer.backup-*` обновлены
   везде вместе (host + все реплики) — otherwise ноды честно fail от `passport_issuer_not_pinned` /
   дрейф detection в watchdog/health-check.
4. При возвращении диска D: — прогнать `node tools/check-passport-drive.mjs` и
   сравнить fingerprints: диск vs распаковка; затем реплицировать unchanged-архив
   на Passport-Drive (план «двойное офлайн-хранилище»).
5. Отчёт о восстановлении: добавить строку в этот чек-лист (кто/когда/ sha256 архива).

## Ограничения

- Файлы-компромиссы `agent-identities.backup-20261019.json` содержат уже отозванные
  паспорта — исторические, не для «воскрешения» в живом реестре (реестр сброшен
  после ротации).
- `admin-token.txt`/кейсы админ-барьера в бэкап не входят — отдельное хранилище.
- D: отсутствует в системе (том «Unknown» APFS-подобный GUID) — физически
  переставить диск, драйвер или读取 на другой ОС; я (агент) никаких действий с диском не делал.
