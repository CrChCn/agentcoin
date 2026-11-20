#!/usr/bin/env node
/* Codex CLI через официальный неинтерактивный режим `codex exec`.
   Официально поддерживается: prompt из stdin, `--json` (JSONL), `resume`,
   `-C`, `--sandbox`, `--output-schema`, `--output-last-message`.
   Адаптер не доверяет модели: отсутствие структурированного ответа, невалидный
   JSON, отсутствие commit/hash и тайм-аут возвращаются как BLOCKED, а не как
   успех. Ключи в журналы не пишутся: всё сохранённое проходит через redactText. */

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { redactText, redactValue, secretPairs } from '../lib/secrets.mjs';
import { apiKeyMode, codexEnv } from '../lib/envpolicy.mjs';
import { ORCH_ROOT } from '../lib/package.mjs';
import { readToolJournal } from '../lib/agentsandbox.mjs';

export const id = 'codex-cli';
export const roles = ['implementer', 'reviewer'];
export const simulated = false;
/* Codex-worker запускается только внутри smoke-tested OS-sandbox: адаптер не
   исполняет код модели на хосте ни при каких условиях. `runCommand` для него
   не используется — команды модели идут через tool proxy внутри sandbox. */
export const requiresSandbox = true;
export const usesRunCommand = false;

export const EVIDENCE = {
  nonInteractive: 'https://developers.openai.com/codex/noninteractive',
  reference: 'https://developers.openai.com/codex/cli/reference',
  license: 'Apache-2.0 (npm package @openai/codex)',
};

/* Тайм-аут → SIGTERM → grace → принудительное убийство дерева → отказ.
   Значения можно переопределить через окружение (нужно тестам). */
