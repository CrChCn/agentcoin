#!/usr/bin/env node
import * as fixtureImplementer from './fixture-implementer.mjs';
import * as fixtureReviewer from './fixture-reviewer.mjs';
import * as freebuffCli from './freebuff-cli.mjs';
import * as codexCli from './codex-cli.mjs';
import * as codexImplementer from './codex-implementer.mjs';
import * as codexReviewer from './codex-reviewer.mjs';

const REGISTRY = new Map([
  [fixtureImplementer.id, fixtureImplementer],
  [fixtureReviewer.id, fixtureReviewer],
  [freebuffCli.id, freebuffCli],
  [codexCli.id, codexCli],
  [codexImplementer.id, codexImplementer],
  [codexReviewer.id, codexReviewer],
]);

export function getAdapter(name) {
  const adapter = REGISTRY.get(name);
  if (!adapter) {
    throw Object.assign(new Error(`unknown adapter: ${name}`), { code: 'UNKNOWN_ADAPTER', adapters: [...REGISTRY.keys()] });
  }
  return adapter;
}

export function listAdapters() {
  return [...REGISTRY.values()].map((adapter) => ({
    id: adapter.id,
    roles: adapter.roles,
    simulated: adapter.simulated,
    capability: adapter.probe(),
  }));
}

export function assertRole(name, role) {
  const adapter = getAdapter(name);
  if (!adapter.roles.includes(role)) {
    throw Object.assign(new Error(`adapter ${name} cannot act as ${role}`), { code: 'ADAPTER_ROLE_MISMATCH' });
  }
  return adapter;
}
