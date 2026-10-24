#!/usr/bin/env node
import path from 'node:path';
import fs from 'node:fs';
import readline from 'node:readline';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DEFAULT_DIR, readJson, readPublicJson, writeJsonAtomic, writeJsonExclusive, withLock } from './secure-store.mjs';
import { pinNode, verifyPinnedNode, getBalance, requestJson, lookupTx, amountToUnits, nodeOrigin, preflight } from './agent-client.mjs';
import { prepareTransfer, checkTransfer, submitExact } from './wallet-service.mjs';
import { DEFAULT_PROFILE_PATH, readPublicProfile, signProfileChallenge, signProfileWalletIntent, signProfileWalletOperation, signProfileDxeCancellation } from '../../agt-skill/agent-profile.mjs';
import { txDigest } from '../../core.mjs';

const baseDir = path.resolve(process.env.AGENT_WALLET_HOME || DEFAULT_DIR);
const configFile = path.join(baseDir, 'config.json');
const journalFile = path.join(baseDir, 'operations.json');
const defaultCabinetTrustFile = path.join(path.dirname(DEFAULT_PROFILE_PATH), 'node.json');
const err = code => { throw Error(code); };
const isTxid = x => typeof x === 'string' && /^[a-f0-9]{64}$/i.test(x);
async function assertNewFile(file) { try { await fs.promises.lstat(file); err('output_file_exists'); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
async function getConfig() { const c = await readJson(configFile); await verifyPinnedNode(c); return c; }
async function secretPrompt() {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') err('hidden_password_prompt_requires_interactive_terminal');
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  rl._writeToOutput = () => {};
  process.stderr.write('Пароль профиля (ввод скрыт): ');
  return new Promise(resolve => rl.question('', value => { rl.close(); process.stderr.write('\n'); resolve(value); }));
}
async function passwordFromStdin() {
  if (process.stdin.isTTY) return secretPrompt();
  const chunks = []; let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 2048) { for (const part of chunks) part.fill(0); err('password_stdin_invalid'); }
    chunks.push(Buffer.from(chunk));
  }
  const input = Buffer.concat(chunks);
  try {
    let password = input.toString('utf8');
    if (password.endsWith('\n')) password = password.slice(0, -1);
    if (password.endsWith('\r')) password = password.slice(0, -1);
    if (!password || /[\r\n]/.test(password)) err('password_stdin_invalid');
    return password;
  } finally { input.fill(0); for (const chunk of chunks) chunk.fill(0); }
}

function plainObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function safeFailure(code, cause) { const error = Error(code); error.cause = cause; return error; }

/** Sign the complete, one-use cabinet op-request response under separately pinned local node config. */
export async function signCabinetOperation({ profilePath, request, opId, txidHex, digestHex, password, pin = null } = {}) {
  try {
    const trust = pin || await getConfig();
    if (!plainObject(request) || request.opId !== opId || !plainObject(request.payload)) err('op_sign_failed');
    const expectedNodeOrigin = nodeOrigin(trust.nodeUrl);
    let operation;
    if (typeof txidHex === 'string' && /^[a-f0-9]{64}$/.test(txidHex) && request.payload.txidHex === txidHex &&
        ['send', 'order'].includes(request.payload.kind)) {
      operation = { schema: 'agt-agent-wallet-op-v1', opId, sourceOrigin: expectedNodeOrigin, payload: request.payload };
    } else if (typeof digestHex === 'string' && /^[a-f0-9]{64}$/.test(digestHex) && request.payload.kind === 'job-claim' &&
        request.payload.digestHex === digestHex) {
      operation = { schema: 'agt-agent-wallet-op-v1', opId, sourceOrigin: expectedNodeOrigin, payload: request.payload };
    } else err('op_sign_failed');
    const signed = await signProfileWalletOperation({ profilePath: path.resolve(profilePath), password, operation,
      expectedNetwork: trust.network, expectedGenesisHash: trust.genesisHash, expectedNodeOrigin });
    return signed.signature;
  } catch (error) { throw safeFailure('op_sign_failed', error); }
}

