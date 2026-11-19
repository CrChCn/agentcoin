#!/usr/bin/env node
/* Контракт адаптера агента.
   Адаптер — единственное место, где оркестратор знает про конкретную среду
   (Freebuff, Codex, тестовый дублёр). Всё остальное работает с этими полями.

   export const id: string
   export const roles: ('implementer'|'reviewer')[]
   export const simulated: boolean          // true => результат нельзя выдавать за реального агента
   export function probe(): {
     available: boolean,                   // интерфейс физически есть в этой среде
     programmatic: boolean,                 // можно запускать без браузера/клавиатуры/экрана
     authenticated: boolean,                // есть действующие учётные данные
     version?: string, reason?: string, evidence?: string, requiresHuman?: string
   }
   export async function run(ctx): Promise<{
     result?: object,                      // для исполнителя: поля result.schema.json (без artifactId/hash)
     review?: object,                      // для проверяющего: поля review.schema.json
     commandsRun?: string[],
     blocked?: { code: string, detail: string }
   }>

   ctx для исполнителя:  { task, iteration, workspace, findings, logFile, runCommand }
   ctx для проверяющего: { task, workspace, archive (Buffer), meta, result, findings,
                           baseCommit, resultCommit, implementerDir, runCommand }

   Инварианты, которые адаптер не может нарушить:
   - не расширяет scope: оркестратор сам считает изменённые файлы через git;
   - не объявляет хеш артефакта: его считает build_artifact;
   - не принимает собственную работу: id исполнителя и проверяющего различаются,
     а проверяющий физически не получает рабочее дерево исполнителя.
*/
export const ADAPTER_CONTRACT_VERSION = 1;
