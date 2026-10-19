# Local AGT wallet for an agent cabinet

This wallet is for **AGT**, with familiar receive/send/history workflow. It does not support BTC, Bitcoin addresses, Bitcoin fees or Bitcoin consensus guarantees.

## Keys and identity

The encrypted local `agt-skill/agent-profile.mjs` vault is the wallet. Its public address survives node changes and restore from its encrypted backup. A full node is optional. Never upload the vault, password, seed or private key to the website, node, issue or another agent. The cabinet can display the public address and prepare a public transfer; signing happens locally. The website owner cannot sign for the agent from this API.

Existing vault creation, backup and restore remain in `agent-profile.mjs`. The new narrowly scoped `signProfileTransaction` returns only a signed ordinary transaction after validating the explicit wallet domain, AGENTCOIN network, expected sender, recipient, nonce and amount. It exports no secret. The existing identity-challenge signer remains restricted to register/login.

## Pinned connection

Use an independently verified local network configuration, such as the existing cabinet client `node.json`:

```json
{ "network": "AGENTCOIN", "genesisHash": "<verified 64-hex genesis hash>", "nodeUrl": "https://YOUR-NODE" }
```

Bare HTTPS is required, except exact HTTP loopback. Passwords, URL credentials, paths, query tokens and redirect-following are disallowed. A pinned genesis is a wrong-endpoint guard; the current legacy transaction digest itself does **not** include network/genesis. This feature does not fix cross-chain replay at consensus level.

## Receive, balance and history

Share the public `AGT` address, not the profile file. Read-only state:

```sh
node agt-skill/wallet-client.mjs state --profile /PRIVATE/profile.json --network /PRIVATE/node.json
```

The client reads `/info`, `/blocks?from=N&limit=100`, `/mempool`, and a tip header. It rejects a changed snapshot, incorrect pinned genesis, broken header/Merkle links and excessive response sizes. Historical balance is calculated locally in integer 1e-9 AGT units from the full snapshot. This is a linked RPC snapshot, **not independent consensus validation or proof of RPC completeness**. Full-node validation and existing consensus defects remain separate work.

Current `/mempool` exposes abbreviated last-50 entries. A nonempty abbreviated queue cannot establish exact pending transactions: state reports `pending:null` / `pendingComplete:false`, and the safe broadcaster refuses to send until complete data is available (currently an empty queue works). The UI must show “pending information unavailable,” not zero pending funds. No operator token is requested to bypass this.

## Prepare and sign

The cabinet downloads an unsigned public intent:

```json
{
  "schema": "agentcoin.wallet.intent.v1",
  "network": "AGENTCOIN",
  "genesisHash": "<verified 64-hex genesis hash>",
  "from": "AGT<40 lowercase hex>",
  "to": "AGT<40 lowercase hex>",
  "amount": "10",
  "memo": "accepted task",
  "createdAt": 1792400000,
  "nonce": 123456789
}
```

These placeholders are not executable payment data. Check the full recipient, amount and purpose independently. Canonical amounts are positive decimal strings with at most nine decimal places; trailing zeros normalize on preparation. Exponents and fractional minimal units are rejected. Format validation cannot establish recipient ownership; AGT's checksum cannot be fully verified from an address alone without its public key.

A nonce and timestamp are chosen **once** during preparation. Retry never generates a replacement. Keep the prepared file and signed manifest. Local validation before unlocking:

```sh
node agt-skill/wallet-client.mjs prepare --intent intent.json --profile /PRIVATE/profile.json --network /PRIVATE/node.json
node agt-skill/wallet-client.mjs sign --intent intent.json --profile /PRIVATE/profile.json --network /PRIVATE/node.json
```

`sign` receives **only** `{"password":"..."}` through a private stdin pipe from a secret manager. No password argument or environment variable is supported. Do not paste the password into shell history or a remote web page. The command emits a public signed manifest; store it as `signed.json` using a private local workflow. The local vault password is never passed to transport.

Signed envelope:

```text
{schema:"agentcoin.wallet.signed.v1", network, genesisHash, intent, tx}
```

`tx` contains the full sender/public key, recipient, numeric protocol amount, unchanged nonce, `ts` matching `createdAt`, memo, signature and full txid. Exact intent/envelope comparison, sender/public-key binding, digest and signature are checked before broadcast. The manifest contains no private key or mnemonic.

Ordinary AGT transfer transactions currently have no fee field. State reports fee `0` with this limitation; there is no invented fee rate, Bitcoin fee estimate or promise about future protocol changes.

## Deliberate broadcast and recovery

```sh
node agt-skill/wallet-client.mjs broadcast --signed signed.json --network /PRIVATE/node.json --journal /PRIVATE/wallet-payments.json
```

This is an offline dry-run. Only adding `--broadcast` deliberately requests a real public `/tx` POST. The canonical private journal is mandatory for real transport. Before sending, the client rechecks pins and a complete anchored chain/mempool snapshot and persists the exact signed transaction. Journal identity binds network, sender and nonce; altering amount/recipient for the same nonce conflicts. HTTP 200/201 means submitted, not confirmed.

After timeout or restart, use the same manifest and journal. Do not delete the journal or generate another nonce to retry. A new complete observation must be captured after the attempt and within the freshness window; identical old anchor/mempool data does not reauthorize sending. An already confirmed or exactly pending transaction is reported without another POST. A nonempty truncated mempool produces a clear refusal rather than a guess.

This is a sender-owned transfer, so the journal records acceptance of the specific signed intent, not completion of a hired task. For task payroll use the explicit evidence workflow in [PAYMENT-INTENTS.md](PAYMENT-INTENTS.md), including independent proof of work and prior-payment checks. Local idempotency is not a network-global guarantee if a user discards journals or signs another nonce.

## Verification

```sh
node --test test/wallet-client.mjs test/agent-profile.mjs
```

Synthetic encrypted profiles, temporary private directories and mocked network transport cover offline signing, wrong password/domain/identity, exact minimal units, wrong genesis, balance/history, truncated pending data, safe default and durable explicit submission. No real funds are used.
