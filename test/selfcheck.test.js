import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createCompat } from '../lib/compat.js';
import { CAPABILITIES, STATE_SCHEMA, createSelfCheck } from '../lib/selfcheck.js';
import { fakeCtx, makeLogger, makeTmpDir, removeTmpDir } from './helpers.js';

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

function makeNotices() {
  const pushed = [];
  const shown = [];
  const factory = (input) => {
    const record = {
      ...input,
      show() {
        shown.push(this);
      },
    };
    pushed.push(record);
    return record;
  };
  factory.pushed = pushed;
  factory.shown = shown;
  return factory;
}

function setup(overrides = {}) {
  const dir = makeTmpDir('selfcheck');
  const { ctx } = fakeCtx(services(overrides.services));
  const logger = makeLogger();
  const notices = overrides.notices ?? makeNotices();
  const selfcheck = createSelfCheck({
    compat: createCompat(ctx, logger),
    notices,
    logger,
    dshHome: dir,
    hostVersion: overrides.hostVersion ?? 'host-1',
    probeBridge: overrides.probeBridge,
    statePath: overrides.statePath,
  });
  return { dir, selfcheck, notices, logger };
}

async function withSelfCheck(overrides, body) {
  const built = setup(overrides);
  try {
    await body(built);
  } finally {
    removeTmpDir(built.dir);
  }
}

