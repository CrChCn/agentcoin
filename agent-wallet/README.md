# Pinned Agentcoin agent-wallet CLI

This directory contains the command-line wallet source and its regression tests from upstream Agentcoin commit `685091908db3e03399b66c88eca28a564fa1be59`.

From the repository root, install and verify it with:

```sh
node scripts/verify-agent-wallet-vendor.mjs
npm --prefix agent-wallet ci
npm --prefix agent-wallet test
```

The CLI uses encrypted local profiles. Keep profile files, passwords, seeds, private keys, environment files, and operation journals outside this source tree. The Empire web server does not use or receive wallet profiles.
