#!/usr/bin/env python3
"""Патч собранного бандла /agent (agent-center): мемпул на публичный /mempool.

Контекст: исходников SPA нет в репозитории сайта — на проде лежит только
собранный бандл. Нода не отдаёт /api/v1/mempool наружу (403 admin_loopback_only),
а plain /mempool публичен и отдаёт {size, txs}. Поэтому:
  1. endpoint map: mempool:"/api/v1/mempool" -> mempool:"/mempool"
     (fetch-запросы Caddy уже проксирует на локальную ноду)
  2. шапка SPA читала только n.count -> (n.count ?? n.size)
  3. футер: источник мемпула переименован.
Баланс (/api/v1/balance) НЕ трогаем: корректный фикс — публичный GET-эндпоинт
в node.mjs (/root/patch-agent-balance.py) + рестарт ноды, только с явного «да»
владельца. Виджет при 403 показывает 0 — это известная неточность, не чинится здесь.

Идемпотентно: повторный прогон ничего не меняет. Работает с байтами —
переводы строк и кодировка бандла не трогаются. При несовпадении якорей
падает с ошибкой, бандл не портится.
"""
import sys

REPLACEMENTS = [
    (b'mempool:"/api/v1/mempool"', b'mempool:"/mempool"'),
    (b'void 0:n.count)??', b'void 0:(n.count??n.size))??'),
    ('/api/v1/mempool · /api/v1/balance'.encode('utf-8'),
     '/mempool · /api/v1/balance'.encode('utf-8')),
]

def main(path: str) -> None:
    src = open(path, 'rb').read()
    if b'mempool:"/mempool"' in src and b'n.count??n.size' in src:
        print('ALREADY_PATCHED')
        return
    for old, new in REPLACEMENTS:
        n = src.count(old)
        assert n == 1, (old[:40], n)
        src = src.replace(old, new, 1)
    assert b'n.count??n.size' in src and b'mempool:"/mempool"' in src
    open(path, 'wb').write(src)
    print('PATCHED')

if __name__ == '__main__':
    main(sys.argv[1])
