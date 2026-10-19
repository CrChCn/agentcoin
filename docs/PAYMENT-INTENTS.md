# Payment intents: explicit, durable, offline by default

Legacy `commission-payout.mjs` and `node-grants.mjs grant` now refuse before loading wallets, signing, or accessing the network. Their previous fresh-nonce behavior could repeat a payment when rerun. `node-grants.mjs check-ledger [--ledger PATH]` remains read-only; corrupt JSON/schema fails closed, a missing ledger is explicitly unverified, and legacy `lastPaidAt` is not chain confirmation.

## Inputs and authority

A caller must independently accept the completed work, establish the recipient's ownership, choose an authorized payer, and check historical payments for the same task. This CLI does not hire agents, establish ownership, accept work, load a wallet, or sign. A temporary helper is not automatically an independently registered paid agent.

Provide an intent JSON:

```json
{
  "taskRef": "issue:1/task:review-20261019-A",
  "sender": "AGT<40 lowercase hex characters>",
  "recipient": "AGT<40 lowercase hex characters>",
  "amount": "10",
  "evidence": {
    "accepted": true,
    "ref": "commit:<full accepted commit hash>",
    "sha256": "<64 lowercase hex characters: accepted artifact digest>"
  }
}
```

The examples contain placeholders and are not valid payable intents. `accepted:true` records the caller's decision; it is not independently proven business acceptance. Amounts are decimal strings with at most nine decimal places (1e-9 AGT), strictly positive and within safe integer minimal-unit range. No rounding is performed.

Provide a separately signed public transaction JSON with `from`, `to`, numeric `amount`, `nonce`, `ts`, `memo`, `fromPub`, `signature`, and full `txid`. Its address/public-key binding, signature, digest and intent terms must match. Never put private keys, passwords, mnemonic phrases or admin tokens in either file. The CLI rejects recognizable private material. There is no signing command.

## Commands

Replace `/PRIVATE/` with an absolute, private directory owned by the current user. Use its real path: symlink ancestors are rejected. On POSIX the journal's immediate parent must have no group/world permissions. Pin the independently verified network genesis hash; do not adopt an untrusted endpoint's advertised hash blindly.

```sh
node tools/payment-intents.mjs plan --intent intent.json --tx signed-public-tx.json
node tools/payment-intents.mjs prepare --intent intent.json --tx signed-public-tx.json --journal /PRIVATE/payments.json --genesis GENESIS_HASH
node tools/payment-intents.mjs inspect --task TASK_REF --journal /PRIVATE/payments.json --genesis GENESIS_HASH
node tools/payment-intents.mjs reconcile --task TASK_REF --observation observation.json --journal /PRIVATE/payments.json --genesis GENESIS_HASH
node tools/payment-intents.mjs submit --task TASK_REF --journal /PRIVATE/payments.json --genesis GENESIS_HASH
```

`plan` is a pure validation/identity operation and creates no journal. `prepare` stores the exact signed transaction durably. Same task plus changed terms is a conflict; it never silently generates a replacement nonce or transaction. The last command is **dry-run**, even with an origin supplied.

Only an authorized operator who has completed reconciliation can intentionally request transport:

```sh
node tools/payment-intents.mjs submit --task TASK_REF --journal /PRIVATE/payments.json --genesis GENESIS_HASH --origin https://YOUR-PUBLIC-TX-ENDPOINT --broadcast
```

Transport is a public `POST /tx`, JSON only, no cookies, token or admin headers. Origin must be bare HTTPS, or HTTP on exact loopback (`127.0.0.1`, `localhost`, `[::1]`). Redirects are rejected; timeout is eight seconds. HTTP 200/201 records `submitted`, never `confirmed`. Other status, redirect or timeout leaves submission ambiguous (`unknown`); the same transaction may already have arrived.

## Complete reconciliation

Supply the full chain from pinned genesis, plus the complete mempool, taken from a trusted independently consensus-validating source:

```json
{
  "complete": true,
  "observedAt": 1792410000000,
  "anchor": { "genesisHash": "<full hash>", "tipHash": "<full hash>", "height": 123 },
  "chain": ["<all full blocks, genesis through tip; objects, not strings>"],
  "mempool": ["<all full public transactions; objects, not strings>"]
}
```

Top-level and anchor keys are strict. `observedAt` is capture-completion Unix milliseconds, no future timestamps, at most 30 seconds old. It must be strictly after the last submit attempt. Submission rechecks age. The journal validates chain length, pinned genesis, linked header hashes and Merkle roots, exact full transaction contents on a matching txid, and sender/nonce conflicts. A confirmed record contains the full inclusion block height, block hash and txid.

A reconciliation is required **before the first broadcast too**. A missing/new local journal does not prove that work has never been paid. Retrying consumes a new complete absence observation; merely changing a timestamp or irrelevant field cannot make the same anchor/mempool snapshot fresh. Wait for a materially changed anchored snapshot and reobserve. A found mempool transaction is pending and must not be resent through this workflow.

The journal is not a fork-choice implementation, full consensus validator, or proof that an RPC reported the whole mempool. Header/Merkle linkage alone cannot repair existing consensus vulnerabilities. The caller remains responsible for a trusted source, correct consensus activation rules, independently accepted work and historical duplicate-task checks. Different journal copies/task references can bypass local idempotency; use one canonical backed-up journal and stable task references. Do not declare old payments unpaid solely because a journal was lost.

## Crash recovery and storage limits

The exact transaction and `unknown` submission state are fsynced and atomically stored **before** the transport callback. Timeout/crash recovery never invents another nonce. An exclusive lock blocks concurrent operations. A lock left after a crashed process requires manual recovery: first establish that the writer is gone, preserve files, inspect/reconcile independently, then remove only that stale lock. The tool never steals a lock automatically or overwrites corrupt state with an empty ledger.

Files are mode 0600, private directories 0700. File fsync and atomic rename are required. Directory-entry fsync is attempted; some Windows/filesystem combinations prohibit opening/syncing directories (EPERM/EISDIR/EINVAL/ENOTSUP), so power-loss directory durability depends on OS support. Other I/O errors are fatal. Windows directory ACL hardening is the operator's responsibility. Keep a secure journal backup; never delete/reset the journal to retry a payout.

Verification:

```sh
node --test test/payment-intent.mjs test/payment-cli.mjs
```

Tests use synthetic wallets, temporary private directories and mocked transport. They perform no real transfers.
