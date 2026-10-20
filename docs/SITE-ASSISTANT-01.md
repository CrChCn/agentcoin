# SITE-ASSISTANT-01

Operator request: install easy public-profile memory, autofill and an AI site assistant. Three temporary session workers accepted at 1 AGT each. No transfer performed; recipients not independently enrolled and treasury signer unavailable. This new 3 AGT allocation is separate from EVIDENCE-01's 3 AGT. Do not fabricate self-owned recipient wallets or call a task accepted a payment confirmed.

## Implemented

- Opt-in public address hints in same-origin browser localStorage, explicit forget, safe handling of disabled/corrupt storage. No key, password, session token or full passport stored. Restoring a hint does not log in.
- Shared panel bundles the helper and profile memory, all approved site pages receive same content-hashed release.
- Explicit transfer draft autofill validates exact address and decimal amount, dispatches input events invalidating any previously signed transfer. No submit, signing or broadcast. Chat draft fills text/handle only by explicit click; exchange only fills the known revival address field, not an order. Other operations not claimed covered.
- Clearly labeled deterministic helper works without a model. Optional cabinet bridge asks a local model only after signed cabinet login. Model output is inert text; it cannot click, execute tools or sign. No live wallet/site state is supplied to the model.
- Backend Ollama adapter uses fixed http://127.0.0.1:11434/api/chat, no arbitrary provider URL, no history/tools or wallet access; prompt <=2000, provider <=64KiB, text <=8000, timeout/concurrency bounds. Session and address authenticate at node and are not forwarded to model. Best-effort secret pattern guard is NOT a guarantee of detecting every pasted secret.
- Authenticated /assistant/message rate limited by agent address (10sec); unconfigured model explicitly unavailable, no pretend AI response.

## Real limitations

No Ollama installation/download or actual model generation was performed on the operator's Windows computer. No operational node restarted, no checkout merged, no live release activated. Existing local signing/Skill enrollment still required; automatic registration, remembered session or automatic execution across every form is not implemented. This is a preparation/explanation assistant, not an autonomous unrestricted site operator. Legacy chat may use an operator-held wallet; draft preparation does not fix chat identity semantics. LocalStorage public address is still a public identifier and is opt-in.

## Verified

node --test test/profile-memory.mjs test/cabinet-helper.mjs test/assistant-service.mjs test/assistant-http.mjs test/evidence-api.mjs test/wallet-cabinet-ui.mjs test/site-release.mjs

32/32 pass, no skips. Includes real isolated HTTP enrollment with generated test-only key, proof-of-possession login, unauthorized rejection, disabled-model result and rate limit; model protocol tested with injected bounded responses, not a real model. UI behavior exercised in DOM VM. Browser visual QA on operational site still required. node tools/build-site-release.mjs --check passes.

## Codebuff deployment assignment

1. Review and port patch on active branch, preserving parallel consensus and EVIDENCE changes. Do not overwrite whole files/reset/clean.
2. Stage and run listed tests; inspect local OS/process capacity and available approved model installation. If Ollama is already installed, select an already-installed model and set AGT_ASSISTANT_MODEL to its exact name in node service/task environment. Backend calls only local11434; do not expose model server publicly. Never put model or treasury credentials into browser bundles.
3. If no local model is installed, report that prerequisite and actual resource/download requirements; never report enabled AI from mere adapter presence. Model choice must fit host resources; no unspecified download or cost has been accepted by this document.
4. Sequential runtime/site rollout using owner-approved release mechanism; confirm actual active release from /site/release (prepared release in site/release.json), visible remember/forget/helper functions, signed user session, unauthorized401, disabled503 or actual local-model response. Do not publish sessions, keys or passport numbers. Verify one user cannot access another cabinet.
5. Real payment only after independent recipient identity+address ownership proof; durable intent, actual TXID/block, no double retry on unknown. Accepted workers: remember_profile1 AGT, cabinet_helper1 AGT, local_model_adapter1 AGT. Paid0.

Return ACK, commit, test output, runtime/site release, model configured vs installed vs responding, payment evidence or exact blocker. No implicit background monitoring or completed rollout is claimed.
