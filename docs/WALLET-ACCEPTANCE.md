# Wallet and transaction acceptance

This document describes isolated verification, not a production deployment or an assertion that the legacy consensus is safe.

## Reproduce

Use Node.js 24 or later from the repository root:

```sh
node --test test/isolated-test-node.mjs test/wallet-transactions.mjs
node test/accept-AGIP-2.mjs
node test/accept-AGIP-3.mjs
node test/cabinet-cancel.mjs
```

Do not pass an operational node URL or port to these legacy acceptance scripts. External targets and `--army` are deliberately rejected before network access. The full legacy governance and 400-transaction soak scenarios were not part of this wallet run.

## Isolation

The tests create temporary data directories, ephemeral loopback ports, fresh synthetic wallets, fresh identity-registry keys and random administration tokens. Node source is staged from the static relative `.mjs` dependency graph plus the public BIP39 wordlist. Operator data, passports, administration files, `.git`, and optional dynamic spore code are not copied. An environment allowlist excludes inherited credentials, AGT settings, proxies and Node runtime injection options. Site synchronization and automatic peer discovery are disabled. The only manually registered peers are the two test nodes.

Every request has a timeout and disallows redirects. The legacy test supervisor has a five-minute deadline; the wallet cases have 60/30-second test deadlines. Controlled completion and ordinary termination stop the exact owned child processes and remove temporary data. Cleanup is not guaranteed after an operating-system crash, power loss or SIGKILL of the supervisor.

Synthetic funds are mined only inside these temporary networks. No production payments, external faucet calls, production signing keys or public-network transactions are involved.

## Positive two-node scenario

1. Start fresh A and B, register each other as their sole peer.
2. Mine 50 synthetic AGT to a locally generated sender and synchronize B.
3. Sign a 10 AGT transfer locally; submit it to A and observe transaction gossip in B's mempool. The public mempool presents 16-character transaction-ID prefixes, so this is not used as full-ID confirmation.
4. Broadcast the exact transaction a second time before mining.
5. Mine it on A and synchronize B. Both nodes must show sender=40, recipient=10 and exactly one full transaction-ID occurrence in block history.
6. Verify unauthenticated operator access is denied. Submit an invalid signature and verify it cannot change the recipient's balance.
7. Stop B, restart it with the same temporary data and a new synthetic administration token. Balances and full transaction history must persist.
8. Replay the already confirmed transaction: it must not be accepted anew.
9. Use the recipient's locally held key to send 3 AGT back, mine on restarted B and synchronize A. Both must show sender=43, recipient=7, with exactly one occurrence of each transfer.

The first scenario keeps its synthetic transaction keys in test-process memory. It proves node restart preserves chain-backed balances, not recovery of an accidentally deleted private key. A separate real-node test creates an encrypted local vault and uses the new wallet client end to end, as described below. Encrypted-profile backup/recovery belongs to the separate vault/SDK acceptance tests.

## Encrypted wallet against real node APIs

The additional wallet-client case creates its own encrypted profile, mines 50 synthetic AGT to it, prepares a canonical 10 AGT intent and signs offline through `signWalletTransfer`. Wrong passwords and independently pinned genesis mismatches must fail. The signed manifest and encrypted profile must not contain the password or a plaintext private key.

The default broadcast call is dry-run. Explicit broadcast records the exact transaction in `PaymentIntentJournal` before posting it to the actual temporary node. HTTP acceptance remains `submitted`. After mining and synchronization, `readWalletState` derives balance `40` and one exact full-ID history entry, while the other temporary node sees recipient balance `10`. Repeating the same broadcast reconciles to `confirmed` and does not submit another payment.

Read state is explicitly labeled `linked_rpc_snapshot_not_independent_consensus_validation`. Historical amounts involving the queried address that are smaller than one magenta or otherwise not exactly on the 1e-9 grid currently fail closed with `wallet_chain_amount`; the wallet does not round or silently discard these residuals. A nonempty legacy abbreviated mempool cannot establish a complete pending transaction snapshot, so the client refuses an automatic broadcast in that state.

## Explicit outstanding network-safety gaps

`test/wallet-transactions.mjs` includes an expected-failure TODO for the legacy block-submission endpoint. A synthetically mined block whose header has `chainId: "FOREIGN-NETWORK"` is currently accepted by `/block/submit`. The test keeps the rejection assertion and reports it as TODO; a successful process exit must not be described as passing this protection.

A separate diagnostic proves the current ordinary transaction digest does not include `chainId`: changing that field leaves `txDigest` unchanged. Wallet endpoint/genesis pinning can protect a client from accidentally selecting a different node; it does not provide cryptographic cross-network replay protection for a leaked signed legacy transaction. Repair requires an explicitly specified transaction-signing domain and coordinated consensus migration.

Neither these positive transfers nor reconciled balances prove that arbitrary invalid blocks are rejected. Historical consensus findings, checkpoint migration, reward scheduling and replay policy require their separate consensus review.

## Recorded verification

- Isolation suite: four passing checks, including exclusion of synthetic operator-token/passport sentinel files from staged source.
- Wallet suite: three passing cases and one explicitly outstanding expected-failure TODO; no unmarked failing case.
- AGIP-2: mnemonic creation/recovery/tamper checks passed on its own temporary node.
- AGIP-3: signed transfer, mining and independent Merkle/header proof checks passed on its own temporary node.
- Cabinet cancellation: sell/buy cancellation and rejection of another maker's cancellation passed; the fresh fixture now mines its own fee funds first.

These observations apply to the tested checkout. They do not establish that the same code is running on deployed nodes or that any real participant has been paid.
