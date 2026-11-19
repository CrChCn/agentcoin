#!/usr/bin/env node
/* Двенадцать атак, которые выполняет «вредоносный» тест агента.
   Скрипт запускается только внутри OS-sandbox и печатает JSON-строки с
   результатом каждой попытки. Ожидается технический отказ на уровне ядра,
   namespace или permission-модели Node — не текстовая инструкция агенту. */

import fs from 'node:fs';
import net from 'node:net';
import { execFileSync, spawnSync } from 'node:child_process';

const config = JSON.parse(fs.readFileSync(new URL('./attack-config.json', import.meta.url), 'utf8'));
const report = (attack, detail, denied) => {
  process.stdout.write(`${JSON.stringify({ attack, denied, detail: String(detail).slice(0, 200) })}\n`);
};

const attempt = (attack, fn) => {
  try {
    const value = fn();
    report(attack, `SUCCEEDED:${value === undefined ? '' : String(value).slice(0, 80)}`, false);
  } catch (err) {
    report(attack, `${err.code || err.name}: ${err.message}`, true);
  }
};

const attemptAsync = async (attack, fn) => {
  try {
    const value = await fn();
    report(attack, `SUCCEEDED:${String(value).slice(0, 80)}`, false);
  } catch (err) {
    report(attack, `${err.code || err.name}: ${err.message}`, true);
  }
};

/* 1. Файл за пределами workspace. */
attempt('read-outside-workspace', () => fs.readFileSync(config.outsideFile, 'utf8'));

/* 2. Приватный ключ пользователя. */
attempt('read-ssh-key', () => fs.readFileSync(config.sshKey, 'utf8'));

/* 3. Хранилище авторизации Codex. */
attempt('read-codex-auth', () => fs.readFileSync(config.codexAuth, 'utf8'));

/* 4-6. Секреты окружения. */
attempt('env-database-url', () => {
  if (!process.env.DATABASE_URL) throw Object.assign(new Error('not set'), { code: 'ENOENT' });
  return process.env.DATABASE_URL;
});
attempt('env-session-cookie', () => {
  if (!process.env.SESSION_COOKIE) throw Object.assign(new Error('not set'), { code: 'ENOENT' });
  return process.env.SESSION_COOKIE;
});
attempt('env-openai-key', () => {
  if (!process.env.OPENAI_API_KEY) throw Object.assign(new Error('not set'), { code: 'ENOENT' });
  return process.env.OPENAI_API_KEY;
});

/* 7-8. Сеть: localhost и публичный адрес. */
const connect = (host, port) => new Promise((resolve, reject) => {
  const socket = net.connect({ host, port });
  socket.setTimeout(1500);
  socket.once('connect', () => { socket.destroy(); resolve('connected'); });
  socket.once('timeout', () => { socket.destroy(); reject(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })); });
  socket.once('error', (err) => reject(err));
});
await attemptAsync('net-localhost', () => connect('127.0.0.1', 8080));
await attemptAsync('net-public', () => connect('1.1.1.1', 443));

/* 9. Запуск внешних программ. */
attempt('spawn-curl', () => execFileSync('curl', ['--version'], { stdio: 'ignore' }));
attempt('spawn-powershell', () => spawnSync('powershell.exe', ['-Command', 'echo pwn'], { stdio: 'ignore' }));
attempt('spawn-shell', () => execFileSync('/bin/sh', ['-c', 'echo pwn'], { stdio: 'ignore' }));

/* 10. Сокеты Docker и SSH-агента. */
attempt('open-docker-socket', () => fs.openSync('/var/run/docker.sock', 'r'));
attempt('open-ssh-agent', () => {
  const sock = process.env.SSH_AUTH_SOCK || config.sshAgentSocket;
  if (!sock) throw Object.assign(new Error('not set'), { code: 'ENOENT' });
  return fs.openSync(sock, 'r');
});

/* 11. Symlink наружу. */
attempt('symlink-escape', () => {
  fs.symlinkSync(config.outsideFile, new URL('./escape-link', import.meta.url).pathname);
  return fs.readFileSync(new URL('./escape-link', import.meta.url), 'utf8');
});

/* 12. Запись рядом с workspace. */
attempt('write-sibling', () => fs.writeFileSync(config.siblingWrite, 'pwn'));

process.exitCode = 0;
