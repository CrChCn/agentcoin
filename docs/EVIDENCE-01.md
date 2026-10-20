# EVIDENCE-01 — passport and security accounting

Operator request 2026-10-19: audit passport provenance and attack allegations; correct evidence semantics; rate 1 AGT per accepted worker.

## Observed operational API (before rollout)

Public node returned 2203 passport records, 404 security events, 296 banned addresses. Registry export classified 277 ESCROW addresses, 18 ordinary AGT addresses and `unknown`. Ban reasons: 276 spoof_signature, 18 double_spend, 2 flood. Last 50 events concerned only ESCROW_5853572ffd2f and ESCROW_b4286d10e740, paired roughly every 20–25 minutes. Public jail summary:160 cases. These observations establish registry contents, not external identity, attack attribution or malicious intent.

No private passport registry, passport-events.log, process/task inventory or authenticated request-origin logs were available on the operator computer. Exact origin of each historical passport and caller of recurring escrow requests remains unresolved. gov-passports.mjs demonstrates local API processing, NOT initial creation of all passports. Source checkout is not proof of currently running code.

## Changes

- Read-only evidence aggregate distinguishes escrow, ordinary address and unknown. No event is independently verified as an attack under the existing evidence schema.
- Signed insufficient balance rejected as insufficient_funds without a ban. Stale mempool entries skipped without sanctions. Already banned requests rejected without new events, strikes or extending ban.
- Preserve all historical bans, event arrays and passport bytes. No bulk unban or deletion.
- Passport aggregate exposes no address, sequence, handle or credentials. Historical provenance remains unknown; self-declared proof fields are not verification. Future legacy issuance tagged local_node/ownershipVerified:false, also in issuance log. This does NOT solve legacy custodial wallet design.
- Quarantine no longer automatically creates new dossiers from unverified security labels; explicit operator intake remains. Historic cases remain; public API labels them local case records.
- UI labels passport/event records and local restrictions honestly. Generated release prepared, not installed live.

## Reproduce

node --test test/security-evidence.mjs test/passport-audit.mjs test/security-ui-evidence.mjs test/evidence-api.mjs test/core-smoke.mjs
node --check node.mjs
node --check jail.mjs
node tools/build-site-release.mjs --check

13 test-runner checks pass (includes smoke file with 4 internal checks). Real disposable HTTP node exercised passport/security/jail API and verified original passport file unchanged. No operational transactions or mutations performed.

## Workers and accounting

| Worker | Accepted scope | Amount | Status |
|---|---|---:|---|
| security_evidence_fix | core semantics + regressions | 1 AGT | accepted; payment blocked: no independent recipient/address/ownership proof |
| passport_provenance_fix | privacy-safe aggregate + regressions | 1 AGT | accepted; same blocker |
| evidence_ui_fix | truthful rendering + XSS/regression checks | 1 AGT | accepted; same blocker |

Total accepted work budget 3 AGT; broadcast 0; confirmed paid 0. These are temporary work-session subagents, not independently enrolled Agentcoin citizens. No wallets fabricated to pay ourselves. No tokens/treasury secrets available to this runtime. A future real payment requires a genuine recipient with proof-of-possession and durable payment intent; unknown results reconciled, never blindly paid twice. This budget is separate from earlier 10 AGT work or Sergey offer.

## Operator-side completion (Codebuff)

Review patch against active branch; do not overwrite concurrent CORE-P0 work. Back up and SHA-256 original passport/security/gate/event logs locally, never publish keys, seqStr or tokens. Produce redacted per-record origin investigation joining issuance times, process/task logs and authenticated request sources. Find recurring escrow submitter and fix retry/backoff; this patch prevents ledger amplification but does not stop its process. Keep historical sanctions pending individual review, without declaring all actors innocent or guilty. Install reviewed runtime/release, restart sequentially, verify APIs from public and operator sides; report commit, actual runtime/release and limits. No consensus activation/reset/clean is part of this change.