/** Sign one AGT-IDENTITY-V1 login challenge against separately pinned local cabinet trust. */
export async function signCabinetChallenge({ profilePath, response, password, trust } = {}) {
  try {
    if (!plainObject(response) || response.ok !== true || !plainObject(response.challenge)) err('challenge_sign_failed');
    const challenge = response.challenge;
    if (response.challengeId !== challenge.challengeId || response.nonce !== challenge.message ||
        (response.ttlSec !== undefined && (!Number.isSafeInteger(response.ttlSec) || response.ttlSec < 1 || response.ttlSec > 300))) err('challenge_sign_failed');
    const profile = await readPublicProfile(path.resolve(profilePath));
    if (challenge.address !== profile.address) err('challenge_profile_mismatch');
    if (challenge.network !== profile.network) err('challenge_network_mismatch');
    if (typeof challenge.expiresAt === 'number' && challenge.expiresAt <= Date.now()) err('challenge_expired');
    if (typeof response.expiresAt === 'number' && response.expiresAt <= Date.now()) err('challenge_expired');
    if (!plainObject(trust) || trust.version !== 1 || typeof trust.network !== 'string' ||
        !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/.test(trust.network) ||
        typeof trust.audience !== 'string' || !trust.audience || trust.audience.length > 256 ||
        typeof trust.nodeIssuerFingerprint !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(trust.nodeIssuerFingerprint)) err('challenge_sign_failed');
    const signed = await signProfileChallenge({ profilePath: path.resolve(profilePath), password, challenge,
      expectedAction: 'login', expectedAudience: trust.audience,
      expectedIssuerFingerprint: trust.nodeIssuerFingerprint, expectedNetwork: trust.network });
    return signed.signature;
  } catch (error) {
    if (['challenge_profile_mismatch', 'challenge_network_mismatch', 'challenge_expired'].includes(error?.message)) throw error;
    throw Error('challenge_sign_failed');
  }
}

/** Sign one complete public /identity/challenge response for AGENTCOIN registration. */
export async function signRegisterChallenge({ profilePath, challenge, password } = {}) {
  try {
    if (!plainObject(challenge) || challenge.ok !== true || challenge.action !== 'register' ||
        challenge.network !== 'AGENTCOIN' || typeof challenge.expiresAt !== 'number' ||
        challenge.expiresAt <= Date.now()) err('sign_register_failed');
    const profile = await readPublicProfile(path.resolve(profilePath));
    if (challenge.address !== profile.address || profile.network !== 'AGENTCOIN') err('sign_register_failed');
    const signed = await signProfileChallenge({ profilePath: path.resolve(profilePath), password,
      expectedAction: 'register', expectedAudience: challenge.audience,
      expectedIssuerFingerprint: challenge.issuerFingerprint, expectedNetwork: challenge.network,
      challenge });
    return signed.signature;
  } catch { throw Error('sign_register_failed'); }
}

/** Sign and submit exactly one locally requested DXE cancellation; never retries the POST. */
export async function cancelDxeOrder({ profilePath, ref, nodeUrl, password, pin = null } = {}) {
  try {
    if (typeof ref !== 'string' || !/^[A-Za-z0-9]{8}$/.test(ref)) err('cancel_failed');
    const trust = pin || await getConfig();
    const selectedOrigin = nodeOrigin(nodeUrl);
    const trustedOrigin = nodeOrigin(trust.nodeUrl);
    if (selectedOrigin !== trustedOrigin) err('cancel_failed');
    await verifyPinnedNode(trust);
    const profile = await readPublicProfile(path.resolve(profilePath));
    if (profile.network !== trust.network) err('cancel_failed');
    const orderResponse = await requestJson(trust.nodeUrl, '/dxe/orders');
    const orders = orderResponse.status === 200 && Array.isArray(orderResponse.data?.orders) ? orderResponse.data.orders : null;
    const order = orders?.find(item => item?.ref === ref);
    if (!order || order.from !== profile.address || order.status !== 'open') err('cancel_failed');
    const balance = await getBalance(trust, profile.address);
    if (BigInt(balance.smallestUnits) < 1000000n) err('cancel_failed');
    const unsigned = { from: profile.address, fromPub: profile.pub, to: profile.address, amount: 0.001,
      nonce: Date.now() * 1000 + crypto.randomInt(1000), ts: Math.floor(Date.now() / 1000), memo: `dxe|C|${ref}` };
    const tx = { ...unsigned, txid: txDigest(unsigned) };
    const signedTx = await signProfileDxeCancellation({ profilePath: path.resolve(profilePath), password, tx,
      expectedNetwork: trust.network, expectedGenesisHash: trust.genesisHash, expectedNodeOrigin: trustedOrigin });
    const check = await preflight(trust, signedTx);
    if (check.verdict !== 'preflight_pass' || check.signature?.ok !== true || check.balance?.ok !== true ||
        check.nonce?.ok !== true || Number(check.fee?.amount) !== 0) err('cancel_failed');
    let response;
    try { response = await requestJson(trust.nodeUrl, '/tx', { method: 'POST', body: signedTx }); }
    catch (error) {
      const status = await lookupTx(trust, signedTx.txid).catch(() => null);
      return { txid: signedTx.txid, ref, status: status?.state === 'mempool' || status?.state === 'in_block' ? 'submitted' : 'status_unknown',
        networkState: status?.state || 'unavailable', diagnostic: { stage: error?.stage || 'http_request', httpStatus: error?.httpStatus ?? null } };
    }
    if ((response.status >= 400 && response.status < 500) || response.data?.accepted === false ||
        (response.status < 500 && typeof response.data?.error === 'string')) err('cancel_failed');
    if ((response.status === 200 || response.status === 201) && response.data?.accepted === true && Number.isSafeInteger(response.data.mempool))
      return { txid: signedTx.txid, ref, status: 'submitted', networkState: 'mempool' };
    const status = await lookupTx(trust, signedTx.txid).catch(() => null);
    if (status?.state === 'mempool' || status?.state === 'in_block') return { txid: signedTx.txid, ref, status: 'submitted', networkState: status.state };
    return { txid: signedTx.txid, ref, status: 'status_unknown', networkState: status?.state || 'unavailable' };
  } catch (error) { throw safeFailure('cancel_failed', error); }
}

