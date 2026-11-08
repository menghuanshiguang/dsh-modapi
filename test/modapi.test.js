import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HOOK_NAMES, WIRED_HOOKS } from '../lib/hooks.js';
import { NOTICE_LEVELS } from '../lib/notices.js';
import { PROBE_SERVICES, createModapi } from '../lib/modapi.js';
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

function makeInstance(dir, options = {}) {
  const logger = options.logger ?? makeLogger();
  const { ctx, calls } = fakeCtx(options.services ?? services(), { logger });
  if (options.mutateCtx) options.mutateCtx(ctx);
  const instance = createModapi({
    ctx,
    config: { startupTimeoutMs: 1000, ...(options.config ?? {}) },
    dshHome: dir,
    logger,
    hostVersion: 'host-test',
    currentSessionId: options.currentSessionId,
  });
  return { instance, ctx, calls, logger };
}

async function withInstance(label, options, body) {
  const dir = makeTmpDir(label);
  const built = makeInstance(dir, options);
  try {
    await body({ dir, ...built });
  } finally {
    await built.instance.dispose();
    removeTmpDir(dir);
  }
}

test('api surface: versions, hooks, notice aliases and the scripts table', async () => {
  await withInstance('surface', {}, async ({ instance }) => {
    const api = instance.api;
    assert.equal(api.name, 'dsh-modapi');
    assert.equal(api.version, '0.3.0');
    assert.equal(api.pluginVersion, '0.3.0');
    assert.equal(api.apiVersion, '1');
    assert.equal(api.hookNames, HOOK_NAMES);
    assert.equal(api.wiredHooks, WIRED_HOOKS);
    assert.equal(api.hookNames.length, 11);
    assert.equal(api.wiredHooks.length, 8);
    assert.equal(api.notice, api.公告);
    assert.equal(api.notice, api.toast);
    assert.equal(api.noticeLevels, NOTICE_LEVELS);
    assert.equal(typeof api.notice, 'function');
    assert.equal(api.Toast, api.notice.Toast);
    assert.equal(typeof api.hook, 'function');
    assert.equal(typeof api.unhook, 'function');
    assert.equal(typeof api.fire, 'function');
    assert.equal(typeof api.hooks, 'object');
    assert.equal(typeof api.hooks.on, 'function');
    assert.equal(typeof api.hooks.fire, 'function');
    assert.equal(typeof api.patch.method, 'function');
    assert.equal(typeof api.ui.hook, 'function');
    assert.equal(api.utils.sleep, api.sleep);
    assert.equal(api.selfcheck.statePath.endsWith('contract.json'), true);
    assert.equal(typeof api.scripts.load, 'function');
    assert.equal(typeof api.scripts.reload, 'function');
    assert.equal(typeof api.scripts.unload, 'function');
    assert.equal(typeof api.scripts.watch, 'function');
    assert.equal(api.scripts.size, 0);
    assert.deepEqual(api.scripts.files(), []);
    assert.equal(Object.getOwnPropertyDescriptor(api, 'scripts').writable, false);
    assert.throws(() => {
      api.scripts = {};
    }, TypeError);
    assert.equal(api.hooks.describe().length, 11);
    assert.deepEqual(
      api.hooks.describe().filter((entry) => entry.wired).map((entry) => entry.name).sort(),
      [...WIRED_HOOKS].sort(),
    );
    assert.deepEqual(api.services(), {
      work: true,
      session: true,
      tool: true,
      fs: true,
      webServer: true,
      appReady: false,
      connection: false,
    });
    assert.deepEqual(PROBE_SERVICES.work, ['workspaceRegistry']);
    assert.equal(await api.sleep(0), undefined);
  });
});

