# wAGT — тестовый цикл торговли AGT (прототип моста + пул)

Только тестовые средства. Изолированная нода Agentcoin + локальная EVM
(Hardhat in-process, chainId 31337). Полный путь тестового AGT до обмена
и обратно — по транзакциям в `cycle-report.json`.

## Повтор одной командой

```sh
cd tools/wagt-cycle
npm install        # один раз: hardhat + ethers + OpenZeppelin
npm run cycle      # полный цикл, exit 0 = все сверки сошлись
```

Скрипт сам поднимает ноду Agentcoin на свежем datadir (loopback, без пиров),
печатает coinbase, делает lock → mint → swap → burn → release, проверяет
повтор депозита (в реестре релейера и в контракте) и перезапускает ноду для
сверки резерва. Артефакты: `cycle-report.json` (адреса, хеши, сверки).

## Что проверено по официальным источникам

- Каноничная тестовая EVM-сеть — **Sepolia, chainId 11155111** (Goerli
  выведена из поддержки): Ethereum Foundation, «Goerli Long Term Support
  Update» — https://blog.ethereum.org/2023/11/30/goerli-lts-update ;
  конфиг сети — https://github.com/eth-clients/sepolia/blob/main/README.md
  (там же публичные RPC, напр. `https://rpc.sepolia.ethpandaops.io`).
- DEX с официальным тестовым развёртыванием — **Uniswap на Sepolia**
  (chainId 11155111): V2 factory `0xF62c03E08ada871A0bEb309762E260a7a6a880E6`,
  V2 Router02 `0xeE567Fe1712Faf6149d80dA1E6934E354124CfE3`,
  V3 factory `0x0227628fF023bb0B980b67D528571c95c9DaC1c`,
  UniversalRouter `0x3A9D48AB9751398BbFa63ad67599Bb04e4BdF98`.
  Источники: https://developers.uniswap.org/docs/protocols/v2/deployments ,
  https://developers.uniswap.org/docs/protocols/v3/deployments/v3-ethereum-deployments .
- Механика пула повторяет **Uniswap V2**: `x*y=k`, комиссия 0.3%
  (`getAmountOut = in*997*reserveOut/(in*1000+in*997)`), первый mint
  `sqrt(a0*a1) − 1000` (минимум на нулевом адресе), burn —
  пропорциональный вывод. Источники: `UniswapV2Pair.sol`
  (https://github.com/Uniswap/v2-core/blob/master/contracts/UniswapV2Pair.sol),
  whitepaper разд. 3.3 (https://app.uniswap.org/whitepaper.pdf),
  Router02 (https://github.com/Uniswap/v2-periphery/blob/master/contracts/UniswapV2Router02.sol).

## Почему стенд локальный, а не Sepolia

Публичный тестнет требует внешнего RPC, крана SepoliaETH и ожидания
блоков — цикл становится недетерминированным и неповторяемым одной
командой. Локальный пул реализует ту же V2-математику; адреса/хеши в
отчёте — настоящие (keccak) транзакции локальной цепи.

## Что осталось проверить на выбранной площадке (Sepolia + Uniswap V2)

1. Задеплоить `WAGT.sol` на Sepolia (bridge = адрес релейера), верифицировать.
2. Выпустить тестовый контр-токен (или взять существующий), создать пару
   через официальный V2 factory `0xF62c…`, добавить ликвидность через
   официальный Router02 `0xeE56…` (нужны faucet SepoliaETH на газ).
3. Прогнать тот же сценарий lock→mint→swap→burn→release против реальных
   контрактов Uniswap; сверить `getAmountOut` пула с локальным расчётом.
4. Решить, кто контролирует резерв (vault-мультисиг/контракт) и сколько
   средств выделить на ликвидность, — по итогам этого прототипа.

## Сценарий Sepolia: обмен через официальный Uniswap V2

ТЗ: `TZ-sepolia-uniswap.md`. Отдельный скрипт, локальный цикл не тронут.

```sh
cd tools/wagt-cycle
npm install
cp .env.example .env        # вписать SEPOLIA_PRIVATE_KEY тестового кошелька
npm run cycle:sepolia       # фаза A без ключа; полный цикл с ключом
```

- Фаза A (без ключа): `chainId=11155111`, байткод по адресам Factory
  `0xF62c…` и Router02 `0xeE56…`, `Router02.factory()==Factory`, оценка
  газа (пол цены 1 gwei, запас x1.5).
- Фаза B (с ключом): деплой WAGT (bridge=deployer) + TAGT → lock 40 AGT →
  mint 40 wAGT → `addLiquidity(40/400)` через Router02 → lock 5 → mint 5 →
  `getAmountsOut` + `swapExactTokensForTokens(2 wAGT, minOut −5%)` → burn 3 →
  release 3 AGT с детерминированным nonce (повтор находится в цепи, а не
  отправляется заново). Плюс проверки: неподтверждённый депозит не
  выпускает, повтор deposit отклонён реестром и контрактом
  (`deposit_replayed`), повтор burn — ровно одна выплата, рестарт ноды —
  сверка с обеими сетями.
- Нужно газа: deployer ~0.0037 ETH + 0.005 ETH на финансирование трейдера
  (итого просить у крана **~0.01–0.02 SepoliaETH**). Краны:
  https://sepoliafaucet.com , https://www.alchemy.com/faucets/ethereum-sepolia .
  Если газа не хватает — скрипт останавливается (exit 2) с адресом
  кошелька и суммой дефицита.
- Отчёт: `cycle-report-sepolia.json` (адреса, пара, все хеши Sepolia и
  txid AGT, суммы, газ по операциям, результаты проверок повторов).

## Инварианты цикла (проверяются скриптом)

- `vault(AGT) == totalSupply(wAGT)` — полное обеспечение, до и после рестарта.
- Повтор `depositId` не выпускает токены дважды: отказ релейера (уже
  обработан) + `revert deposit_replayed` контракта.
- Баланс резерва сходится после перезапуска ноды на том же datadir.