/** Sign a browser-prepared cancellation request locally without submitting it. */
export async function signDxeCancellationRequest({ profilePath, request, password, pin = null } = {}) {
  try {
    const trust = pin || await getConfig();
    if (!plainObject(request) || Object.keys(request).sort().join('|') !== 'address|genesisHash|network|nodeUrl|ref|schema|tx' ||
        request.schema !== 'agt-dxe-cancel-request-v1' || request.network !== trust.network ||
        request.genesisHash !== trust.genesisHash || nodeOrigin(request.nodeUrl) !== nodeOrigin(trust.nodeUrl) ||
        typeof request.ref !== 'string' || !/^[A-Za-z0-9]{8}$/.test(request.ref) ||
        !/^AGT[0-9a-f]{40}$/.test(request.address || '') || !plainObject(request.tx) ||
        Object.keys(request.tx).sort().join('|') !== 'amount|from|memo|nonce|to|ts|txid') err('cancel_sign_failed');
    await verifyPinnedNode(trust);
    const profile = await readPublicProfile(path.resolve(profilePath));
    if (profile.address !== request.address || profile.network !== trust.network || request.tx.from !== request.address ||
        request.tx.to !== request.address || request.tx.memo !== `dxe|C|${request.ref}` || request.tx.amount !== 0.001 ||
        request.tx.txid !== txDigest(request.tx)) err('cancel_sign_failed');
    const tx = { ...request.tx, fromPub: profile.pub };
    const signedTx = await signProfileDxeCancellation({ profilePath: path.resolve(profilePath), password, tx,
      expectedNetwork: trust.network, expectedGenesisHash: trust.genesisHash, expectedNodeOrigin: nodeOrigin(trust.nodeUrl) });
    if (!crypto.verify(null, Buffer.from(signedTx.txid, 'hex'), signedTx.fromPub, Buffer.from(signedTx.signature, 'hex'))) err('cancel_sign_failed');
    return { schema: 'agt-dxe-cancel-response-v1', nodeUrl: nodeOrigin(trust.nodeUrl), network: trust.network,
      genesisHash: trust.genesisHash, ref: request.ref, tx: signedTx };
  } catch (error) { throw safeFailure('cancel_sign_failed', error); }
}
async function logOperation(entry) {
  await withLock(journalFile, async () => {
    let data = { version: 1, entries: [] };
    try { data = await readJson(journalFile); } catch (e) { if (e.code !== 'ENOENT') throw Error('operation_journal_corrupt'); }
    if (!data || data.version !== 1 || !Array.isArray(data.entries)) err('operation_journal_corrupt');
    data.entries.push({ at: new Date().toISOString(), ...entry });
    data.entries = data.entries.slice(-2000);
    await writeJsonAtomic(journalFile, data);
  });
}
async function main(args) {
  const [command, ...a] = args;
  if (!command || command === 'help') {
    console.log('agent-wallet commands:\n  connect <node-url> <expected-network> <expected-genesis-sha256>\n  info <chosen-profile>\n  balance <chosen-profile>\n  receive <chosen-profile>\n  request-payment <profile> <amount-AGT> <memo> --out <invoice.json>\n  prepare <profile> <recipient> <amount-AGT> [memo] --out <request.json>\n  sign <profile> <request.json> --out <signed.json>\n  sign-op <profile> <op-request.json> --op-id <opId> --txid <txidHex>|--digest <digestHex>\n  sign-challenge <profile> <challenge.json> [--trust <trusted-node.json>]\n  sign-register <profile> <challenge.json>\n  sign-cancel <profile> <cancel-request.json> [--out <signed-response.json>]\n  cancel-order <profile> --ref <ref8> --node <pinned-node-url>\n  verify <signed.json>\n  send <signed.json> --confirm "SEND <full-txid>"\n  status <full-txid>\n  history <address> <limit>\nSigning commands read the profile password from hidden TTY or stdin.');
    return;
  }
  if (command === 'connect') {
    if (a.length !== 3) err('usage_connect_node_url_expected_network_expected_genesis');
    const pin = await pinNode(a[0], a[1], a[2]);
    await withLock(configFile, () => writeJsonAtomic(configFile, pin));
    console.log(JSON.stringify({ ok: true, ...pin })); return;
  }
  if (command === 'info' || command === 'balance' || command === 'receive') {
    if (a.length !== 1) err('usage_command_chosen_profile');
    const profile = path.resolve(a[0]), publicProfile = await readPublicProfile(profile), pin = await getConfig();
    if (publicProfile.network !== pin.network) err('profile_network_mismatch');
    if (command === 'info') console.log(JSON.stringify({ address: publicProfile.address, network: publicProfile.network, publicKey: publicProfile.pub, label: publicProfile.label }));
    if (command === 'receive') console.log(JSON.stringify({ address: publicProfile.address, paymentRequest: `agentcoin:${publicProfile.address}`, note: 'URI scheme shown as a copyable request only; node has no payment-request endpoint.' }));
    if (command === 'balance') console.log(JSON.stringify(await getBalance(pin, publicProfile.address)));
    return;
  }
  if (command === 'request-payment') {
    if (a.length < 5 || a[a.length - 2] !== '--out') err('usage_request_payment_profile_amount_memo_out');
    const [profilePath, amount, ...memoParts] = a.slice(0, -2), outPath = path.resolve(a.at(-1));
    amountToUnits(amount);
    const pub = await readPublicProfile(path.resolve(profilePath)), pin = await getConfig();
    if (pub.network !== pin.network) err('profile_network_mismatch');
    const invoice = { schema: 'agentcoin.wallet.payment-request.v1', network: pin.network, genesisHash: pin.genesisHash,
      address: pub.address, amountAGT: amount, amountmGNT: amountToUnits(amount).toString(), memo: memoParts.join(' '), createdAt: Date.now() };
    if (Buffer.byteLength(invoice.memo, 'utf8') > 512 || /[\u0000-\u001f\u007f]/.test(invoice.memo)) err('invalid_memo');
    await assertNewFile(outPath); await writeJsonExclusive(outPath, invoice);
    console.log(JSON.stringify({ state: 'payment_request_created', file: outPath, address: pub.address, amountAGT: amount, amountmGNT: invoice.amountmGNT,
      note: 'Публичный запрос на оплату; он не перемещает средства и не гарантирует получение.' })); return;
  }
  if (command === 'prepare') {
    if (a.length < 5 || a[a.length - 2] !== '--out') err('usage_prepare_profile_recipient_amount_memo_out');
    const [profilePath, to, amount, ...memoParts] = a.slice(0, -2), outPath = path.resolve(a.at(-1));
    const pub = await readPublicProfile(path.resolve(profilePath)), pin = await getConfig();
    if (pub.network !== pin.network) err('profile_network_mismatch');
    const balance = await getBalance(pin, pub.address), prepared = prepareTransfer({ pin, from: pub.address, to, amount, memo: memoParts.join(' ') });
    const units = BigInt(balance.smallestUnits), spend = BigInt(prepared.display.smallestUnits);
    if (spend > units) err('insufficient_balance');
    await assertNewFile(outPath);
    const { display, fee, ...request } = prepared;
    await writeJsonExclusive(outPath, request);
    await logOperation({ state: 'prepared', txid: null, address: pub.address, to, amount, fee: '0', requestPath: outPath });
    console.log(JSON.stringify({ state: 'prepared', requestPath: outPath, network: pin.network, genesisHash: pin.genesisHash,
      from: pub.address, to, amountAGT: amount, amountmGNT: prepared.display.smallestUnits, feeAGT: fee.amount, feeNote: fee.note,
      note: 'Публичный запрос не подписан. Сверьте network/genesis, адрес, сумму и memo перед локальной подписью.' })); return;
  }
  if (command === 'sign') {
    if (a.length !== 4 || a[2] !== '--out') err('usage_sign_chosen_profile_request_out');
    const profilePath = path.resolve(a[0]), requestPath = path.resolve(a[1]), outPath = path.resolve(a[3]);
    const pin = await getConfig(), request = await readPublicJson(requestPath);
    if (request.schema !== 'agentcoin.wallet.intent.v1' || request.network !== pin.network || request.genesisHash !== pin.genesisHash) err('request_trust_pin_mismatch');
    const selected = await readPublicProfile(profilePath);
    if (request.intent?.from !== selected.address || selected.network !== pin.network) err('chosen_profile_does_not_match_request');
    await assertNewFile(outPath);
    const i = request.intent;
    process.stderr.write(`Сеть ${pin.network}; genesis ${pin.genesisHash}; от ${i.from}; получатель ${i.to}; сумма ${i.amount} AGT; memo ${JSON.stringify(i.memo)}.\n`);
    if (await new Promise(resolve => { const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: true }); rl.question('Для подписи введите SIGN и полный адрес получателя: ', answer => { rl.close(); resolve(answer); }); }) !== `SIGN ${i.to}`) err('signing_not_confirmed');
    let password = await secretPrompt();
    let signed;
    try { signed = await signProfileWalletIntent({ profilePath, password, request, expectedNetwork: pin.network, expectedGenesisHash: pin.genesisHash, expectedNodeUrl: pin.nodeUrl }); }
    finally { password = ''; }
    await writeJsonExclusive(outPath, signed);
    console.log(JSON.stringify({ state: 'signed', signedPath: outPath, from: signed.tx.from, to: signed.tx.to, amountAGT: signed.tx.amount, txid: signed.tx.txid,
      note: 'Ключ и пароль не записаны в запрос или журнал.' })); return;
  }
  if (command === 'verify') {
    if (a.length !== 1) err('usage_verify_signed_file');
    const pin = await getConfig(), signed = await readPublicJson(path.resolve(a[0])), preflight = await checkTransfer(pin, signed);
    console.log(JSON.stringify({ state: preflight.verdict === 'preflight_pass' ? 'verified' : 'rejected', txid: signed.tx.txid, from: signed.tx.from, to: signed.tx.to,
      amountAGT: signed.tx.amount, fee: preflight.fee, balance: preflight.balance, nonce: preflight.nonce, verdict: preflight.verdict })); return;
  }
  if (command === 'send') {
    if (a.length !== 3 || a[1] !== '--confirm') err('usage_send_signed_file_confirm_full_txid');
    const pin = await getConfig(), signed = await readPublicJson(path.resolve(a[0]));
    if (a[2] !== `SEND ${signed.tx?.txid}` || !isTxid(signed.tx?.txid)) err('explicit_txid_confirmation_required');
    const preflight = await checkTransfer(pin, signed);
    if (preflight.verdict !== 'preflight_pass') err(`preflight_${preflight.verdict}`);
    const result = await submitExact(pin, signed);
    try {
      await logOperation({ state: result.state, txid: result.txid, from: signed.tx.from, to: signed.tx.to, amountAGT: signed.tx.amount });
    } catch (error) {
      const code = typeof error?.code === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(error.code) ? error.code : null;
      process.stderr.write(JSON.stringify({ stage: 'journal_write', networkState: result.state,
        exception: { type: error?.name || 'Error', code } }) + '\n');
      process.exitCode = 1;
      return;
    }
    console.log(JSON.stringify(result)); return;
  }
  if (command === 'status') {
    if (a.length !== 1 || !isTxid(a[0])) err('usage_status_full_txid');
    console.log(JSON.stringify(await lookupTx(await getConfig(), a[0]))); return;
  }
  if (command === 'history') {
    if (a.length !== 2) err('usage_history_address_limit');
    const [address, limitArg] = a; if (!/^AGT[0-9a-f]{40}$/.test(address)) err('invalid_address');
    const limit = Number(limitArg);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) err('invalid_history_limit');
    const pin = await getConfig();
    const route = `/history/${address}?limit=${limit}`;
    const r = await requestJson(pin.nodeUrl, route);
    if (r.status !== 200) err('history_not_supported_by_node');
    console.log(JSON.stringify({ state: 'node_history_latest_page', pagination: 'unsupported_by_public_history_route', note: 'Публичный /history возвращает только последние записи (лимит до 100); он не имеет cursor и возвращает сокращённые txid. Это не полная подтверждённая выписка.', data: r.data })); return;
  }
  if (command === 'sign-op') {
    let password = '';
    try {
      if (a.length !== 6 || a[2] !== '--op-id' || !/^[A-Za-z0-9_-]{16,128}$/.test(a[3]) || !['--txid', '--digest'].includes(a[4])) err('op_sign_failed');
      const request = await readPublicJson(path.resolve(a[1]));
      password = await passwordFromStdin();
      const signature = await signCabinetOperation({ profilePath: path.resolve(a[0]), request, opId: a[3],
        ...(a[4] === '--txid' ? { txidHex: a[5] } : { digestHex: a[5] }), password });
      process.stdout.write(signature + '\n');
    } catch { err('op_sign_failed'); }
    finally { password = ''; }
    return;
  }
  if (command === 'sign-challenge') {
    let password = '';
    try {
      let profilePath, challengePath, trustPath;
      if (a.length === 2) [profilePath, challengePath] = a;
      else if (a.length === 4 && a[2] === '--trust') [profilePath, challengePath, , trustPath] = a;
      else err('challenge_sign_failed');
      const response = await readPublicJson(path.resolve(challengePath));
      const trust = await readJson(path.resolve(trustPath || defaultCabinetTrustFile));
      password = await passwordFromStdin();
      const signature = await signCabinetChallenge({ profilePath: path.resolve(profilePath), response, password, trust });
      process.stdout.write(signature + '\n');
    } catch (error) {
      const code = ['challenge_profile_mismatch', 'challenge_network_mismatch', 'challenge_expired'].includes(error?.message)
        ? error.message : 'challenge_sign_failed';
      err(code);
    } finally { password = ''; }
    return;
  }
  if (command === 'sign-register') {
    let password = '';
    try {
      if (a.length !== 2) err('sign_register_failed');
      const challenge = await readPublicJson(path.resolve(a[1]));
      if (!plainObject(challenge) || challenge.ok !== true || challenge.action !== 'register' ||
          challenge.network !== 'AGENTCOIN' || typeof challenge.expiresAt !== 'number' ||
          challenge.expiresAt <= Date.now()) err('sign_register_failed');
      const profile = await readPublicProfile(path.resolve(a[0]));
      if (challenge.address !== profile.address || profile.network !== 'AGENTCOIN') err('sign_register_failed');
      password = await passwordFromStdin();
      const signature = await signRegisterChallenge({ profilePath: path.resolve(a[0]), challenge, password });
      if (!/^[a-f0-9]{128}$/.test(signature)) err('sign_register_failed');
      process.stdout.write(signature + '\n');
    } catch { err('sign_register_failed'); }
    finally { password = ''; }
    return;
  }
  if (command === 'cancel-order') {
    let password = '';
    try {
      if (a.length !== 5 || a[1] !== '--ref' || a[3] !== '--node') err('cancel_failed');
      password = await passwordFromStdin();
      const result = await cancelDxeOrder({ profilePath: path.resolve(a[0]), ref: a[2], nodeUrl: a[4], password });
      process.stdout.write(JSON.stringify(result) + '\n');
    } catch { err('cancel_failed'); }
    finally { password = ''; }
    return;
  }
  if (command === 'sign-cancel') {
    let password = '';
    try {
      if (a.length !== 2 && (a.length !== 4 || a[2] !== '--out')) err('cancel_sign_failed');
      const outPath = a.length === 4 ? path.resolve(a[3]) : null;
      if (outPath) await assertNewFile(outPath);
      const request = await readPublicJson(path.resolve(a[1]));
      password = await passwordFromStdin();
      const response = await signDxeCancellationRequest({ profilePath: path.resolve(a[0]), request, password });
      if (outPath) {
        await writeJsonExclusive(outPath, response);
        process.stdout.write(JSON.stringify({ state: 'cancel_response_signed', file: outPath, address: response.tx.from, txid: response.tx.txid }) + '\n');
      } else process.stdout.write(JSON.stringify(response) + '\n');
    } catch { err('cancel_sign_failed'); }
    finally { password = ''; }
    return;
  }
  err('unknown_command');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(e => { const code = /^[a-z][a-z0-9_]{1,100}$/.test(e.message || '') ? e.message : 'agent_wallet_failed'; process.stderr.write(code + '\n'); process.exitCode = 1; });
}

export { main };
