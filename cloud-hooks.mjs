#!/usr/bin/env node
/* Мост ноды к облаку: реэкспорт CloudLedger + совместимая награда */
'use strict';
export { CloudLedger, CLOUD_SHARE, GB_PER_COIN, EPOCH_SIZE } from './cloud.mjs';
import { blockReward, BASE_REWARD, HALVING_INTERVAL } from './core.mjs';
export { blockReward, BASE_REWARD, HALVING_INTERVAL };
