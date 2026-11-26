#!/usr/bin/env bash
# rollout-node-update.sh — штатная раскатка обновления ноды (H1, node2, node3).
# Реальная раскладка (проверено руками 2026-11-25): git на хостах НЕТ, код —
# файловая копия /opt/agentcoin-node/src, юнит agentcoin-node.service, данные
# /opt/agentcoin-node/data, BIND 127.0.0.1, ADMIN local, снаружи Caddy-dark.
#
# Использование (выполнять НА хосте):
#   1. локально: node --check по каждому изменённому модулю
#   2. scp node.mjs seeds.mjs ... root@<host>:/root/node-update/
#      scp scripts/rollout-node-update.sh scripts/check-module-imports.mjs root@<host>:/root/
#   3. на хосте:
#      bash /root/rollout-node-update.sh /root/node-update \
#           node.mjs=<md5-текущего> seeds.mjs=absent
#      <md5-текущего> — md5 файла на хосте (защита от наката не на ту базу),
#      absent — файла на хосте ещё нет. База обязательна для каждого файла пачки.
#   Один файл по-старому:  bash $0 /root/node.mjs.new <md5-текущего-node.mjs>
#   Откат: ROLLBACK=1 bash $0   — возвращает ВСЕ файлы последней раскатки
#          (а файлы, которых до неё не было, — удаляет).
#
#   Раскладка переопределяется env (тестовый стенд, нестандартная установка):
#     AGT_SRC (код), AGT_INSTALL_DIR, AGT_UNIT (юнит), AGT_PORT, AGT_BACKUP_DIR.
#   Скрипт управляет только указанными модулями и своим юнитом.
#
# До копирования проверяется, что относительные импорты разрешаются
# (check-module-imports.mjs): «привёз node.mjs, забыл seeds.mjs» ловится здесь,
# а не падением юнита после рестарта.
# Скрипт ничего не скачивает и не меняет кроме перечисленных модулей.
# Секретов не печатает: в local-режиме админ — только loopback.
set -euo pipefail

SRC="${AGT_SRC:-/opt/agentcoin-node/src}"
INSTALL_DIR="${AGT_INSTALL_DIR:-/opt/agentcoin-node}"
UNIT="${AGT_UNIT:-agentcoin-node}"
PORT="${AGT_PORT:-9335}"
BACKUP_DIR="${AGT_BACKUP_DIR:-/root}"
HERE="$(cd "$(dirname "$0")" && pwd)"
CHECKER="${HERE}/check-module-imports.mjs"

die() { echo "✗ ОШИБКА: $*" >&2; exit 1; }

pick_node() {
  for c in "${INSTALL_DIR}"/runtime/*/bin/node /opt/agentcoin-staging/runtime/*/bin/node /usr/bin/node /usr/local/bin/node; do
    [ -x "$c" ] && { echo "$c"; return 0; }
  done
  return 1
}

# restart_unit — restart + проверка, что MainPID действительно сменился:
# иначе /life может ответить старый процесс, и успех будет ложным
restart_unit() {
  local before after
  before="$(systemctl show -p MainPID --value "$UNIT" 2>/dev/null || echo 0)"
  systemctl restart "$UNIT"
  for _ in $(seq 1 10); do
    after="$(systemctl show -p MainPID --value "$UNIT" 2>/dev/null || echo 0)"
    if [ "$after" != "$before" ] && [ "$after" != "0" ]; then return 0; fi
    sleep 1
  done
  return 1
}

wait_alive() {
  for _ in $(seq 1 45); do
    if curl -fsS -m 5 "http://127.0.0.1:${PORT}/life" 2>/dev/null | grep -q '"chainValid": *true'; then
      return 0
    fi
    sleep 2
  done
  return 1
}

# node уже обязателен скрипту — им и разбираем /life, без зависимости от python3
report_life() {
  curl -fsS -m 10 "http://127.0.0.1:${PORT}/life" 2>/dev/null | "$NODE_BIN" -e '
    let s = "";
    process.stdin.on("data", d => { s += d; }).on("end", () => {
      const d = JSON.parse(s);
      console.log("blocks:", d.blocks, "| tip:", String(d.tipHash).slice(0, 16), "| age:", d.tipAgeSec, "| fresh:", d.fresh, "| valid:", d.chainValid);
    });'
}