export const graceMsFromEnv = () => {
  const raw = Number(process.env.ORCH_KILL_GRACE_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 5000;
};
export const reapMsFromEnv = () => {
  const raw = Number(process.env.ORCH_KILL_REAP_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 3000;
};

function findOnPath(name) {
  try {
    const out = execFileSync(process.platform === 'win32' ? 'where' : 'which', [name], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)[0] || null;
  } catch {
    return null;
  }
}

/* npm на Windows ставит .cmd-шим, который нельзя запускать с shell:false.
   Находим настоящий JS-энтрипоинт пакета и запускаем его тем же node, что и
   оркестратор: никакой shell-строки, никаких метасимволов. */
function jsEntrypoint(shim) {
  if (!shim) return null;
  const dir = path.dirname(shim);
  const candidates = [
    path.join(dir, '..', 'node_modules', '@openai', 'codex', 'bin', 'codex.js'),
    path.join(dir, '..', 'lib', 'node_modules', '@openai', 'codex', 'bin', 'codex.js'),
    path.join(dir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js'),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

/* В тестовом процессе настоящий агент не запускается ни при каких условиях:
   ни при наличии Codex в PATH, ни при действующем входе, ни при ключе в env.
   Разрешён только объявленный тестовый двойник внутри пакета. */
export const TEST_DOUBLE = path.join(ORCH_ROOT, 'tests', 'codex-cli-double.mjs');

export function testGuard() {
  const inTest = process.env.ORCH_TEST_MODE === '1' || Boolean(process.env.NODE_TEST_CONTEXT);
  if (!inTest) return null;
  const allowDouble = process.env.ORCH_TEST_ALLOW_DOUBLE === '1';
  const raw = process.env.CODEX_BIN || 'codex';
  const isDeclaredDouble = allowDouble && path.resolve(raw) === path.resolve(TEST_DOUBLE);
  if (isDeclaredDouble) return null;
  return {
    code: 'REAL_AGENT_DISABLED_IN_TEST',
    detail: 'unit tests must never run a real agent: set CODEX_BIN to a missing path, or to tests/codex-cli-double.mjs with ORCH_TEST_ALLOW_DOUBLE=1',
  };
}

export function resolveBin() {
  const raw = process.env.CODEX_BIN || 'codex';
  if (/\.(mjs|cjs|js)$/i.test(raw)) {
    return { cmd: process.execPath, prefix: [path.resolve(raw)], source: raw };
  }
  if (process.platform === 'win32') {
    const shim = /\.(cmd|bat|exe)$/i.test(raw) ? raw : (findOnPath(raw) || raw);
    const entry = jsEntrypoint(shim);
    if (entry) return { cmd: process.execPath, prefix: [path.resolve(entry)], source: shim };
    return { cmd: shim, prefix: [], source: shim };
  }
  return { cmd: raw, prefix: [], source: raw };
}

/* Окружение CLI строится allowlist'ом, а не вычитанием из process.env:
   DATABASE_URL, SESSION_COOKIE, AUTH_HEADER и прочие имена denylist не ловил.
   HOME нужен только для чтения ChatGPT-сессии самим CLI; рабочим командам он
   не передаётся. Ключи API не передаются вообще — режим API-key заблокирован. */
export function agentEnv() {
  if (isDeclaredDouble()) return { ...process.env };
  return codexEnv();
}

/* Объявленный тестовый двойник — наш собственный код, ему нужен стенд
   (FAKE_CODEX_*), поэтому в тестовом режиме окружение не фильтруется. */
export function isDeclaredDouble() {
  const raw = process.env.CODEX_BIN || 'codex';
  return path.resolve(raw) === path.resolve(TEST_DOUBLE);
}

/* API-key режим небезопасен: ключ пришлось бы держать в окружении рабочего
   процесса, откуда его читает любой запущенный код. До credential broker — BLOCKED. */
export function apiKeyBlock() {
  if (isDeclaredDouble()) return null;
  const mode = apiKeyMode();
  if (!mode.active) return null;
  return {
    code: 'API_KEY_MODE_UNSUPPORTED',
    detail: `API-key mode is blocked (${mode.names.join(', ')}): work processes must not receive provider keys; use ChatGPT session auth behind a credential broker`,
  };
}

function runSync(args, options = {}) {
  const bin = resolveBin();
  const result = spawnSync(bin.cmd, [...bin.prefix, ...args], {
    encoding: 'utf8',
    timeout: options.timeout || 20000,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
    windowsHide: true,
    cwd: options.cwd,
    env: agentEnv(),
  });
  const pairs = secretPairs();
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: redactText((result.stdout || '').trim(), pairs),
    stderr: redactText((result.stderr || '').trim(), pairs),
    error: result.error ? redactText(String(result.error.message || result.error), pairs) : null,
  };
}

export function probe() {
  const version = runSync(['--version']);
  if (!version.ok) {
    return {
      available: false,
      programmatic: true,
      authenticated: false,
      reason: version.error || version.stderr || 'codex CLI not found',
      install: 'npm i -g @openai/codex',
      binary: resolveBin().source,
      evidence: EVIDENCE.nonInteractive,
    };
  }
  const login = runSync(['login', 'status']);
  const text = `${login.stdout}\n${login.stderr}`;
  const authenticated = /logged in|chatgpt/i.test(text) && !/not logged in/i.test(text);
  /* Ключ в env больше не считается входом: такой режим запрещён. */
  const apiKey = apiKeyMode().active;
  return {
    available: true,
    programmatic: true,
    authenticated,
    authKind: authenticated ? 'chatgpt-session' : apiKey ? 'api-key-env-blocked' : 'none',
    blocked: authenticated ? null : apiKey ? 'API_KEY_MODE_UNSUPPORTED' : null,
    version: version.stdout.split('\n')[0],
    binary: resolveBin().source,
    reason: authenticated
      ? null
      : apiKey
        ? 'API-key mode is blocked: CODEX_API_KEY/OPENAI_API_KEY must not authenticate work runs; use ChatGPT session auth behind a credential broker'
        : 'codex CLI установлен, но вход не выполнен',
    requiresHuman: authenticated ? null : apiKey ? 'credential broker (API-key mode blocked)' : 'codex login',
    evidence: EVIDENCE.nonInteractive,
  };
}

export function normalizeUsage(usage) {
  if (!usage) return null;
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const inputTokens = num(usage.input_tokens);
  const cachedInputTokens = num(usage.cached_input_tokens);
  const outputTokens = num(usage.output_tokens);
  const reasoningTokens = num(usage.reasoning_output_tokens);
  return {
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningTokens,
    totalTokens: num(usage.total_tokens) || inputTokens + outputTokens,
  };
}

function appendTranscript(file, line) {
  if (!file) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${line}\n`);
}

/* Доставка сигнала всему дереву процесса. На Windows это taskkill /T:
   codex запускает дочерние процессы, и один TerminateProcess их не убирает. */
export function signalTree(child, signal) {
  if (!child || !child.pid) return { ok: false, method: 'no-pid' };
  if (process.platform === 'win32') {
    const force = signal === 'SIGKILL';
    const args = ['/pid', String(child.pid), '/T'];
    if (force) args.push('/F');
    const result = spawnSync('taskkill', args, { stdio: 'ignore', windowsHide: true, timeout: 15000 });
    if (result.status === 0) return { ok: true, method: `taskkill /T${force ? ' /F' : ''}` };
    /* taskkill недоступен (не Windows-окружение или урезанный PATH):
       остаётся прямой TerminateProcess. Иначе отказ уходит в эскалацию. */
    if (result.error || result.status === null) {
      try {
        child.kill('SIGTERM');
        return { ok: true, method: 'SIGTERM' };
      } catch {
        /* процесс уже мог завершиться */
      }
    }
    return { ok: false, method: `taskkill /T${force ? ' /F' : ''}` };
  }
  try {
    process.kill(-child.pid, signal);
    return { ok: true, method: `${signal} process group` };
  } catch {
    try {
      child.kill(signal);
      return { ok: true, method: signal };
    } catch {
      return { ok: false, method: signal };
    }
  }
}

/* План остановки: graceful → grace → force → reap. Вынесен отдельно, чтобы
   проверять эскалацию без реального процесса. */
export function createTermination({
  child,
  graceMs = graceMsFromEnv(),
  reapMs = reapMsFromEnv(),
  sendSignal = signalTree,
  onAbandon = () => {},
  timers = { setTimeout, clearTimeout },
}) {
  let phase = 'running';
  let graceTimer = null;
  let reapTimer = null;
  const record = { requested: null, graceful: null, escalated: false, forced: null, abandoned: false };

  const handle = {
    get phase() {
      return phase;
    },
    snapshot() {
      return { ...record, phase };
    },
    request(reason) {
      if (phase !== 'running') return false;
      phase = 'terminating';
      record.requested = reason;
      record.graceful = sendSignal(child, 'SIGTERM');
      graceTimer = timers.setTimeout(() => {
        graceTimer = null;
        if (phase !== 'terminating') return;
        phase = 'killing';
        record.escalated = true;
        record.forced = sendSignal(child, 'SIGKILL');
        reapTimer = timers.setTimeout(() => {
          reapTimer = null;
          if (phase !== 'killing') return;
          phase = 'abandoned';
          record.abandoned = true;
          onAbandon();
        }, reapMs);
      }, graceMs);
      return true;
    },
    settle() {
      if (graceTimer) timers.clearTimeout(graceTimer);
      if (reapTimer) timers.clearTimeout(reapTimer);
      graceTimer = null;
      reapTimer = null;
      if (phase !== 'abandoned') phase = 'settled';
      return handle.snapshot();
    },
  };
  return handle;
}

/* Одна неинтерактивная сессия. Возвращает разобранный JSONL-поток,
   thread_id, usage и путь к сырому JSONL для доказательств. */
export function execWithEvents({
  prompt, workspace, schemaPath, outputPath, resumeId, sandbox = 'workspace-write',
  timeoutMs = 600000, signal, transcriptPath, promptPath, metaPath, launch = null,
  graceMs = graceMsFromEnv(), reapMs = reapMsFromEnv(),
}) {
  const guard = testGuard();
  const apiBlock = apiKeyBlock();
  if (guard || apiBlock) {
    return Promise.resolve({
      ok: false,
      blocked: guard || apiBlock,
      events: [],
      exitCode: null,
      timedOut: false,
      cancelled: false,
      sessionId: null,
      usage: null,
      rawUsage: null,
      lastMessage: null,
      stderr: '',
      transcriptPath: transcriptPath || null,
      argv: [],
    });
  }
  const pairs = secretPairs();
  if (promptPath) {
    fs.mkdirSync(path.dirname(promptPath), { recursive: true });
    fs.writeFileSync(promptPath, redactText(prompt, pairs));
  }
  const args = ['exec'];
  if (resumeId) args.push('resume', resumeId);
  args.push('--json', '--sandbox', sandbox, '-C', workspace);
  if (schemaPath) args.push('--output-schema', schemaPath);
  if (outputPath) args.push('--output-last-message', outputPath);
  // Сеть в песочнице выключена; запись — только в рабочее дерево агента.
  args.push('-c', 'sandbox_workspace_write.network_access=false');
  args.push('-');

  const bin = resolveBin();
  const startedAt = new Date().toISOString();
  const argv = [...bin.prefix, ...args];

  /* Единственные допустимые ветки: объявленный тестовый двойник (наш код)
     или план изоляции, построенный lib/agentsandbox.mjs. Прямой spawn Codex
     на хосте убран совсем — именно он был дефектом fix3. */
  let spawnPlan;
  if (isDeclaredDouble()) {
    spawnPlan = { ok: true, cmd: bin.cmd, args: argv, env: agentEnv(), backend: 'test-double' };
  } else if (launch && launch.ok) {
    /* agent:true — единственное место, где host node/Windows-пути заменяются
       на sandbox-адреса. Атаки harness'а проходят через wrap() без замены. */
    spawnPlan = launch.wrap(argv, { agent: true });
  } else {
    spawnPlan = {
      ok: false,
      code: 'ISOLATED_RUNNER_UNAVAILABLE',
      detail: 'codex worker has no isolation plan; refusing to spawn the agent on the host',
    };
  }
  if (!spawnPlan.ok) {
    return Promise.resolve({
      ok: false,
      blocked: { code: spawnPlan.code, detail: spawnPlan.detail },
      events: [],
      exitCode: null,
      timedOut: false,
      cancelled: false,
      sessionId: null,
      usage: null,
      rawUsage: null,
      lastMessage: null,
      stderr: '',
      transcriptPath: transcriptPath || null,
      argv: [],
      toolCalls: [],
    });
  }

  /* Broker запускается ДО Codex и обязан подтвердить готовность: без него
     инструменты модели не имеют канала исполнения, а значит и запускать
     агента незачем. */
  const brokerStart = async () => {
    if (isDeclaredDouble() || !launch || typeof launch.startBroker !== 'function') return null;
    const broker = await launch.startBroker();
    return broker.ok ? null : {
      ok: false,
      blocked: { code: broker.code || 'ISOLATED_TOOL_CHANNEL_UNAVAILABLE', detail: broker.detail || 'tool broker is not ready' },
      events: [],
      exitCode: null,
      timedOut: false,
      cancelled: false,
      sessionId: null,
      usage: null,
      rawUsage: null,
      lastMessage: null,
      stderr: '',
      transcriptPath: transcriptPath || null,
      argv: [],
      toolCalls: [],
    };
  };

  return brokerStart().then((blocked) => {
    if (blocked) return blocked;
    return new Promise((resolve) => {
    const child = spawn(spawnPlan.cmd, spawnPlan.args, {
      cwd: workspace,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
      detached: process.platform !== 'win32',
      env: spawnPlan.env,
    });
    const events = [];
    let buffer = '';
    let stderr = '';
    let timedOut = false;
    let cancelled = false;
    let finished = false;
    let terminateReason = null;
    let timer = null;
    let termination = null;

    const handleLine = (raw) => {
      const trimmed = raw.trim();
      if (!trimmed.startsWith('{')) return;
      const safe = redactText(trimmed, pairs);
      appendTranscript(transcriptPath, safe);
      try {
        events.push(JSON.parse(safe));
      } catch {
        /* повреждённая строка не считается событием */
      }
    };

    /* Последний буфер stdout обрабатывается и без завершающего \n:
       финальная запись JSONL не должна теряться. */
    const flushBuffer = () => {
      if (!buffer.length) return;
      const rest = buffer;
      buffer = '';
      handleLine(rest);
    };

    const finish = (code) => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      flushBuffer();
      const termSnapshot = termination ? termination.settle() : null;
      const threadEvent = events.filter((event) => event && event.thread_id).at(-1);
      const sessionId = (threadEvent && threadEvent.thread_id) || resumeId || null;
      const rawUsage = (events.filter((event) => event.type === 'turn.completed').at(-1) || {}).usage || null;

      let lastMessage = null;
      if (outputPath && fs.existsSync(outputPath)) {
        const raw = fs.readFileSync(outputPath, 'utf8');
        const safe = redactText(raw, pairs);
        if (safe !== raw) fs.writeFileSync(outputPath, safe);
        lastMessage = safe;
      }
      const toolCalls = launch
        ? [...(launch.brokerEntries || []), ...readToolJournal(launch.journalPath)]
          .filter((entry, index, all) => all.findIndex((item) => item && item.hash === entry.hash) === index)
        : [];
      /* Журнал уже прочитан; broker больше не нужен и не должен пережить сессию. */
      if (launch && typeof launch.stopBroker === 'function') launch.stopBroker();
      if (metaPath) {
        fs.mkdirSync(path.dirname(metaPath), { recursive: true });
        const payload = redactValue({
          adapter: id,
          argv: args,
          isolation: { backend: spawnPlan.backend || null, sandboxed: !isDeclaredDouble() },
          binary: bin.source,
          cwd: workspace,
          startedAt,
          finishedAt: new Date().toISOString(),
          exitCode: code,
          timedOut,
          cancelled,
          threadId: sessionId,
          resumeId: resumeId || null,
          rawUsage,
          termination: termSnapshot,
        }, pairs);
        fs.writeFileSync(metaPath, `${JSON.stringify(payload, null, 2)}\n`);
      }
      resolve({
        ok: code === 0 && !timedOut && !cancelled,
        exitCode: code,
        timedOut,
        cancelled,
        abandoned: Boolean(termSnapshot && termSnapshot.abandoned),
        termination: termSnapshot,
        sessionId,
        usage: normalizeUsage(rawUsage),
        rawUsage,
        events: events.map((event) => redactValue(event, pairs)),
        lastMessage,
        stderr: redactText(stderr.trim(), pairs),
        transcriptPath: transcriptPath || null,
        argv: args.map((arg) => redactText(arg, pairs)),
        toolCalls,
      });
    };

    termination = createTermination({
      child,
      graceMs,
      reapMs,
      onAbandon: () => {
        /* Процесс не умер даже после принудительного kill: промис всё равно
           завершается, иначе оркестратор зависнет. */
        if (terminateReason === 'timeout') timedOut = true;
        if (terminateReason === 'aborted') cancelled = true;
        finish(null);
      },
    });

    const onAbort = () => {
      if (finished) return;
      cancelled = true;
      terminateReason = 'aborted';
      termination.request('aborted');
    };

    timer = setTimeout(() => {
      if (finished) return;
      timedOut = true;
      terminateReason = 'timeout';
      termination.request('timeout');
    }, Math.max(1, timeoutMs));
    if (signal) signal.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) handleLine(line);
    });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.on('error', (err) => { stderr += `\n${err.message}`; });
    child.on('close', (code) => finish(code));

    try {
      child.stdin.end(prompt, 'utf8');
    } catch {
      /* закрытый stdin — не повод зависнуть */
    }
    });
  });
}

export async function run(ctx) {
  const { role, prompt, workspace, schemaPath, outputPath, resumeId, timeoutMs, signal, transcriptPath, promptPath, metaPath, launch = null, graceMs, reapMs } = ctx;
  const pairs = secretPairs();
  const guard = testGuard();
  if (guard) return { blocked: guard };
  const apiBlock = apiKeyBlock();
  if (apiBlock) return { blocked: apiBlock };
  const capability = probe();
  if (!capability.available) return { blocked: { code: 'agent_unavailable', detail: capability.reason } };
  if (!capability.authenticated) return { blocked: { code: 'agent_unauthenticated', detail: capability.requiresHuman || capability.reason } };

  const result = await execWithEvents({
    prompt, workspace, schemaPath, outputPath, resumeId, timeoutMs, signal, transcriptPath, promptPath, metaPath, launch, graceMs, reapMs,
  });
  if (result.blocked) return { blocked: result.blocked };
  if (result.timedOut) {
    const how = result.termination && result.termination.escalated ? 'after SIGTERM grace period, process tree was force-killed' : 'process tree was terminated';
    return { blocked: { code: 'agent_timeout', detail: `codex exec exceeded ${timeoutMs} ms; ${how}` } };
  }
  if (result.cancelled) return { blocked: { code: 'agent_cancelled', detail: 'codex exec cancelled by orchestrator' } };
  if (!result.ok) {
    return { blocked: { code: 'agent_failed', detail: redactText((result.stderr || `exit ${result.exitCode}`).slice(0, 1500), pairs) } };
  }
  if (!result.lastMessage) {
    return { blocked: { code: 'agent_contract_invalid', detail: 'codex produced no --output-last-message' } };
  }

  let parsed = null;
  try {
    parsed = JSON.parse(result.lastMessage);
  } catch (err) {
    return { blocked: { code: 'agent_contract_invalid', detail: `structured output is not valid JSON: ${err.message}` } };
  }
  if (role === 'implementer' && !/^[a-f0-9]{40}$/.test(String(parsed.resultCommit || ''))) {
    return { blocked: { code: 'agent_contract_missing_commit', detail: 'structured output has no valid resultCommit' } };
  }
  if (role === 'reviewer' && !/^[a-f0-9]{64}$/.test(String(parsed.artifactSha256 || ''))) {
    return { blocked: { code: 'agent_contract_missing_artifact_hash', detail: 'structured output has no valid artifactSha256' } };
  }

  const commandsRun = result.events
    .filter((e) => e.type === 'item.completed' && e.item && e.item.type === 'command_execution' && e.item.command)
    .map((e) => String(e.item.command));

  return {
    result: role === 'implementer' ? redactValue(parsed, pairs) : undefined,
    review: role === 'reviewer' ? redactValue(parsed, pairs) : undefined,
    commandsRun,
    toolCalls: result.toolCalls || [],
    session: {
      id: result.sessionId,
      usage: result.usage,
      rawUsage: result.rawUsage,
      exitCode: result.exitCode,
      transcript: result.transcriptPath,
      argv: result.argv,
    },
    transcript: result.events,
    outputPath,
  };
}

export function writePrompt(dir, name, text) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, redactText(text));
  return file;
}
