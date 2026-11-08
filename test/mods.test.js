import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { HookRegistry } from '../lib/hooks.js';
import { EventBus } from '../lib/events.js';
import { RegistryManager } from '../lib/registry.js';
import { ModuleRegistry } from '../lib/modules.js';
import { createScriptHost } from '../lib/scripts.js';
import { makeLogger, makeTmpDir, removeTmpDir } from './helpers.js';

/** A script-visible api with the Fabric-style surfaces wired to real registries. */
function buildRuntime() {
  const logger = makeLogger();
  const hooks = new HookRegistry({ logger });
  const events = new EventBus({ logger });
  const registry = new RegistryManager();
  const modules = new ModuleRegistry({ apiVersion: '1' });
  const api = {
    version: '0.1.0',
    apiVersion: '1',
    name: 'dsh-modapi',
    work: {}, session: {}, tool: {}, fs: {},
    notice: { push: () => {} },
    toast: () => {},
    公告: () => {},
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    hook: (name, handler, options) => hooks.on(name, handler, options),
    events: {
      on: (name, listener, options) => events.on(name, listener, options),
      create: (name, options) => events.create(name, options),
      fire: (name, ...args) => events.fire(name, ...args),
      get: (name) => events.get(name),
    },
    registry: {
      create: (name, options) => registry.create(name, options),
      use: (name) => registry.use(name),
      get: (name) => registry.get(name),
    },
  };
  return { logger, hooks, events, registry, modules, api };
}

function makeModHome(home, id, manifest, files = {}) {
  const dir = path.join(home, 'modapi', 'mods', id);
  fs.mkdirSync(dir, { recursive: true });
  // Every fixture gets a start entrypoint unless the case is about entrypoints.
  const entrypoints = manifest.entrypoints ?? { start: 'main.js' };
  fs.writeFileSync(path.join(dir, 'modapi.mod.json'), JSON.stringify({ id, ...manifest, entrypoints }));
  for (const [name, source] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), source);
  return dir;
}

function makeHost(home, runtime, config = {}) {
  return createScriptHost({
    api: runtime.api,
    hooks: runtime.hooks,
    events: runtime.events,
    modules: runtime.modules,
    logger: runtime.logger,
    dshHome: home,
    cwd: home,
    config: { scriptDirs: [], scripts: [], ...config },
  });
}

test('loadMods: a manifest with start entrypoints loads and reports its hooks', async () => {
  const home = makeTmpDir('mods-ok');
  const runtime = buildRuntime();
  const host = makeHost(home, runtime);
  try {
    makeModHome(home, 'demo', { version: '1.0.0', requires: { work: '^1.0.0' } }, {
      'main.js': `function checkstart() { modapi.hook('demo-started', () => {}); }`,
    });
    await host.load();
    const mods = host.mods();
    assert.equal(mods.length, 1);
    assert.equal(mods[0].id, 'demo');
    assert.equal(mods[0].status, 'loaded');
    assert.deepEqual(mods[0].hooks, ['checkstart']);
    assert.equal(runtime.hooks.has('checkstart'), true);
    assert.equal(host.modCount, 1);
    assert.equal(host.size, 1);
  } finally {
    host.dispose();
    removeTmpDir(home);
  }
});

test('loadMods: an unmet requires skips the mod with a readable reason', async () => {
  const home = makeTmpDir('mods-requires');
  const runtime = buildRuntime();
  const host = makeHost(home, runtime);
  try {
    makeModHome(home, 'needy', { version: '1.0.0', requires: { work: '^2.0.0', ghost: '^1.0.0' } }, {
      'main.js': `modapi.hook('should-not-register', () => {});`,
    });
    await host.load();
    const [record] = host.mods();
    assert.equal(record.status, 'failed');
    assert.match(record.reason, /work 1\.0\.0 does not satisfy \^2\.0\.0/);
    assert.match(record.reason, /ghost \(missing\)/);
    assert.equal(runtime.hooks.has('should-not-register'), false);
    assert.equal(host.size, 0);
  } finally {
    host.dispose();
    removeTmpDir(home);
  }
});