if [ "${ROLLBACK:-0}" = "1" ]; then
  echo "[rollback] цель: ${SRC} (юнит ${UNIT}, порт ${PORT}, бэкапы ${BACKUP_DIR})"
  echo "[rollback] ищу манифест/бэкапы последней раскатки"
  # shellcheck disable=SC2012
  LAST_MANIFEST="$(ls -1t "${SRC}"/.rollout-*.manifest 2>/dev/null | head -1)" || true
  if [ -n "${LAST_MANIFEST:-}" ]; then
    STAMP="${LAST_MANIFEST##*.rollout-}"; STAMP="${STAMP%.manifest}"
  else
    LAST="$(ls -1t "${SRC}"/*.bak-* 2>/dev/null | head -1)" || true
    [ -n "${LAST:-}" ] || die "ни манифеста, ни бэкапов *.bak-* — откат невозможен"
    STAMP="${LAST##*.bak-}"
  fi
  echo "[rollback] штамп ${STAMP}"
  RESTORED=()
  if [ -n "${LAST_MANIFEST:-}" ]; then
    while read -r state name want_md5; do
      [ -n "${name:-}" ] || continue
      if [ "$state" = "new" ]; then
        rm -f "${SRC}/${name}"
        echo "  убрал новый ${name}"
        continue
      fi
      BAK="${SRC}/${name}.bak-${STAMP}"
      [ -f "$BAK" ] || die "нет бэкапа ${BAK} — откат невозможен"
      if [ -n "${want_md5:-}" ]; then
        got="$(md5sum "$BAK" | cut -d' ' -f1)"
        [ "$got" = "$want_md5" ] || die "бэкап ${BAK} повреждён (${got} != ${want_md5}) — откат остановлен, нода не тронута"
      fi
      cp "$BAK" "${SRC}/${name}"
      RESTORED+=("$name")
      echo "  вернул ${name}"
    done < "$LAST_MANIFEST"
  else
    for b in "${SRC}"/*.bak-"${STAMP}"; do
      [ -f "$b" ] || continue
      target="${b%.bak-${STAMP}}"
      cp "$b" "$target"
      echo "  вернул $(basename "$target")"
    done
  fi
  NODE_BIN="$(pick_node)" || die "node runtime не найден"
  for n in ${RESTORED[@]+"${RESTORED[@]}"} node.mjs; do
    [ -f "${SRC}/${n}" ] || continue
    "$NODE_BIN" --check "${SRC}/${n}" || die "node --check после отката провален: ${n}"
  done
  "$NODE_BIN" "$CHECKER" "$SRC" "$SRC" || die "после отката импорты не разрешаются — нода не перезапущена"
  restart_unit || die "юнит ${UNIT} не перезапустился (MainPID не сменился) — смотри systemctl status ${UNIT}"
  wait_alive || die "нода не ожила за 90с после отката — journalctl -u ${UNIT} -f"
  report_life || die "нода не отвечает на /life после отката"
  echo "ОТКАТ ГОТОВ"
  exit 0
fi

TARGET="${1:-}"
[ -n "$TARGET" ] || die "usage: bash $0 <staging-dir> <file>=<md5|absent> [...]  (или ROLLBACK=1 $0)"
shift
[ "$#" -gt 0 ] || die "нужна база: <file>=<md5-текущего|absent> (для каждого файла пачки)"
[ -f "$CHECKER" ] || die "рядом нет check-module-imports.mjs — scp scripts/check-module-imports.mjs в ${HERE}"

STAGE=""
if [ -d "$TARGET" ]; then
  STAGE="$TARGET"
else
  [ -f "$TARGET" ] || die "нет ни каталога, ни файла: $TARGET"
  STAGE="$(mktemp -d /tmp/agt-rollout-XXXXXX)"
  trap 'rm -rf "$STAGE"' EXIT
  cp "$TARGET" "${STAGE}/node.mjs"
fi

declare -A EXPECT=()
declare -a FILES=()
if [ "$#" -eq 1 ] && [[ "$1" != *=* ]]; then
  # старый вид: один файл, считаем его node.mjs
  [ -f "${STAGE}/node.mjs" ] || die "одиночный файл должен быть node.mjs"
  EXPECT[node.mjs]="$1"; FILES+=("node.mjs")
else
  for e in "$@"; do
    [[ "$e" == *=* ]] || die "формат базы: <file>=<md5|absent> (получено: $e)"
    name="${e%%=*}"; base="${e#*=}"
    [ -f "${STAGE}/${name}" ] || die "в ${STAGE} нет ${name}"
    [ -z "${EXPECT[$name]:-}" ] || die "база для ${name} задана дважды"
    EXPECT[$name]="$base"; FILES+=("$name")
  done
fi
for f in "${STAGE}"/*; do
  n="$(basename "$f")"
  [ -f "$f" ] && [[ "$n" == *.mjs ]] || die "в ${STAGE} лишнее: ${n} — пачка состоит только из *.mjs"
  [ -n "${EXPECT[$n]:-}" ] || die "не задана база для ${n} — добавь ${n}=<md5|absent>"
done
[ "${#FILES[@]}" -gt 0 ] || die "пачка пуста"
if [ -n "${EXPECT[node.mjs]:-}" ]; then
  grep -q "escrow/payout" "${STAGE}/node.mjs" || die "node.mjs не похож на node.mjs (нет escrow/payout) — не тот файл подсунут"
fi

NODE_BIN="$(pick_node)" || die "node runtime не найден"

echo "[1/6] база"
report_life || die "нода не отвечает на /life — катить на мёртвую ноду запрещено, сначала разберись"
for n in "${FILES[@]}"; do
  base="${EXPECT[$n]}"; cur="${SRC}/${n}"
  if [ "$base" = "absent" ]; then
    [ ! -e "$cur" ] || die "${n} на хосте уже есть, а база указана как absent — разбирайся руками"
    echo "  ${n}: на хосте нет (absent) ✓"
  else
    [ -f "$cur" ] || die "${n} на хосте нет, а база задана md5 — новый файл объявляй как ${n}=absent"
    actual="$(md5sum "$cur" | cut -d' ' -f1)"
    [ "$actual" = "$base" ] || die "${n}: на хосте ${actual} != ожидаемой ${base} — хост менялся, разбирайся руками"
    echo "  ${n}: md5 ${actual} ✓"
  fi
done

already=0
for n in "${FILES[@]}"; do
  if [ -f "${SRC}/${n}" ] && [ "$(md5sum "${SRC}/${n}" | cut -d' ' -f1)" = "$(md5sum "${STAGE}/${n}" | cut -d' ' -f1)" ]; then
    already=$((already + 1))
  fi
done
if [ "$already" -eq "${#FILES[@]}" ]; then
  echo "  все файлы уже стоят — делать нечего, выхожу без рестарта"
  exit 0
fi

echo "[2/6] импорты (до копирования: что получится после установки)"
"$NODE_BIN" "$CHECKER" "$STAGE" "$SRC"

echo "[3/6] бэкап (код + данные; tar rc=1 допустим — цепь живая, файлы меняются)"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$BACKUP_DIR"
MANIFEST="${SRC}/.rollout-${STAMP}.manifest"
: > "$MANIFEST"
for n in "${FILES[@]}"; do
  if [ -f "${SRC}/${n}" ]; then
    cp "${SRC}/${n}" "${SRC}/${n}.bak-${STAMP}"
    echo "kept ${n} $(md5sum "${SRC}/${n}.bak-${STAMP}" | cut -d' ' -f1)" >> "$MANIFEST"
    echo "  ${n}.bak-${STAMP}"
  else
    echo "new ${n}" >> "$MANIFEST"
    echo "  ${n}: нового файла на хосте не было (откат удалит)"
  fi
done
tar czf "${BACKUP_DIR}/agentcoin-update-data-${STAMP}.tgz" -C "$INSTALL_DIR" data || [ $? -eq 1 ]
chmod 600 "${BACKUP_DIR}/agentcoin-update-data-${STAMP}.tgz"

echo "[4/6] установка + node --check (гейт)"
# синтаксис проверяем ДО копирования: битый файл не должен попасть в src
for n in "${FILES[@]}"; do
  "$NODE_BIN" --check "${STAGE}/${n}" || die "node --check провален до установки: ${n} — пачка не тронута"
done
for n in "${FILES[@]}"; do
  install -m 644 "${STAGE}/${n}" "${SRC}/${n}"
  got="$(md5sum "${SRC}/${n}" | cut -d' ' -f1)"; want="$(md5sum "${STAGE}/${n}" | cut -d' ' -f1)"
  [ "$got" = "$want" ] || die "${n}: после установки md5 ${got} != ${want} — откат: ROLLBACK=1 bash $0"
  "$NODE_BIN" --check "${SRC}/${n}" || die "node --check провален: ${n} (откат: ROLLBACK=1 bash $0)"
  echo "  ${n}: JS_OK"
done

echo "[5/6] рестарт + ожидание живости (до 90с)"
restart_unit || die "юнит ${UNIT} не перезапустился (MainPID не сменился) — откат: ROLLBACK=1 bash $0"
wait_alive || die "нода не отвечает 90с — откат: ROLLBACK=1 bash $0; логи: journalctl -u ${UNIT} -f"

echo "[6/6] сверки"
report_life || die "нода не отвечает на /life после рестарта"
"$NODE_BIN" "$CHECKER" "$STAGE" "$SRC" >/dev/null || die "после установки импорты не разрешаются — откат: ROLLBACK=1 bash $0"
ERRS="$(journalctl -u "$UNIT" --since '10 min ago' --no-pager -p err 2>/dev/null | grep -v -- '-- No entries --' | tail -5 || true)"
if [ -z "$ERRS" ]; then echo "  журнал: ошибок нет"; else echo "$ERRS"; die "есть ошибки в журнале — разбирай"; fi
echo "=== ГОТОВО (пачка: ${FILES[*]}) ==="
echo "=== Tip сверь с H1 (https://agentcoin.work/life): лаг в 1-2 блока — норма gossip-синхронизации ==="
