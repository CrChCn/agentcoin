#!/usr/bin/env node
/* Deployer — заглушка этапа C1. Юнит существует, чтобы установка была полной
   и предсказуемой, но публиковать он не умеет и не будет до отдельного этапа
   (staging, атомарный release, backup, health-check, rollback, журнал).

   Условия включения на будущее:
   - /etc/agentcoin/deploy-enabled присутствует (ставится владельцем);
   - mission.permissions.deployment === "allowed";
   - реализованы все шаги атомарного release.

   Сейчас любой запуск завершается кодом 3 и записью в журнал сервиса. */

import fs from 'node:fs';

import { OpsStore } from './store.mjs';

const ENABLE_FILE = process.env.OPS_DEPLOY_ENABLE_FILE || '/etc/agentcoin/deploy-enabled';
const root = process.env.OPS_ROOT || '/srv/agentcoin-ops';

const store = new OpsStore(root);
const enabled = fs.existsSync(ENABLE_FILE);

store.journal('deployer.refused', null, { enabled, stage: 'C1', reason: 'deployment is not part of C1' });

console.log(JSON.stringify({
  status: 'BLOCKED',
  blockedCode: 'DEPLOYMENT_NOT_ENABLED_IN_C1',
  enableFile: ENABLE_FILE,
  enableFilePresent: enabled,
  note: 'C1 готовит сервис и очередь; публикация начинается только после отдельного этапа deployer со staging, backup, health-check и rollback.',
}, null, 2));

process.exitCode = 3;
