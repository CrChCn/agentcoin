# Pinned agent-wallet source

The required CLI and regression-test files are copied verbatim from Agentcoin commit `685091908db3e03399b66c88eca28a564fa1be59` (observed branch `codebuff/agent-wallet-01`). This source revision provides `sign-op`, `sign-challenge`, `sign-register`, and `cancel-order`.

The CLI imports `../agt-skill/agent-profile.mjs`; the matching companion profile module is also copied from this source commit into the parent repository. `UPSTREAM-SHA256SUMS` pins the retained upstream files and companion module. The generated `package-lock.json` is a local reproducibility artifact because upstream `package.json` declares no dependencies and had no lockfile.

To reproduce the retained source import in a clean checkout containing the pinned commit:

```sh
git archive --format=tar 685091908db3e03399b66c88eca28a564fa1be59 agent-wallet/package.json agent-wallet/src agent-wallet/test/cancel-order.test.mjs agent-wallet/test/sign-challenge.test.mjs agent-wallet/test/sign-op.test.mjs agent-wallet/test/sign-register.test.mjs agent-wallet/test/wallet.test.mjs agt-skill/agent-profile.mjs | tar -xf - -C /path/to/clean-agentcoin-checkout
```

Then run the integrity verifier, `npm --prefix agent-wallet ci`, and `npm --prefix agent-wallet test`. Never put local profiles, `AGENT_WALLET_HOME`, configuration, or operation journals in this vendor directory.