test('health and info before start: honest unknowns', async () => {
  await withInstance('health', {}, async ({ instance }) => {
    const api = instance.api;
    const health = api.health();
    assert.equal(health.ok, null);
    assert.equal(health.started, false);
    assert.deepEqual(health.missing, []);
    assert.equal(health.hooks, 0);
    assert.equal(health.notices, 0);
    assert.equal(health.scripts, 0);
    assert.equal(health.apiVersion, '1');
    assert.equal(health.hostVersion, 'host-test');

    const info = api.info();
    assert.equal(info.startedAt, null);
    assert.equal(info.uptimeMs, 0);
    assert.equal(info.hostVersion, 'host-test');
    assert.equal(info.notices, 0);
    assert.deepEqual(info.scripts, []);
    assert.deepEqual(info.selfcheck, { last: null, failures: [], baseline: null });
    assert.equal(info.hooks.length, 11);
  });
});

test('start: wires host events, self-checks, fires checkstart and is idempotent', async () => {
  await withInstance('start', {}, async ({ dir, instance, calls, logger }) => {
    const payloads = [];
    instance.api.hook('checkstart', (payload) => {
      payloads.push(payload);
    });
    const first = await instance.start();
    assert.equal(first.ready, 'polled');
    assert.equal(first.disposers.length, 5);
    assert.equal(first.report.ok, true);
    assert.equal(first.report.checked, 10);
    assert.equal(payloads.length, 1);
    assert.equal(payloads[0].api, instance.api);
    assert.equal(payloads[0].ready, 'polled');
    assert.equal(payloads[0].selfcheck.ok, true);
    assert.match(payloads[0].info.startedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(instance.api.health().started, true);
    assert.equal(instance.api.health().ok, true);
    assert.equal(instance.api.health().hooks, 1);
    assert.equal(logger.has('info', `[dsh-modapi] started (api 1, host host-test, ready polled)`), false);
    assert.deepEqual(
      calls.on.map((call) => call.event),
      ['session/created', 'session/disposed', 'session/event', 'tools/result', 'tools/pre-execute'],
    );
    assert.equal(instance.selfcheck.snapshot().baseline.host, 'host-test');

    const second = await instance.start();
    assert.equal(second.ready, 'already-started');
    assert.equal(second.report, first.report);
    assert.equal(payloads.length, 1);
  });
});

test('lifecycle: modapi:startup fires before checkstart, shutdown before checkstop', async () => {
  await withInstance('lifecycle-order', {}, async ({ instance }) => {
    const up = [];
    instance.api.events.on('modapi:startup', () => {
      up.push('event');
    });
    instance.api.hook('checkstart', () => {
      up.push('hook');
    });

    await instance.start();
    assert.deepEqual(up, ['event', 'hook']);

    const down = [];
    instance.api.events.on('modapi:shutdown', () => {
      down.push('event');
    });
    instance.api.hook('checkstop', () => {
      down.push('hook');
    });

    await instance.dispose();
    assert.deepEqual(down, ['event', 'hook']);
  });
});

test('modules: api(name) returns the live API face, get(name) the record', async () => {
  await withInstance('module-face', {}, async ({ instance }) => {
    assert.equal(instance.api.api('work'), instance.api.work);
    assert.equal(instance.api.api('events'), instance.api.events);
    assert.equal(instance.api.api('fs'), instance.api.fs);
    assert.equal(instance.modules.get('work').value, instance.api.work);
    assert.equal(instance.modules.get('work').version, '1.0.0');
    assert.equal(instance.api.api('nope'), undefined);
  });
});

test('start: a host without services still resolves and reports every gap', async () => {
  await withInstance('nostart', { services: {} }, async ({ instance }) => {
    const result = await instance.start();
    assert.equal(result.ready, 'timeout');
    assert.equal(result.report.ok, false);
    assert.equal(result.report.missing.length, 9);
    assert.deepEqual(
      result.report.missing.map((item) => item.id),
      ['work.list', 'work.create', 'session.list', 'session.get', 'tool.list', 'fs.resolve', 'fs.read', 'fs.write', 'fs.list'],
    );
    assert.equal(instance.api.health().ok, false);
    assert.equal(instance.api.health().missing.length, 9);
    assert.equal(instance.api.health().services.work, false);
    assert.equal(instance.selfcheck.snapshot().baseline, null);
  });
});

test('start: checkstart subscribers see the ready phase the host reported', async () => {
  await withInstance('ready', { services: services({ appReady: Promise.resolve('up') }) }, async ({ instance }) => {
    const result = await instance.start();
    assert.equal(result.ready, 'ready');
    assert.equal(result.report.ok, true);
  });
});

test('start: a rejecting appReady reports failed instead of hanging', async () => {
  await withInstance(
    'ready-failed',
    { services: services({ appReady: Promise.reject(new Error('host died')) }) },
    async ({ instance }) => {
      const result = await instance.start();
      assert.equal(result.ready, 'failed');
    },
  );
});

test('wireHostEvents: host events reach the matching hooks', async () => {
  await withInstance('events', {}, async ({ instance, calls }) => {
    const seen = [];
    instance.api.hook('sessioncreate', (payload) => seen.push(['create', payload.session]));
    instance.api.hook('sessiondelete', (payload) => seen.push(['delete', payload.session]));
    instance.api.hook('messagereceive', (payload) => seen.push(['message', payload.session, payload.event]));
    instance.api.hook('toolresult', (payload) => seen.push(['result', payload.exec, payload.result]));
    instance.api.hook('toolcall', (payload) => seen.push(['call', payload.exec]));
    await instance.start();
    const byEvent = new Map(calls.on.map((call) => [call.event, call.handler]));

    byEvent.get('session/created')({ id: 's1' });
    byEvent.get('session/disposed')({ id: 's2' });
    byEvent.get('session/event')({ id: 's3' }, { type: 'message' });
    byEvent.get('tools/result')({ name: 'echo' }, { ok: true });
    assert.equal(await waitFor(() => seen.length === 4, 2000), true);

    assert.deepEqual(seen, [
      ['create', { id: 's1' }],
      ['delete', { id: 's2' }],
      ['message', { id: 's3' }, { type: 'message' }],
      ['result', { name: 'echo' }, { ok: true }],
    ]);
    assert.equal(byEvent.get('tools/pre-execute')({ name: 'echo' }), undefined);
    assert.equal(byEvent.get('tools/pre-execute')({ name: 'echo' }, () => 'next-result'), 'next-result');
    assert.equal(await waitFor(() => seen.length === 6, 2000), true);
    assert.deepEqual(seen.slice(4), [
      ['call', { name: 'echo' }],
      ['call', { name: 'echo' }],
    ]);
  });
});

test('wireHostEvents: a failing subscription is warned about and the rest still attach', async () => {
  await withInstance(
    'events-fail',
    {
      mutateCtx(ctx) {
        const original = ctx.on;
        ctx.on = (event, handler) => {
          if (event === 'tools/result') throw new Error('no listener');
          return original(event, handler);
        };
      },
    },
    async ({ instance, logger }) => {
      const result = await instance.start();
      assert.equal(result.disposers.length, 4);
      assert.equal(result.report.ok, true);
      assert.equal(logger.has('warn', '[dsh-modapi] cannot subscribe to tools/result: no listener'), true);
    },
  );
});

test('dispose: fires checkstop once, removes listeners, clears hooks and closes the store', async () => {
  await withInstance('dispose', {}, async ({ instance, calls }) => {
    const stops = [];
    instance.api.hook('checkstop', (payload) => stops.push(payload));
    await instance.start();
    assert.equal(instance.store.closed, false);
    await instance.dispose();
    assert.equal(stops.length, 1);
    assert.equal(instance.store.closed, true);
    assert.deepEqual(calls.disposers, ['session/created', 'session/disposed', 'session/event', 'tools/result', 'tools/pre-execute']);
    assert.equal(instance.api.hooks.describe().every((entry) => entry.count === 0), true);
    instance.store.push({ body: 'after close' });
    assert.equal(instance.api.health().notices, 0);
    await instance.dispose();
    assert.equal(stops.length, 1);
  });
});

test('dispose: a throwing checkstop subscriber is reported but teardown completes', async () => {
  await withInstance(
    'dispose-throws',
    {},
    async ({ instance, logger }) => {
      instance.api.hook('checkstop', () => {
        throw new Error('stop boom');
      });
      await instance.start();
      await assert.doesNotReject(instance.dispose());
      assert.equal(logger.has('warn', 'hook checkstop from plugin failed: stop boom'), true);
      assert.equal(instance.store.closed, true);
    },
  );
});

test('store and notices are reachable through the api', async () => {
  await withInstance('notices', {}, async ({ instance }) => {
    instance.api.notice({ body: 'hello', level: 'warn' }).show();
    assert.equal(instance.api.health().notices, 1);
    assert.equal(instance.api.notice.since(0)[0].body, 'hello');
    assert.equal(instance.store.size, 1);
    instance.api.notice.push('pushed');
    assert.equal(instance.api.notice.snapshot().size, 2);
    instance.api.notice.clear();
    assert.equal(instance.api.health().notices, 0);
  });
});

test('require: an absent service is UNSUPPORTED with the plugin hint', async () => {
  await withInstance('require', { services: {} }, async ({ instance }) => {
    assert.throws(
      () => instance.api.require('workspaceRegistry'),
      (error) => {
        assert.equal(error.code, 'UNSUPPORTED');
        assert.equal(error.message, 'host service workspaceRegistry is not available on this DSH build');
        assert.equal(error.hint, 'pass a host service name such as "workspaceRegistry"');
        return true;
      },
    );
    assert.equal(instance.api.services().work, false);
  });
});

test('log: a throwing host logger never reaches the caller', async () => {
  const dir = makeTmpDir('log');
  try {
    const logger = {
      info() {
        throw new Error('logger boom');
      },
    };
    const { ctx } = fakeCtx(services(), { logger });
    const instance = createModapi({ ctx, dshHome: dir, logger, hostVersion: 'h' });
    assert.doesNotThrow(() => instance.api.log.info('hello'));
    assert.doesNotThrow(() => instance.api.log.warn('hello'));
    assert.doesNotThrow(() => instance.api.log.error('hello'));
    assert.doesNotThrow(() => instance.api.log.debug('hello'));
    await instance.dispose();
  } finally {
    removeTmpDir(dir);
  }
});

test('setBridgeProbe: the bridge probe feeds the self-check capability', async () => {
  await withInstance('probe', {}, async ({ instance }) => {
    instance.setBridgeProbe(() => 'failed: mount refused');
    const report = await instance.selfcheck.run({ notify: false, updateBaseline: false });
    assert.deepEqual(report.missing, [
      { id: 'notice.bridge', label: '公告 HTTP 桥', reason: 'bridge not mounted: failed: mount refused' },
    ]);
    instance.setBridgeProbe(() => true);
    const healthy = await instance.selfcheck.run({ notify: false, updateBaseline: false });
    assert.equal(healthy.missing.length, 0);
    instance.setBridgeProbe('not a function');
    const pending = await instance.selfcheck.run({ notify: false, updateBaseline: false });
    assert.equal(pending.missing.length, 0);
  });
});

test('unsupported host calls are counted by the self-check and announced once', async () => {
  await withInstance('unsupported', { services: {} }, async ({ instance, logger }) => {
    await assert.rejects(instance.api.work.list(), (error) => error.code === 'UNSUPPORTED');
    assert.equal(instance.selfcheck.failureCount, 1);
    const [failure] = instance.selfcheck.snapshot().failures;
    assert.equal(failure.key, 'work.list');
    assert.equal(failure.count, 1);
    await assert.rejects(instance.api.work.list(), (error) => error.code === 'UNSUPPORTED');
    assert.equal(instance.selfcheck.snapshot().failures[0].count, 2);
    assert.equal(instance.api.health().notices, 1);
    assert.equal(logger.has('warn', 'hook '), false);
  });
});