test('loadMods: modapi requires are checked against the contract revision', async () => {
  const home = makeTmpDir('mods-modapi-requires');
  const runtime = buildRuntime();
  const host = makeHost(home, runtime);
  try {
    makeModHome(home, 'old', { version: '1.0.0', requires: { modapi: '^2.0.0' } }, { 'main.js': '' });
    makeModHome(home, 'new', { version: '1.0.0', requires: { modapi: '^1.0.0' } }, { 'main.js': '' });
    await host.load();
    const byId = Object.fromEntries(host.mods().map((record) => [record.id, record]));
    assert.equal(byId.old.status, 'failed');
    assert.match(byId.old.reason, /modapi 1 does not satisfy \^2\.0\.0/);
    assert.equal(byId.new.status, 'loaded');
  } finally {
    host.dispose();
    removeTmpDir(home);
  }
});

test('loadMods: depends gate the load order, and a bad range fails the dependent', async () => {
  const home = makeTmpDir('mods-depends');
  const runtime = buildRuntime();
  const host = makeHost(home, runtime);
  try {
    makeModHome(home, 'depends-on-missing', { version: '1.0.0', depends: { ghost: '^1.0.0' } }, { 'main.js': '' });
    makeModHome(home, 'library', { version: '1.0.0' }, { 'main.js': `modapi.events.create('library:ready');` });
    makeModHome(home, 'consumer', { version: '1.0.0', depends: { library: '^1.0.0' } }, {
      'main.js': `modapi.events.on('library:ready', () => {});`,
    });
    await host.load();
    const byId = Object.fromEntries(host.mods().map((record) => [record.id, record]));
    assert.equal(byId['depends-on-missing'].status, 'failed');
    assert.match(byId['depends-on-missing'].reason, /unmet dependency/);
    assert.equal(byId.library.status, 'loaded');
    assert.equal(byId.consumer.status, 'loaded');
    assert.equal(runtime.events.has('library:ready'), true);
    assert.equal(runtime.events.get('library:ready').size, 1);
  } finally {
    host.dispose();
    removeTmpDir(home);
  }
});

test('loadMods: a throwing entrypoint rolls the mod back and keeps the host alive', async () => {
  const home = makeTmpDir('mods-throw');
  const runtime = buildRuntime();
  const host = makeHost(home, runtime);
  try {
    makeModHome(home, 'bad', { version: '1.0.0' }, {
      'main.js': `modapi.hook('leaked', () => {}); throw new Error('boom');`,
    });
    await host.load();
    const [record] = host.mods();
    assert.equal(record.status, 'failed');
    assert.match(record.reason, /entrypoint did not run/);
    assert.equal(runtime.hooks.has('leaked'), false);
    assert.equal(host.size, 0);
    assert.ok(runtime.logger.entries.some((entry) => entry.level === 'warn' && /boom/.test(entry.text)));
  } finally {
    host.dispose();
    removeTmpDir(home);
  }
});

test('unloadMod: runs the stop entrypoint, then removes hooks and events', async () => {
  const home = makeTmpDir('mods-unload');
  const runtime = buildRuntime();
  const host = makeHost(home, runtime);
  try {
    const dir = makeModHome(home, 'stoppable', {
      version: '1.0.0',
      entrypoints: { start: 'main.js', stop: 'stop.js' },
    }, {
      'stop.js': `modapi.hook('demo-stopped', () => {});`,
      'main.js': `modapi.hook('demo-live', () => {}); modapi.events.create('stoppable:own');`,
    });
    await host.load();
    assert.equal(runtime.hooks.has('demo-live'), true);
    assert.equal(runtime.events.has('stoppable:own'), true);
    assert.ok(dir);
    assert.equal(await host.unloadMod('stoppable'), true);
    assert.equal(runtime.hooks.has('demo-live'), false);
    assert.equal(runtime.events.has('stoppable:own'), false);
    assert.equal(runtime.hooks.has('demo-stopped'), false);
    assert.equal(host.modCount, 0);
    assert.equal(host.size, 0);
    assert.equal(await host.unloadMod('stoppable'), false);
  } finally {
    host.dispose();
    removeTmpDir(home);
  }
});
