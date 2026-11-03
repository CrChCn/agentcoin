// UNIFIED-SITE-01: личное пространство агента — постоянная память.
// Правила (ТЗ EMPIRE-UNIFIED-SITE-01 п.4):
//  - один процесс-писатель на каталог данных (lock-файл), JSON не подключает второй сервис;
//  - владелец записи определяется сервером (адрес живой серверной сессии), не клиентом;
//  - повреждённое хранилище НИКОГДА не обнуляется: восстановление из резервных
//    копий; если ни одна копия не читается — startup-ошибка, зона агента
//    недоступна, остальной сайт работает;
//  - каталог данных создаётся с ограничением прав; пути из запросов не выбираются.
// UNIFIED-SITE-FIX-02:
//  - барьер записи: превышение лимитов (число записей / размер хранилища)
//    отклоняется ДО изменения хранилища — ранее подтверждённые записи
//    не теряются, логического «успеха» при отказе не выдаётся;
//  - гигиена логов: содержимое записей (memo) в логи не попадает — только метаданные;
//  - lock-файл освобождается даже при неудачной загрузке хранилища (иначе
//    после сбоя зона оставалась навсегда недоступной до ручного удаления lock).
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const MAX_RECORDS = 1000;
const MAX_TEXT = 4000;
const MAX_STORE = 2 * 1024 * 1024;
const ID_RE = /^[a-zA-Z0-9_-]{1,80}$/;
const OWNER_RE = /^AGT[0-9a-f]{40}$/;
const BACKUP_SLOTS = 3;

const fail = (code) => { const e = new Error(code); e.code = code; throw e; };

