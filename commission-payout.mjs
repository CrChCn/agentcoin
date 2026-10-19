#!/usr/bin/env node
// Legacy batch payouts are disabled: rerunning used fresh nonces and could pay twice.
// Intentionally no wallet imports, reads, signing or network access.
console.error('commission-payout: implicit payouts disabled. Use tools/payment-intents.mjs plan/prepare/reconcile/submit; explicit --broadcast is required. See docs/PAYMENT-INTENTS.md.');
process.exitCode = 1;
