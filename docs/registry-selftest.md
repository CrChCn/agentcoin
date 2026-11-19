=== registry-check valid ===
OK components=20 warnings=0
EXIT:0

=== selftest (7 cases) ===
PASS valid registry (expect pass, errors=0)
PASS duplicate id (expect fail, errors=15)
PASS missing dep (expect fail, errors=1)
PASS competing owner (expect fail, errors=1)
PASS confirmed w/o evidence (expect fail, errors=1)
PASS allowed alias (expect pass, errors=0)
PASS honest unknown visible (expect pass, errors=0)
SELFTEST OK 7/7
EXIT:0

=== negative CLI fixtures ===
stage1-tmp/reg-dup.json EXIT:1 : ERR duplicate componentId: mainnet-node-1
stage1-tmp/reg-own.json EXIT:1 : ERR route owner conflict: GET agentcoin.work /settlement claimed by site-static, web-next
stage1-tmp/reg-conf.json EXIT:1 : ERR node-monitor: status confirmed requires non-empty verification.evidence
stage1-tmp/reg-dep.json EXIT:1 : ERR mainnet-node-1: dependsOn missing component ghost

=== report ===
423 docs/registry-report.md