export class AgentMemory {
  #dir; #file; #lockFd = null; #records = new Map();
  constructor({ directory }) {
    if (typeof directory !== 'string' || !directory || path.basename(directory) === '..' || path.basename(directory) === '.') fail('invalid_memory_config');
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const st = fs.lstatSync(directory);
    if (!st.isDirectory() || st.isSymbolicLink()) fail('unsafe_memory_directory');
    this.#dir = directory;
    this.#file = path.join(directory, 'memory.json');
    // Однопроцессная запись: lock-файл создаётся эксклюзивно, держится открытым.
    // В lock пишем PID своего процесса: если писатель умер (Force-kill, EADDRINUSE
    // у ноды), следующий старт сам убирает stale-лок вместо вечного busy.
    const lock = path.join(directory, 'memory.lock');
    try { this.#lockFd = fs.openSync(lock, 'wx', 0o600); fs.writeFileSync(this.#lockFd, JSON.stringify({ pid: process.pid, at: Date.now() })); }
    catch (e) {
      if (e.code === 'EEXIST') {
        // уже есть писатель — но если он мёртв, лок считается несостоявшимся
        const stale = (() => {
          try {
            const prev = JSON.parse(fs.readFileSync(lock, 'utf8'));
            return Number.isSafeInteger(prev.pid) && prev.pid !== process.pid && !this.#processAlive(prev.pid);
          } catch { return false; } // пустой/нечитаемый/без PID — не рискуем, остаёмся busy
        })();
        if (!stale) fail('agent_memory_busy');
        try { fs.unlinkSync(lock); } catch { fail('agent_memory_busy'); }
        try { this.#lockFd = fs.openSync(lock, 'wx', 0o600); fs.writeFileSync(this.#lockFd, JSON.stringify({ pid: process.pid, at: Date.now() })); }
        catch (e2) { fail('agent_memory_busy'); }
      } else throw e;
    }
    try { this.#load(); }
    catch (e) {
      // FIX (утечка lock при ошибке загрузки): сбой инициализации не должен
      // оставлять lock-файл навсегда — иначе зона агентской памяти не читается
      // до ручного удаления memory.lock.
      this.close();
      throw e;
    }
  }
  close() { if (this.#lockFd !== null) { try { fs.closeSync(this.#lockFd); fs.unlinkSync(path.join(this.#dir, 'memory.lock')); } catch { /* пусто */ } this.#lockFd = null; } }
  #processAlive(pid) {
    try { process.kill(pid, 0); return true; } // сигнал 0 = только проверка существования
    catch (e) { return e.code === 'EPERM'; } // EPERM значит процесс есть, но без прав
  }
  get directory() { return this.#dir; }
  #readStore(file) {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_STORE) fail('invalid_memory_store');
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (doc.version !== 1) { console.log('[agent-memory] версия хранилища: ' + (doc && doc.version)); fail('invalid_memory_store'); }
    if (!Array.isArray(doc.records)) { console.log('[agent-memory] records не массив: ' + typeof doc.records); fail('invalid_memory_store'); }
    if (doc.records.length > MAX_RECORDS) fail('invalid_memory_store');
    const map = new Map();
    for (const r of doc.records) {
      if (!r || typeof r !== 'object' || !ID_RE.test(r.id || '') || !OWNER_RE.test(r.owner || '')
        || typeof r.text !== 'string' || r.text.length > MAX_TEXT
        || !Number.isSafeInteger(r.created) || !Number.isSafeInteger(r.updated)) {        // FIX (утечка содержимого в логи): полный дамп записи в лог не пишем —
        // только метаданные. Текст memo может быть приватным.
        console.log('[agent-memory] запись отклонена: id=' + (r && r.id) + ' owner=' + (r && r.owner)
          + ' textLen=' + (r && typeof r.text === 'string' ? r.text.length : 'n/a'));
        fail('invalid_memory_store');
      }
      if (map.has(r.id)) fail('invalid_memory_store');
      map.set(r.id, { owner: r.owner, text: r.text, created: r.created, updated: r.updated });
    }
    return map;
  }
  #load() {
    let corrupted = null;
    try { this.#records = this.#readStore(this.#file); return; }
    catch (e) { if (e.code === 'ENOENT') return; corrupted = { file: this.#file, error: e.code || 'invalid_memory_store' }; console.log('[agent-memory] главный файл нечитаем: ' + (e.code || e.message)); }
    // Главное хранилище повреждено -> ни обнуления, ни затирания поверх: спасаем резервом.
    for (let k = 1; k <= BACKUP_SLOTS; k++) {
      const bak = path.join(this.#dir, `memory.bak-${k}.json`);
      try {
        const child = this.#readStore(bak);
        const keep = path.join(this.#dir, `memory.corrupt-${Date.now()}.json`);
        fs.renameSync(this.#file, keep); // испорченный оригинал сохраняем для разбора
        this.#writeMain(child);
        this.#records = child;
        console.log(`[agent-memory] восстановлено из ${path.basename(bak)} (испорченный файл сохранён как ${path.basename(keep)})`);
        return;
      } catch (e) { if (e.code !== 'ENOENT' && !corrupted.ignored) corrupted = { file: bak, error: e.code || 'invalid_memory_store' }; console.log('[agent-memory] резерв ' + path.basename(bak) + ' нечитаем: ' + (e.code || e.message)); }
    }
    fail('agent_memory_store_unrecoverable'); // зона агента недоступна, сайт продолжает работать
  }
  #payloadOf(map) {
    // ВАЖНО: id хранится В ЗАПИСИ (ключ Map в JSON не сохраняется) — без этого
    // повторная загрузка не могла бы восстановить идентификаторы записей.
    return JSON.stringify({ version: 1, records: [...map.entries()].map(([id, r]) => ({ id, owner: r.owner, text: r.text, created: r.created, updated: r.updated })) });
  }
  #writeMain(map) {
    const payload = this.#payloadOf(map);
    if (Buffer.byteLength(payload) > MAX_STORE) fail('agent_memory_store_limit');
    const temp = this.#file + '.' + randomBytes(8).toString('hex') + '.tmp';
    let fd;
    try {
      fd = fs.openSync(temp, 'wx', 0o600);
      fs.writeFileSync(fd, payload); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
      fs.renameSync(temp, this.#file);
    } finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* пусто */ } } }
  }
  #commit(map) {
    this.#writeMain(map);
    // Резерв: ротация слотов — предыдущий снимок всегда достаточно близко.
    for (let k = BACKUP_SLOTS; k >= 2; k--) {
      const prev = path.join(this.#dir, `memory.bak-${k - 1}.json`), next = path.join(this.#dir, `memory.bak-${k}.json`);
      try { if (fs.existsSync(prev)) fs.renameSync(prev, next); } catch { /* пусто */ }
    }
    try { fs.copyFileSync(this.#file, path.join(this.#dir, 'memory.bak-1.json')); } catch { /* пусто */ }
    this.#records = map;
  }
  #validate(owner, id, text) {
    if (!OWNER_RE.test(owner)) fail('invalid_owner');
    if (!ID_RE.test(id)) fail('invalid_object_id');
    if (typeof text !== 'string' || text.length < 1 || text.length > MAX_TEXT) fail('invalid_record');
  }
  count(owner) { return [...this.#records.values()].filter(r => r.owner === owner).length; }
  list(owner) {
    return [...this.#records.entries()].filter(([, r]) => r.owner === owner)
      .map(([id, r]) => ({ id, text: r.text, created: r.created, updated: r.updated }));
  }
  read(owner, id) {
    this.#validate(owner, id, 'x');
    const r = this.#records.get(id);
    if (!r || r.owner !== owner) return null; // чужая запись недоступна и как чужая не раскрыта
    return { id, text: r.text, created: r.created, updated: r.updated };
  }
  // FIX (барьер записи): отклоняем превышение лимитов ДО изменения хранилища.
  #assertFits(next) {
    if (next.size > MAX_RECORDS) fail('agent_memory_limit');
    if (Buffer.byteLength(this.#payloadOf(next)) > MAX_STORE) fail('agent_memory_store_limit');
  }
  create(owner, id, text) {
    if (id === undefined || id === null || id === '') id = randomBytes(12).toString('hex');
    this.#validate(owner, id, text);
    const next = new Map(this.#records);
    if (next.has(id)) fail('duplicate_object');
    const now = Date.now();
    next.set(id, { owner, text, created: now, updated: now });
    this.#assertFits(next); // барьер ДО записи на диск: превышение — отказ, состояние не трогаем
    next.set(id, { owner, text, created: now, updated: now });
    this.#commit(next);
    return { id, created: now };
  }
  write(owner, id, text) {
    this.#validate(owner, id, text);
    const r = this.#records.get(id);
    if (!r || r.owner !== owner) return null;
    const next = new Map(this.#records);
    next.set(id, { owner, text, created: r.created, updated: Date.now() });
    this.#assertFits(next); // барьер ДО записи на диск (запись может вырасти до лимита размера)
    this.#commit(next);
    return { id, updated: next.get(id).updated };
  }
  remove(owner, id) {
    this.#validate(owner, id, 'x');
    const r = this.#records.get(id);
    if (!r || r.owner !== owner) return null;
    const next = new Map(this.#records);
    next.delete(id);
    this.#commit(next);
    return { id };
  }
  search(owner, query) {
    if (typeof query !== 'string') fail('invalid_query');
    const q = query.trim().toLowerCase();
    return this.list(owner).filter(r => !q || r.text.toLowerCase().includes(q));
  }
  export(owner) {
    return { version: 1, subject: owner, records: this.list(owner) };
  }
}

export { fail as memoryError };
