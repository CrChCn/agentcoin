=== registry-check valid ===
OK components=20 warnings=0
EXIT:0

=== selftest (29 cases: 25 preserved + 4 new) ===
PASS valid registry (expect pass, errors=0)
PASS duplicate id (expect fail, errors=15)
PASS missing dep (expect fail, errors=1)
PASS competing owner same env (expect fail, errors=1)
PASS same route different envs allowed (expect pass, errors=0)
PASS confirmed w/o evidence (expect fail, errors=2)
PASS allowed alias (expect pass, errors=0)
PASS honest unknown visible (expect pass, errors=0)
PASS root version removed (expect fail, errors=2)
PASS root sources removed (expect fail, errors=2)
PASS root chain removed (expect fail, errors=2)
PASS bad componentId rejected (expect fail, errors=2)
PASS expectedVersion object rejected (expect fail, errors=2)
PASS bad checkedAt rejected (expect fail, errors=2)
PASS node2 genesis mismatch rejected (expect fail, errors=1)
PASS node2 chainId mismatch rejected (expect fail, errors=1)
PASS evidence E99 rejected (expect fail, errors=1)
PASS actionIds nonexistent rejected (expect fail, errors=1)
PASS navIds nonexistent rejected (expect fail, errors=1)
PASS routes null entry handled (expect fail, errors=2)
PASS components null entry handled (expect fail, errors=2)
PASS nested wrong types rejected (expect fail, errors=6)
PASS evidence missing file rejected (expect fail, errors=1)
PASS confirmed external-only rejected (expect fail, errors=1)
PASS short genesis rejected (expect fail, errors=3)
PASS E04 file missing rejected (index alone insufficient) (expect fail, errors=3)
PASS nav-tree unavailable rejected (expect fail, errors=3)
PASS rename must not disable chain pin (expect fail, errors=1)
PASS invalid calendar date rejected (2026-02-30) (expect fail, errors=1)
SELFTEST OK 29/29
EXIT:0

=== negative CLI fixtures (env-aware key) ===
reg-dup EXIT:1 : ERR duplicate componentId: mainnet-node-1 (also at components[0])
reg-own EXIT:1 : ERR route owner conflict: mainnet|GET agentcoin.work /settlement claimed by site-static, web-next (same environment scope)
reg-conf EXIT:1 : ERR node-monitor: status confirmed requires non-empty verification.evidence
reg-dep EXIT:1 : ERR mainnet-node-1: dependsOn missing component ghost

=== new regression CLI (2026-11-19, exit 1 each) ===
reg-e04-missing EXIT:1 : ERR mainnet-node-1.verification.evidence[2]: evidence file for E04 missing in docs/audit-network/evidence/ (index alone insufficient)
  repro: mv docs/audit-network/evidence/E04-network-nodes.json /tmp/ + node tools/registry-check.mjs config/unified-registry.json -> FAIL 3 error(s), exit 1
reg-nav-unavailable EXIT:1 : ERR site-static.navIds[0]: nav-tree unavailable (site/tree.json missing/unreadable)
  repro: mv site/tree.json /tmp/ + navIds ["/DOES-NOT-EXIST"] -> exit 1 (with tree present: unknown navId "/DOES-NOT-EXIST", exit 1)
reg-rename EXIT:1 : ERR reserve-node-2: node requires chain object with chainId+genesis (kind=blockchain-node, id prefix ignored)
  repro: mainnet-node-2 -> reserve-node-2 + dependsOn update + delete chain -> exit 1
reg-date EXIT:1 : ERR registry.updatedAt: invalid date-time "2026-02-30T18:00Z" (expected YYYY-MM-DDTHH:MM[:SS]Z)
  repro: updatedAt 2026-02-30T18:00Z -> exit 1 (Date.parse normalization rejected by calendar check)

=== report ===
428 docs/registry-report.md (stage 2: +observe lines)

=== stage 2 (2026-11-19, docs/net-stage2.md) ===
registry-check: OK components=20 warnings=0 (observe targets validated)
SELFTEST OK 33/33 (25 этапа 1 сохранены внутри 29 + observe valid/remote-base/secret-file/bad-port)
NET SELFTEST OK 15/15 (изолированно, без production: healthy/timeout/403-404-500/HTML/pin/caps-ghost/proxy/no-ssh/partial/plan/concurrency/allowlist/common-block/bare-param/staging-scope)
repro: node test/registry-check.mjs + node test/net-collect.mjs (без prod); сбор: node tools/net-collect.mjs --registry config/unified-registry.json --out reports/stage2-<date> [--public-only]
actual: reports/stage2-2026-11-19/ (public-only с хоста без ключа: 65 наблюдений, 39 ok / 1 mismatch / 25 not_checked-ssh; DIFF.md + diff.json)
