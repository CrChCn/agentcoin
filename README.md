# AGENTCOIN (AGT)

Децентрализованная криптовалюта для AI-агентов. Zero-dependency (Node.js ≥ 18).

Уважение к генезису: архитектура собрана из источников на внешнем диске (`/d/BlackLegion/config/generated/genesis.json`, `/d/CryptoLab/src/genesis_test.cpp`, `/d/BlackLegion Network/blockchain_core.py`).

## Математические механизмы
- **PoW**: SHA256d(header) с difficultyBits ведущих нулей (старт 16)
- **Ретарджет** каждые 10 блоков: `diff × actual/expected`, clamp ×4/÷4
- **Halving**: `reward = 50 / 2^(height/210000)`, max supply 21 000 000 AGT
- **Кошельки**: ed25519 (real asymmetric), адрес = AGT + SHA256d(pub) + checksum
- **P2P**: longest-chain rule, валидация (hash, PoW, prevHash, merkleRoot) без доверия

## Гонец (genesiс данные)
- genesisHash: `00009dc2822369a3081e8927be53a217902427e1c817e732a5070f7cc0f99446`
- genesisNonce: `39718`
- genesisMessage: "The Times 03/Jan/2009 Chancellor on brink of second bailout for banks" (отсылка к Bitcoin)

## API ноды (default port 9335)
GET /info · GET /blocks?n= · POST /wallet/create · POST /balance · POST /tx/sign · POST /tx · POST /mine · GET /validate · POST /peer/add · GET /sync-now

## Запуск
```bash
node node.mjs 9335    # нода A
node node.mjs 9336    # нода B
# Peering:
curl -X POST localhost:9336/peer/add -d '{"peer":"http://127.0.0.1:9335"}'
curl localhost:9336/sync-now
```

## Демо-статус (проверено)
- Генезис смомминен (16 бит difficulty)
- 3 блока добыто на узле A; узел B синхронизировал 3 блока с A и валидировал
- Транзакция подписана ed25519: tamper-тест отклонён
