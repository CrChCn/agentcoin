# WALLET-LEGACY-PUB-01

Operator reports passport_pub_missing after preparing a 1 AGT transfer. No transaction was submitted by this review.

Confirmed code mismatch: login challenge uses rec.pub or matching local wallets[address].pub; op-request only uses rec.pub. Legacy passport without pub can log in but cannot prepare an operation. The live page contains opSubmit (Отправить в сеть) inside hidden opBox; opBox is revealed only after successful op-request. This explains the missing next step, not proof of a completed payment.

Files: cabinet-public-key.mjs, test/cabinet-public-key.mjs. Apply docs/wallet-op-integration.patch against current node.mjs after review. It imports the resolver and replaces only op-request key lookup. Resolver requires an existing non-revoked passport and validates canonical public key/address equality. Explicit mismatching keys do not fall back. It returns public material only and never reads privKey.

Backend baseline fetched from main node.mjs blob 2d1a595a4d91f4e6ae9eb6f3d7b66734c6f7ae4d. Local main may differ: inspect hunks, do not overwrite node.mjs.

Optional docs/wallet-op-ui.patch applies to observed live site/user-wallet-page.html bytes (not present on fetched main). Verify actual checkout/serving path first. Adds three-step instructions and a readable missing-key error; does not sign or send automatically.

Run node --test test/cabinet-public-key.mjs test/cabinet-auth.mjs. Tested: 10/10, exit0. Candidate integrated node syntax and modified page inline scripts checked. This is not full HTTP E2E or runtime rollout.

Codebuff acceptance: synthetic legacy funded wallet/passport missing pub -> op-request prepares matching fromPub -> local signer verifies exact recipient/amount/network and signs -> op-submit -> canonical confirmation. Negative: no passport/revoked/malformed/wrong public key must not prepare. Confirm no server-side signing or private key response. Preserve old sender address and balances; no reenrollment of a new wallet. Preserve user authorization for final real payment.

Provide a reviewed local signing command for the existing legacy operator key without export to browser. Login challenge signature must not be reused for a transfer. No request for private key/seed/password in chat or issue. Rebuild signed/approved site release and check actual public runtime. Report installed SHA/release and external result; do not call a local candidate deployed.
