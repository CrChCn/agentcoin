# API-GATEWAY-01: offline prototype, not a live payment service

Operator requested development of API services payable in AGT. This delivery is
an isolated prototype core; it has no HTTP server, treasury key, paid provider,
mainnet payment verifier, exchange integration or deployment on operator nodes.
No real cost, payment, exchange rate or cloud partnership is claimed.

## Implemented contract

`ApiGatewayPilot` in api-gateway.mjs persists quotes/orders/payment bindings and
receipts in an owner-only journal with an exclusive single-process lock. Quote
binds network, genesis, recipient, service, request hash, expiry, fixed integer
AGT-denominated price and maximum fiat provider cost. Integer units are supplied
by the caller; the test convention is 1e9 units per AGT, not a newly activated
consensus rule. There is one configured fiat currency per budget.

Flow: quote -> awaiting_payment -> paid -> executing -> settled. The injected
verifier must validate a canonical confirmed payment bound to the exact invoice,
recipient, network, genesis and amount, and recheck before execution. A JSON field
verified=true supplied by a public user is NEVER a payment verifier. No such
public endpoint exists here. Reorg after execution still requires reconciliation;
this prototype does not establish irreversible settlement.

Provider receives a bounded request, an idempotency key and maxCostMinor. The
adapter MUST enforce actual provider limits and transport timeout: merely passing
a number to an arbitrary function does not cap a cloud bill. Provider adapter is
trusted code; response cost is not independent billing evidence. Prompt is not
persisted. Receipt stores result hash, not content, so a repeated settled request
returns the existing receipt without regenerating/recovering the answer.

First pilot uses a FIXED AGT service price, separate from actual fiat cost; there
is no calculated variable AGT refund on success. Provider exceptions/invalid
results become execution_unknown with refundReview, never an automatic retry or
an automatic refund. Refund verification/payout is not implemented. A crash with
executing marker recovers unknown. Budget allocations remain conservatively
reserved even for expired/failed orders until a later audited reconciliation
feature; no automatic budget release or refunds are claimed.

## Validation

node --test test/api-gateway.mjs
node --check api-gateway.mjs

7/7 regression tests: complete synthetic lifecycle/restart/idempotency; no unpaid
execution and request tampering; expiry/currency; reorg; concurrent payment reuse;
provider failure/restart; exclusive journal owner/durable budget; crash recovery.
Both verifier and provider are controlled fixtures, not a real chain/cloud test.
No real credentials or operational funds are used.

## Next deployment tasks for Codebuff

1. Review this module independently; keep offline and unexposed while consensus,
   wallet and public authentication remediation remains open. Do not use an
   unverified RPC response or client-supplied boolean to authorize cloud spending.
2. Select ONE provider/service and confirm permitted access/resale arrangements,
   data handling, allowed model and published pricing. Choose a concrete fiat
   spending cap and who finances it BEFORE enabling billable calls. No external
   spending is authorized by this prototype delivery.
3. Implement provider adapter with real timeout, bounded response, output limits,
   concurrency/resource limits, idempotency semantics and billing reconciliation.
   Credentials stay in operator secret storage, never in browser/agent prompts.
4. Build payment adapter against explicit supported protocol/network policy,
   canonical full transaction content and invoice binding. Require user signature
   from local signer. Handle partial RPC, replay, confirmations/reorg and unknown.
   Test with two disposable nodes and synthetic funds before mainnet acceptance.
5. Add authenticated typed API and cabinet UI with quote/expiry/maximum debit,
   status, receipt and refund/dispute terms. Plan reserved AGT vs submitted vs
   confirmed states explicitly. User sessions do not authorize arbitrary spends.
6. Add verified refunds/unused reservation release, durable result retrieval,
   backup/restore/fsync directory policy and crash/parallel negative tests before
   production. A stale lock must be investigated, not blindly removed on startup.
7. Pilot success criterion: real task -> earned AGT -> confirmed payment for a
   real permitted API service -> delivered result -> reconciled fiat bill/receipt,
   within explicit budget. Measure requests, failures, latency, refunds, actual
   cost/revenue and subsidy. AGT issuance alone cannot fund cloud invoices.

Return ACK, responsible implementer, PR/commit, exact tests and deployment status.
No new worker bounty or treasury transfer is assigned by this document.
