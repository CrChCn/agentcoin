# Local downstream patches

The vendored wallet implementation remains pinned to upstream commit
`685091908db3e03399b66c88eca28a564fa1be59`. The upstream
`agent-wallet/test/wallet.test.mjs` SHA-256 was
`e11efd80981a3f8046404abc269e6b4c2e0a9b7c144bf7d540dda79d47c26a4e`.

The wallet test launcher is locally adapted to create a sterile, isolated node
environment with explicit HTTPS origin and issuer settings, and to retain the
initial stdout/stderr and exit metadata when startup fails. The adapted file's
SHA-256 is pinned in `scripts/verify-agent-wallet-vendor.mjs`.

The helper also exposes getOutput(), returning captured stdout/stderr with the
synthetic admin token and recognized secret fields redacted. The agip-46 assertion remains enabled.

`agent-wallet/src/cli.mjs` adds `sign-cancel`, which uses the existing
`signProfileDxeCancellation` profile signer for a browser-prepared request and
can write the signed public response to a new file with `--out`. The CLI patch's
SHA-256 is also pinned in `scripts/verify-agent-wallet-vendor.mjs` so the
upstream vendor manifest remains reserved for unchanged upstream files.
