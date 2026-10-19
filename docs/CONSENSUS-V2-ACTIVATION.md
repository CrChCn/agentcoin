# Consensus v2: offline proposal and activation blockers

**Status: inactive experimental candidate; not ready for network activation.**
The files `consensus-v2.mjs` and `tools/consensus-checkpoint.mjs` do not change
`core.mjs`, start a node, send transactions, rewrite history, or enable a fork.
Passing their synthetic tests does not mean production consensus is repaired.
No environment variable activates this candidate.

## What the candidate checks

`createConsensusV2(primitives, policy).validateBlock(block, prefix)` is a pure
candidate validator returning `{ ok, reason }`. Primitives are explicitly
injected from core; `treasuryPolicy(chain)` must return the applicable policy.
The policy has exactly these fields:

- `activationHeight`: a separately approved positive integer, never inferred.
- `legacyCheckpoint`: exactly `{ blockCount, contentDigest }`, with blockCount
  equal to activationHeight. Its digest commits the entire parsed legacy prefix.
- `allowPartialEscrowSettlements`: an explicit boolean protocol decision.

Future blocks use version 2, exact scheduled coinbase, content-bound canonical
transaction IDs, signature/escrow/treasury checks, sequential decimal accounting,
and transaction ID and sender nonce replay checks. Every future prefix block is
revalidated. The candidate cannot be substituted into the legacy miner without
also updating producers, signed-data rules, and fork coordination.

## Prepare evidence offline

Make a stable snapshot copy while the node is paused or from an atomic backup.
Keep the original unchanged. Run the following from the repository, replacing
both placeholders with an actual file and a genesis hash obtained through a
separately trusted channel:

```sh
node tools/consensus-checkpoint.mjs --snapshot /absolute/path/chain.json --trusted-genesis TRUSTED_GENESIS_HEX64
```

The input must be a regular non-symlink file, between 1 byte and 128 MiB. It may
contain `chain` or `blocks`, never both. Optional `blockCount` and `height` mean
number of blocks and must equal the array length; `tipHeight` is length minus one.
The tool checks contiguous heights, header links, header hash recomputation and
chain ID. Legacy non-hex merkle strings such as `coinbase-...` are retained
without pretending they commit full transaction contents. It rejects replacement/change detected while opening/reading the file.
It has no output-file argument and writes only a JSON proposal to stdout.
It never fetches the network or reads a wallet.

Output includes `enabled: false`, `activationHeight: null`, explicit `blockCount`,
`sourceSHA256` over exact source bytes, and `contentDigest` over the full canonical
parsed prefix. This is an evidence proposal, **not an accepted network policy**.
Do not copy it directly into the validator policy: activation remains unset until
operators separately reconcile the history and agree to an activation boundary.

A trusted genesis header hash does not prove authentic historical transaction
contents. Existing legacy transaction IDs do not adequately bind every field.
Changing a coinbase recipient while preserving legacy headers changes the
proposal's full-content digest, but the tool cannot identify which snapshot is
correct without an independently trusted full-content reference. Compare source
hashes, content digests, complete balances and anomalies across independently
controlled archive copies. A tip/header hash alone is insufficient.

## Blocking protocol decisions

1. **Reward precision and eventual zero reward.** New amounts must align to
   1e-9 AGT. Existing `blockReward(2310000)` is `0.0244140625`, which is off-grid.
   The candidate deliberately rejects it rather than silently rounding. It also
   rejects zero-value coinbase. Before activation, approve an integer-unit reward
   schedule, supply accounting and zero-reward/fees behavior for all future
   heights, with explicit compatibility and economic review. The current policy
   cannot safely operate indefinitely.
2. **Time bounds.** The candidate requires each timestamp to exceed the previous
   timestamp, but permits arbitrarily far-future safe integers. In particular,
   Number.MAX_SAFE_INTEGER can be accepted and leaves no greater valid safe
   timestamp for the next block, permanently stalling this candidate's chain. A coordinated,
   deterministic timestamp/drift policy, peer-clock assumptions and tests remain
   unresolved. There is no hidden local `Date.now()` check.
3. **Escrow settlement semantics.** Terminal mode rejects any second settlement
   and any new credit to a settled escrow ID, including a same-block redeposit.
   Use a new contract ID instead. Partial mode rejects repeated identical
   economic authorizations, independent of signature/PEM encoding. Legacy receipts
   sign amount, not settlement nonce or chain ID: flexible repeated equal-value
   partial payments require a new signed settlement nonce and domain. Review
   remaining escrow balances and refunds before choosing either mode.
4. **Historical anomalies and trusted state.** A checkpoint authenticates the
   chosen full history without repairing it. Exact decimal BigInt accounting
   preserves tiny legacy residuals without silently rounding. Negative historical
   balances fail closed and need an explicit migration policy. Lost or malformed
   destination addresses are not reassigned by this module.
5. **Production integration and safety.** New transaction IDs include signatures
   and proofs, unlike legacy IDs. Producers, mempool, block assembly, RPC,
   peer sync, wallet/SDK, escrow, treasury and restart/reorg paths need compatible
   implementation and independent review. Per-transaction safe magenta units
   currently cap one payment at Number.MAX_SAFE_INTEGER units; this is another
   explicit proposed rule, not an existing-network guarantee. Resource limits
   for block/transaction serialization and prefix replay also need review.

## Coordinated activation procedure after blockers are resolved

1. Approve a versioned protocol specification and deterministic test vectors.
   Resolve every blocker above; do not infer approval from this document.
2. Rehearse migration, backup restoration, restart, reorg, partition and mixed
   versions in an isolated network with synthetic funds. Have independent
   reviewers verify both valid acceptance and invalid rejection.
3. At a separately agreed boundary, coordinate a mining pause. Save immutable
   backups from independently controlled operators. Reconcile exact full-content
   checkpoints and balances; investigate discrepancies before continuing.
4. Publish the selected checkpoint and explicit activation height with operator
   adoption records and the new binary/source hashes. Multiple processes on one
   computer are not independent operators or independent checkpoint evidence.
5. Upgrade consenting nodes and producers together; refuse old-rule extensions
   after the agreed boundary. Confirm matching content, state and consensus rules
   before resuming mining. Monitor independently from outside the hosting machine.
6. Retain a documented pre-activation recovery plan. Once new-rule blocks have
   economic activity, do not silently downgrade, rewrite or replay payments.

Until this procedure and all blockers are completed, retain the disabled proposal
and report production consensus defects as open. No payment, repair of historical
balances or change of ownership is authorized by generating a checkpoint.
