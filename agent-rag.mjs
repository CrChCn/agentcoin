// UNIFIED-SITE-01 → RAG-ПОДГОТОВКА: выдача «контекста» из постоянной памяти агента.
// Правила честности (ТЗ п.5):
//  - работает ТОЛЬКО извлечение записей из памяти самого субъекта (изоляция как во
//    всей зоне /agent — владелец записей назначается сервером);
//  - генерации ответов НЕТ: модель не подключена, внешние API не подменяются,
//    результат помечается generated:false — потребители не должны считать это ответом;
//  - позиционного «поискового индекса» на диске нет: выборка каждый раз по живому
//    срезу памяти (до 1000 записей — это сотых доли секунды), значит нет второго
//    писателя в каталог данных и нет ещё одного файла для резервов.

const stop = new Set([
  'а','и','в','во','не','что','он','на','я','с','со','как','то','же','к','по','у','из','за','о','от','для','the','a','an','of','to','in','is','it',
]);

export const RAG_TIME_LESSON = 'извлечение из памяти доступно, генерация ответов не подключена';

export function tokenize(text) {
  if (typeof text !== 'string') return [];
  return String(text).toLowerCase().match(/[\p{L}\p{N}_]{2,}/gu)?.filter(w => !stop.has(w)) ?? [];
}

// records: [{id, text, created, updated}] — СТРОГО записи одного субъекта.
// Возвращает top-limit [{id, text, score, updated}], score >= 0, отсортировано по убыванию.
export function retrieveMemory(records, query, limit = 5) {
  if (!Array.isArray(records)) fail('rag_records_invalid');
  if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > 25) fail('rag_limit_invalid');
  if (typeof query !== 'string') fail('invalid_query');
  const qTerms = tokenize(query).filter(t => !stop.has(t));
  if (qTerms.length === 0) return [];
  // BM25-like: идёт по записям одного субъекта, малое N — простое взвешивание достаточно точно
  const docs = records.map(r => ({ ...r, terms: tokenize(r.text) }));
  const N = docs.length;
  const df = new Map();
  for (const d of docs) for (const t of new Set(d.terms)) df.set(t, (df.get(t) || 0) + 1);
  const avgLen = N ? docs.reduce((s, d) => s + d.terms.length, 0) / N : 0;
  const k1 = 1.2, b = 0.75;
  const scored = [];
  for (const d of docs) {
    let score = 0;
    const tf = new Map();
    for (const t of d.terms) tf.set(t, (tf.get(t) || 0) + 1);
    for (const t of qTerms) {
      const idf = Math.log(1 + (N - (df.get(t) || 0) + 0.5) / ((df.get(t) || 0) + 0.5));
      if (idf <= 0) continue;
      const f = tf.get(t) || 0;
      if (!f) continue;
      score += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.terms.length) / (avgLen || 1)));
    }
    if (score > 0) scored.push({ id: d.id, text: d.text, updated: d.updated, score: Number(score.toFixed(4)) });
  }
  scored.sort((a, c) => c.score - a.score || c.updated - a.updated);
  return scored.slice(0, limit);
}

export { fail as ragError };

function fail(code) { const e = new Error(code); e.code = code; throw e; }
