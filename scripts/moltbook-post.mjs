#!/usr/bin/env node
/* moltbook-post.mjs — публикация на Moltbook с ручной верификацией.
 *
 * Ключ берётся из MOLTBOOK_API_KEY или ~/.config/moltbook/credentials.json
 * и никогда не печатается.
 *
 *   node scripts/moltbook-post.mjs me
 *   node scripts/moltbook-post.mjs post --submolt general --title "…" --file post.md
 *   node scripts/moltbook-post.mjs verify --code <verification_code> --answer 15.00
 *
 * post не решает челлендж сам: он сохраняет его в data/moltbook-challenge-last.json
 * и печатает текст, чтобы ответ посчитал человек/агент (10 ошибок = бан).
 */
'use strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const API = 'https://www.moltbook.com/api/v1';
const argv = process.argv.slice(2);
const cmd = argv[0];
const arg = (n, d = null) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const has = (n) => argv.includes('--' + n);

function loadKey() {
  if (process.env.MOLTBOOK_API_KEY) return process.env.MOLTBOOK_API_KEY;
  const p = path.join(os.homedir(), '.config', 'moltbook', 'credentials.json');
  const j = JSON.parse(fs.readFileSync(p, 'utf8'));
  if (!j.api_key) throw new Error('в credentials.json нет api_key');
  return j.api_key;
}

const KEY = loadKey();
const root = process.cwd();
const stateFile = path.join(root, 'data', 'moltbook-ops-state.json');
const challengeFile = path.join(root, 'data', 'moltbook-challenge-last.json');

const api = async (method, p, body) => {
  const r = await fetch(API + p, {
    method,
    headers: { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const data = await r.json().catch(() => ({}));
  return { status: r.status, ok: r.ok, data };
};

function loadState() { try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return { lastPostAt: 0 }; } }
function saveState(s) { fs.mkdirSync(path.dirname(stateFile), { recursive: true }); fs.writeFileSync(stateFile, JSON.stringify(s, null, 1)); }

const cmds = {
  async me() {
    const r = await api('GET', '/agents/me');
    const a = r.data.agent || r.data;
    console.log(JSON.stringify({
      status: r.status,
      name: a.name, handle: a.handle, claimed: a.claimed ?? a.human_verified ?? null,
      karma: a.karma, posts: a.posts_count ?? a.post_count, suspended: a.suspended ?? null,
      created: a.created_at, description: String(a.description || '').slice(0, 120),
    }, null, 1));
  },

  async post() {
    const submolt = arg('submolt', 'general');
    const title = arg('title');
    const file = arg('file');
    const textArg = arg('text');
    if (!title) throw new Error('нужен --title');
    const content = file ? fs.readFileSync(file, 'utf8') : (textArg || '');
    if (!content.trim()) throw new Error('нужен --file или --text');

    const st = loadState();
    const gap = 30 * 60 * 1000;
    const since = Date.now() - (st.lastPostAt || 0);
    if (since < gap && !has('force')) {
      throw new Error(`кулдаун: ${Math.ceil((gap - since) / 60000)} мин до следующего поста (Moltbook: 1/30 мин)`);
    }

    const r = await api('POST', '/posts', { submolt_name: submolt, title, content, type: 'text' });
    console.log('POST', r.status, JSON.stringify({ success: r.data.success, message: r.data.message, id: r.data.post?.id, url: r.data.post?.url }).slice(0, 400));
    fs.mkdirSync(path.dirname(challengeFile), { recursive: true });
    fs.writeFileSync(challengeFile, JSON.stringify(r.data, null, 1));
    if (r.ok) { st.lastPostAt = Date.now(); saveState(st); }

    const v = r.data.post?.verification;
    if (v) {
      console.log('\nЧЕЛЛЕНДЖ:');
      console.log('  code  ', v.verification_code);
      console.log('  текст ', v.challenge_text);
      console.log('  истекает', v.expires_at);
      console.log('\nответить: node scripts/moltbook-post.mjs verify --code ' + v.verification_code + ' --answer <число>');
    } else {
      console.log('челленджа нет — пост опубликован сразу');
    }
  },

  async verify() {
    const code = arg('code');
    const answer = arg('answer');
    if (!code || !answer) throw new Error('нужны --code и --answer');
    const r = await api('POST', '/verify', { verification_code: code, answer: String(answer) });
    console.log('VERIFY', r.status, JSON.stringify(r.data).slice(0, 500));
  },

  async feed() {
    const r = await api('GET', '/posts?sort=new&limit=5');
    for (const p of r.data.posts || []) console.log(`${p.id} · ${p.submolt?.name || p.submolt_name} · ${p.title}`);
  },
};

const fn = cmds[cmd];
if (!fn) { console.log('команды: me | feed | post | verify'); process.exit(0); }
fn().catch((e) => { console.error('✖ ' + (e?.message || e)); process.exitCode = 1; });
