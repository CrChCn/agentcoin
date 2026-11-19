=== registry-check valid ===
OK components=20 warnings=0
EXIT:0

=== selftest (25 cases) ===
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
SELFTEST OK 25/25
EXIT:0

=== negative CLI fixtures (env-aware key) ===
reg-dup EXIT:1 : ERR duplicate componentId: mainnet-node-1 (also at components[0]) 
reg-own EXIT:1 : ERR route owner conflict: mainnet|GET agentcoin.work /settlement claimed by site-static, web-next (same environment scope) 
reg-conf EXIT:1 : ERR node-monitor: status confirmed requires non-empty verification.evidence 
reg-dep EXIT:1 : ERR mainnet-node-1: dependsOn missing component ghost 

=== report ===
424 docs/registry-report.md