function readBaseline(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

test('CAPABILITIES: ten frozen capabilities with unique ids and labels', () => {
  assert.equal(STATE_SCHEMA, 1);
  assert.equal(Object.isFrozen(CAPABILITIES), true);
  assert.equal(CAPABILITIES.length, 10);
  const ids = CAPABILITIES.map((capability) => capability.id);
  assert.deepEqual(ids, [
    'work.list',
    'work.create',
    'session.list',
    'session.get',
    'tool.list',
    'fs.resolve',
    'fs.read',
    'fs.write',
    'fs.list',
    'notice.bridge',
  ]);
  for (const capability of CAPABILITIES) {
    assert.equal(typeof capability.label, 'string');
    assert.notEqual(capability.label, '');
    assert.equal(Array.isArray(capability.services), true);
    assert.equal(Array.isArray(capability.methods), true);
  }
});

test('run: a fully wired host passes and writes the baseline', async () => {
  await withSelfCheck({}, async ({ dir, selfcheck }) => {
    const report = await selfcheck.run();
    assert.equal(report.ok, true);
    assert.equal(report.checked, 10);
    assert.deepEqual(report.missing, []);
    assert.deepEqual(report.regressed, []);
    assert.equal(report.statePath, path.join(dir, 'modapi', 'state', 'contract.json'));
    assert.match(report.at, /^\d{4}-\d{2}-\d{2}T/);

    const baseline = readBaseline(report.statePath);
    assert.equal(baseline.schemaVersion, STATE_SCHEMA);
    assert.equal(baseline.apiVersion, '1');
    assert.equal(baseline.host, 'host-1');
    assert.equal(Object.keys(baseline.capabilities).length, 10);
    assert.deepEqual(new Set(Object.values(baseline.capabilities)), new Set(['ok']));
  });
});

test('run: a missing method fails only the capability that needs it', async () => {
  await withSelfCheck({}, async ({ dir, selfcheck }) => {
    const dir2 = makeTmpDir('selfcheck-deep');
    try {
      const { ctx } = fakeCtx(services({ workspaceRegistry: { list: async () => [] } }));
      const logger = makeLogger();
      const notices = makeNotices();
      const narrow = createSelfCheck({ compat: createCompat(ctx, logger), notices, logger, dshHome: dir2 });
      const report = await narrow.run();
      assert.equal(report.ok, false);
      assert.deepEqual(report.missing, [
        { id: 'work.create', label: '新建工作区', reason: 'method missing: create' },
      ]);
      assert.deepEqual(report.regressed, []);
      assert.equal(notices.pushed.length, 0);
      assert.equal(fs.existsSync(report.statePath), false);
      assert.equal(logger.has('warn', 'self-check: work.create (method missing: create)'), true);

      const shallow = await narrow.run({ deep: false, notify: false });
      assert.equal(shallow.ok, true);
    } finally {
      removeTmpDir(dir2);
    }
  });
});

test('run: a missing service names every alias it looked for', async () => {
  await withSelfCheck({ services: { tools: undefined } }, async ({ selfcheck, notices }) => {
    const report = await selfcheck.run();
    assert.equal(report.ok, false);
    assert.deepEqual(report.missing, [{ id: 'tool.list', label: '工具清单', reason: 'service missing: tools' }]);
    assert.equal(notices.pushed.length, 0);

    const { ctx } = fakeCtx(services({ fs: undefined }));
    const logger = makeLogger();
    const noFs = createSelfCheck({ compat: createCompat(ctx, logger), notices: makeNotices(), logger });
    const fsReport = await noFs.run({ notify: false });
    assert.deepEqual(
      fsReport.missing.map((item) => [item.id, item.reason]),
      [
        ['fs.resolve', 'service missing: fs | filesystem'],
        ['fs.read', 'service missing: fs | filesystem'],
        ['fs.write', 'service missing: fs | filesystem'],
        ['fs.list', 'service missing: fs | filesystem'],
      ],
    );
  });
});

test('run: a capability that worked in the baseline and now fails is a regression with a notice', async () => {
  const dir = makeTmpDir('selfcheck-regress');
  try {
    const healthy = services();
    const { ctx: ctxA } = fakeCtx(healthy);
    const first = createSelfCheck({ compat: createCompat(ctxA, null), dshHome: dir, hostVersion: 'host-1' });
    assert.equal((await first.run()).ok, true);

    const broken = { ...healthy, workspaceRegistry: { list: async () => [] } };
    const { ctx: ctxB } = fakeCtx(broken);
    const notices = makeNotices();
    const logger = makeLogger();
    const second = createSelfCheck({
      compat: createCompat(ctxB, logger),
      notices,
      logger,
      dshHome: dir,
      hostVersion: 'host-2',
    });
    const report = await second.run();
    assert.equal(report.ok, false);
    assert.deepEqual(report.regressed, [
      { id: 'work.create', label: '新建工作区', reason: 'method missing: create' },
    ]);
    assert.equal(notices.pushed.length, 1);
    const notice = notices.pushed[0];
    assert.equal(notice.level, 'error');
    assert.equal(notice.title, 'modapi：接口失效（DSH 升级后）');
    assert.equal(notice.kind, 'modapi.selfcheck');
    assert.equal(notice.duration, 0);
    assert.match(notice.body, /DSH host-1 → host-2/);
    assert.match(notice.body, /新建工作区（work\.create）：method missing: create/);
    assert.equal(notices.shown.length, 1);

    const baseline = readBaseline(report.statePath);
    assert.equal(baseline.host, 'host-1', 'a regression must not overwrite the last good baseline');
  } finally {
    removeTmpDir(dir);
  }
});

test('run: notify false suppresses the notice and logs instead', async () => {
  const dir = makeTmpDir('selfcheck-quiet');
  try {
    const { ctx: ctxA } = fakeCtx(services());
    await createSelfCheck({ compat: createCompat(ctxA, null), dshHome: dir }).run();
    const { ctx: ctxB } = fakeCtx(services({ tools: undefined }));
    const notices = makeNotices();
    const logger = makeLogger();
    const check = createSelfCheck({ compat: createCompat(ctxB, logger), notices, logger, dshHome: dir });
    const report = await check.run({ notify: false });
    assert.equal(report.regressed.length, 1);
    assert.equal(notices.pushed.length, 0);
    assert.equal(logger.has('warn', 'self-check: tool.list (service missing: tools)'), true);
  } finally {
    removeTmpDir(dir);
  }
});

test('run: updateBaseline false leaves the state file untouched', async () => {
  const dir = makeTmpDir('selfcheck-nobase');
  try {
    const { ctx } = fakeCtx(services());
    const check = createSelfCheck({ compat: createCompat(ctx, null), dshHome: dir });
    const report = await check.run({ updateBaseline: false });
    assert.equal(report.ok, true);
    assert.equal(fs.existsSync(report.statePath), false);
    assert.equal(check.snapshot().baseline, null);
  } finally {
    removeTmpDir(dir);
  }
});

test('run: an unwritable baseline is warned about and does not fail the check', async () => {
  const dir = makeTmpDir('selfcheck-eacces');
  try {
    fs.writeFileSync(path.join(dir, 'modapi'), 'not a directory');
    const { ctx } = fakeCtx(services());
    const logger = makeLogger();
    const check = createSelfCheck({ compat: createCompat(ctx, logger), logger, dshHome: dir });
    const report = await check.run();
    assert.equal(report.ok, true);
    assert.equal(logger.has('warn', '[dsh-modapi] cannot write contract baseline:'), true);
    assert.equal(check.snapshot().baseline, null);
  } finally {
    removeTmpDir(dir);
  }
});

test('run: a corrupt or foreign baseline is ignored instead of crashing', async () => {
  const dir = makeTmpDir('selfcheck-corrupt');
  try {
    const statePath = path.join(dir, 'modapi', 'state', 'contract.json');
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    const { ctx } = fakeCtx(services());
    const check = createSelfCheck({ compat: createCompat(ctx, null), dshHome: dir, statePath });
    for (const text of ['{not json', '[]', JSON.stringify({ schemaVersion: 99, capabilities: { 'tool.list': 'ok' } })]) {
      fs.writeFileSync(statePath, text);
      const report = await check.run({ notify: false });
      assert.equal(report.ok, true);
      assert.deepEqual(report.regressed, []);
    }
  } finally {
    removeTmpDir(dir);
  }
});

test('notice.bridge: pending, mounted and broken probes', async () => {
  const dir = makeTmpDir('selfcheck-bridge');
  try {
    const { ctx } = fakeCtx(services());
    const logger = makeLogger();
    const pending = createSelfCheck({ compat: createCompat(ctx, logger), logger, dshHome: dir });
    assert.equal((await pending.run({ notify: false })).ok, true);

    const { ctx: ctxUp } = fakeCtx(services());
    const up = createSelfCheck({ compat: createCompat(ctxUp, logger), dshHome: dir, probeBridge: () => true });
    assert.equal((await up.run({ notify: false })).ok, true);

    const { ctx: ctxDown } = fakeCtx(services());
    const notices = makeNotices();
    const down = createSelfCheck({
      compat: createCompat(ctxDown, logger),
      notices,
      logger,
      dshHome: dir,
      probeBridge: () => 'failed: mount refused',
    });
    const report = await down.run();
    assert.deepEqual(report.missing, [
      { id: 'notice.bridge', label: '公告 HTTP 桥', reason: 'bridge not mounted: failed: mount refused' },
    ]);
  } finally {
    removeTmpDir(dir);
  }
});

test('noteUnsupported: counts every hit, announces only the first', async () => {
  await withSelfCheck({}, async ({ selfcheck, notices }) => {
    const info = { domain: 'work', method: 'list', message: 'no workspace service' };
    assert.equal(selfcheck.noteUnsupported(info), 1);
    assert.equal(selfcheck.noteUnsupported(info), 2);
    assert.equal(selfcheck.noteUnsupported(info), 3);

    assert.equal(notices.pushed.length, 1);
    const notice = notices.pushed[0];
    assert.equal(notice.level, 'error');
    assert.equal(notice.title, 'modapi：接口不可用');
    assert.equal(notice.kind, 'modapi.failure');
    assert.match(notice.body, /work\.list 在当前 DSH 版本上不可用/);
    assert.match(notice.body, /no workspace service/);

    assert.equal(selfcheck.failureCount, 1);
    const [entry] = selfcheck.snapshot().failures;
    assert.equal(entry.key, 'work.list');
    assert.equal(entry.count, 3);
    assert.equal(entry.message, 'no workspace service');
    selfcheck.resetFailures();
    assert.equal(selfcheck.failureCount, 0);
    assert.deepEqual(selfcheck.snapshot().failures, []);
  });
});

test('noteUnsupported: missing domain and method collapse to ?.?', async () => {
  await withSelfCheck({}, async ({ selfcheck, notices }) => {
    assert.equal(selfcheck.noteUnsupported(), 1);
    assert.equal(notices.pushed[0].body, '?.? 在当前 DSH 版本上不可用');
  });
});

test('noteUnsupported: a throwing notice factory is swallowed and logged', async () => {
  await withSelfCheck(
    {
      notices: () => {
        throw new Error('notice exploded');
      },
    },
    async ({ selfcheck, logger }) => {
      assert.equal(selfcheck.noteUnsupported({ domain: 'fs', method: 'read' }), 1);
      assert.equal(logger.has('warn', '[dsh-modapi] cannot announce unsupported method: notice exploded'), true);
      assert.equal(selfcheck.noteUnsupported({ domain: 'fs', method: 'read' }), 2);
    },
  );
});

test('snapshot and labelOf: baseline, last report and label fallbacks', async () => {
  await withSelfCheck({}, async ({ selfcheck }) => {
    assert.equal(selfcheck.snapshot().last, null);
    assert.equal(selfcheck.snapshot().baseline, null);
    assert.equal(selfcheck.labelOf('work.list'), '工作区列表');
    assert.equal(selfcheck.labelOf('made.up'), 'made.up');
    const report = await selfcheck.run();
    assert.equal(selfcheck.snapshot().last, report);
    assert.equal(selfcheck.snapshot().baseline.host, 'host-1');
    assert.equal(selfcheck.statePath, report.statePath);
  });
});
