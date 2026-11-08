import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {
  API_VERSION,
  BRIDGE_PREFIX,
  CONFIG_DEFAULTS,
  __internals,
  apply,
  createLogger,
  name,
  normalizeConfig,
  readHostVersion,
  resolveDshHome,
  version,
} from '../index.js';
import { fakeCtx, makeLogger, makeTmpDir, removeTmpDir, waitFor } from './helpers.js';

function services(overrides = {}) {
  return {
    workspaceRegistry: { list: async () => [], create: async () => ({}) },
    sessions: { list: async () => [], get: async () => null },
    tools: { view: async () => [] },
    fs: {
      resolve: async () => ({ targetKey: 'x' }),
      readText: async () => '',
      writeText: async () => ({}),
      listDir: async () => [],
    },
    webServer: { register: () => () => {} },
    ...overrides,
  };
}

test('index exports: identity, defaults and internals', () => {
  assert.equal(name, 'dsh-modapi');
  assert.equal(version, '0.2.0');
  assert.equal(API_VERSION, '1');
  assert.equal(BRIDGE_PREFIX, '/modapi/api');
  assert.equal(Object.isFrozen(CONFIG_DEFAULTS), true);
  assert.deepEqual({ ...CONFIG_DEFAULTS }, {
    startupTimeoutMs: 15000,
    noticeLimit: 64,
    noticeTtlMs: 600000,
    hookLimitPerName: 64,
    scriptDirs: [],
    scripts: [],
    modDirs: [],
    watchScripts: false,
  });
  assert.deepEqual(Object.keys(__internals).sort(), [
    'BRIDGE_PREFIX',
    'createLogger',
    'createModapi',
    'normalizeConfig',
    'readHostVersion',
    'registerBridge',
    'resolveDshHome',
  ]);
  assert.equal(__internals.normalizeConfig, normalizeConfig);
  assert.equal(__internals.resolveDshHome, resolveDshHome);
});

test('normalizeConfig: empty input yields the defaults', () => {
  const config = normalizeConfig();
  assert.equal(config.startupTimeoutMs, 15000);
  assert.equal(config.noticeLimit, 64);
  assert.equal(config.noticeTtlMs, 600000);
  assert.equal(config.hookLimitPerName, 64);
  assert.equal(config.watchScripts, false);
  assert.deepEqual(config.scriptDirs, []);
  assert.deepEqual(config.scripts, []);
  assert.deepEqual(normalizeConfig(null), config);
  assert.deepEqual(normalizeConfig('nope'), config);
});

test('normalizeConfig: numbers are floored and clamped to their minimums', () => {
  const config = normalizeConfig({ startupTimeoutMs: 5, noticeLimit: 0, noticeTtlMs: -1, hookLimitPerName: 2.9 });
  assert.equal(config.startupTimeoutMs, 1000);
  assert.equal(config.noticeLimit, 1);
  assert.equal(config.noticeTtlMs, 1000);
  assert.equal(config.hookLimitPerName, 2);
  assert.equal(normalizeConfig({ noticeLimit: Number.NaN }).noticeLimit, 64);
  assert.equal(normalizeConfig({ noticeLimit: Number.POSITIVE_INFINITY }).noticeLimit, 64);
  assert.equal(normalizeConfig({ startupTimeoutMs: '5000' }).startupTimeoutMs, 15000);
});

test('normalizeConfig: watchScripts is strict-true and paths are absolutes', () => {
  const config = normalizeConfig({
    watchScripts: 1,
    scriptDirs: ['a', '', 7, null, 'sub/../b'],
    scripts: ['scripts/demo.js'],
    extra: 'kept',
  });
  assert.equal(config.watchScripts, false);
  assert.deepEqual(config.scriptDirs, [path.resolve('a'), path.resolve('b')]);
  assert.deepEqual(config.scripts, [path.resolve('scripts/demo.js')]);
  assert.equal(config.extra, 'kept');
  assert.equal(normalizeConfig({ watchScripts: true }).watchScripts, true);
  assert.deepEqual(normalizeConfig({ scriptDirs: 'a' }).scriptDirs, []);
});

