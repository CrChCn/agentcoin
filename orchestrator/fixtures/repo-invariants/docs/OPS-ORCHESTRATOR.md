# Runbook оркестратора (фикстур)

Фикстур для проверки инварианта ops-runbook-present.

```bash
./service/install.sh --dry-run
./service/install.sh --enable
```

Настоящие агенты включаются тремя гейтами: hostile-check end-to-end,
`opsd runtime` с `ok: true`, `mission.allowRealAgents=true`.