test('resolveDshHome: DSH_HOME wins when non-empty, otherwise ~/.dsh', () => {
  const saved = process.env.DSH_HOME;
  try {
    process.env.DSH_HOME = 'C:\\custom\\home';
    assert.equal(resolveDshHome(), 'C:\\custom\\home');
    process.env.DSH_HOME = '';
    assert.equal(resolveDshHome(), path.join(os.homedir(), '.dsh'));
    delete process.env.DSH_HOME;
    assert.equal(resolveDshHome(), path.join(os.homedir(), '.dsh'));
  } finally {
    if (saved === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = saved;
  }
});

test('readHostVersion: DSH_VERSION, then empty, cached per module instance', async () => {
  const saved = process.env.DSH_VERSION;
  try {
    process.env.DSH_VERSION = '9.9.9-test';
    const withEnv = await import('../index.js?host-version=env');
    assert.equal(withEnv.readHostVersion(), '9.9.9-test');
    assert.equal(withEnv.readHostVersion(), '9.9.9-test');

    delete process.env.DSH_VERSION;
    const withoutEnv = await import('../index.js?host-version=none');
    const first = withoutEnv.readHostVersion();
    assert.equal(typeof first, 'string');
    assert.equal(first, '');
    process.env.DSH_VERSION = 'changed-later';
    assert.equal(withoutEnv.readHostVersion(), first);
  } finally {
    if (saved === undefined) delete process.env.DSH_VERSION;
    else process.env.DSH_VERSION = saved;
  }
});

test('createLogger: forwards to ctx.logger and never throws', () => {
  const logger = makeLogger();
  const log = createLogger({ logger });
  log.debug('d');
  log.info('i');
  log.warn('w');
  log.error('e');
  assert.equal(logger.has('debug', 'd'), true);
  assert.equal(logger.has('info', 'i'), true);
  assert.equal(logger.has('warn', 'w'), true);
  assert.equal(logger.has('error', 'e'), true);

  const hostile = createLogger({
    logger: {
      info() {
        throw new Error('logger exploded');
      },
    },
  });
  assert.doesNotThrow(() => hostile.info('still fine'));

  const lines = [];
  const original = console.log;
  const originalWarn = console.warn;
  console.log = (...args) => lines.push(args.join(' '));
  console.warn = (...args) => lines.push(args.join(' '));
  try {
    createLogger(undefined).debug('suppressed');
    assert.equal(lines.length, 0);
    createLogger(undefined).info('to console');
    createLogger({ logger: { warn: () => {} } }).info('fallback');
    createLogger(undefined).warn('warned');
  } finally {
    console.log = original;
    console.warn = originalWarn;
  }
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^\[dsh-modapi\] to console$/);
  assert.match(lines[1], /^\[dsh-modapi\] fallback$/);
  assert.match(lines[2], /^\[dsh-modapi\] warned$/);
});

test('apply: provides modapi, mounts the bridge, registers a teardown and starts', async () => {
  const dir = makeTmpDir('apply');
  const savedHome = process.env.DSH_HOME;
  const savedSession = process.env.DSH_SESSION_ID;
  process.env.DSH_HOME = dir;
  process.env.DSH_SESSION_ID = 'session-42';
  const { ctx, calls } = fakeCtx(
    services({ sessions: { list: async () => [], get: async (id) => ({ id, title: `session ${id}` }) } }),
    { logger: makeLogger() },
  );
  try {
    const api = apply(ctx, { startupTimeoutMs: 1000 });
    assert.equal(calls.provide.length, 1);
    assert.equal(calls.provide[0].name, 'modapi');
    assert.equal(calls.provide[0].value, api);
    assert.deepEqual(calls.on.map((call) => call.event), [
      'session/created',
      'session/disposed',
      'session/event',
      'tools/result',
      'tools/pre-execute',
    ]);
    assert.deepEqual(calls.inject[0].names, ['webServer']);
    assert.equal(calls.effect.length, 1);
    const teardown = calls.effect[0]();
    assert.equal(typeof teardown, 'function');

    assert.equal(await waitFor(() => api.health().started === true, 8000), true);
    assert.equal(api.info().dshHome, dir);
    const current = await api.session.current();
    assert.equal(current.id, 'session-42');
    assert.equal(api.health().ok, true);
    assert.equal(api.health().scripts, 0);

    await teardown();
    assert.ok(calls.disposers.includes('inject-scope'));
    assert.equal(api.health().notices, 0);
  } finally {
    if (savedHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = savedHome;
    if (savedSession === undefined) delete process.env.DSH_SESSION_ID;
    else process.env.DSH_SESSION_ID = savedSession;
    removeTmpDir(dir);
  }
});

test('apply: without a webServer the bridge reports pending and start still completes', async () => {
  const dir = makeTmpDir('apply-nobridge');
  const savedHome = process.env.DSH_HOME;
  process.env.DSH_HOME = dir;
  const logger = makeLogger();
  const { ctx, calls } = fakeCtx(services({ webServer: undefined }), { logger });
  try {
    const api = apply(ctx, { startupTimeoutMs: 1000 });
    assert.equal(logger.has('debug', 'notice bridge not mounted yet: failed: webServer.register is unavailable'), true);
    assert.equal(await waitFor(() => api.health().started === true, 8000), true);
    assert.equal(api.health().services.webServer, false);
    const bridgeGap = api.selfcheck.snapshot().last.missing.find((item) => item.id === 'notice.bridge');
    assert.equal(bridgeGap.reason, 'bridge not mounted: failed: webServer.register is unavailable');
    await calls.effect[0]()();
  } finally {
    if (savedHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = savedHome;
    removeTmpDir(dir);
  }
});
