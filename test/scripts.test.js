import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { HookRegistry } from '../lib/hooks.js';
import { createScriptHost, discoverScripts, scriptDirectories } from '../lib/scripts.js';
import { makeLogger, makeTmpDir, removeTmpDir } from './helpers.js';

const DEMO = `function checkstart() {
  modapi.hook('demo-fired', () => {});
}
`;

/** The script-visible api surface; `hook` writes into the same registry. */
function fakeApi(hooks) {
  return {
    version: '1',
    name: 'dsh-modapi',
    work: { surface: 'work' },
    session: { surface: 'session' },
    tool: { surface: 'tool' },
    fs: { surface: 'fs' },
    notice: { surface: 'notice' },
    toast: { surface: 'toast' },
    公告: { surface: '公告' },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    hook: (name, handler, options) => hooks.on(name, handler, options),
  };
}

function writeScript(dshHome, name, source) {
  const target = path.join(dshHome, 'modapi', 'scripts', name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, source);
  return target;
}

function makeHost(dshHome, overrides = {}) {
  const logger = overrides.logger ?? makeLogger();
  const hooks = overrides.hooks ?? new HookRegistry({ logger });
  const host = createScriptHost({
    api: overrides.api ?? fakeApi(hooks),
    hooks,
    logger,
    dshHome,
    cwd: dshHome,
    config: { scriptDirs: [], scripts: [], ...(overrides.config ?? {}) },
  });
  return { host, hooks, logger };
}

/** Runs `body` with a fresh script home; always disposes and removes the tree. */
async function withHost(label, body, overrides = {}) {
  const dir = makeTmpDir(label);
  let built;
  try {
    built = makeHost(dir, overrides);
    await body({ dir, ...built });
  } finally {
    built?.host.dispose();
    removeTmpDir(dir);
  }
}

test('scriptDirectories: dsh home first, then resolved extras, deduped', async () => {
  const dir = makeTmpDir('dirs');
  try {
    const dirs = scriptDirectories({
      dshHome: dir,
      cwd: dir,
      scriptDirs: ['extra', 'extra', '', null, 'sub/../extra'],
    });
    assert.deepEqual(dirs, [path.join(dir, 'modapi', 'scripts'), path.resolve(dir, 'extra')]);
    assert.deepEqual(scriptDirectories({}), []);
    assert.deepEqual(scriptDirectories({ dshHome: '', scriptDirs: 'nope' }), []);
  } finally {
    removeTmpDir(dir);
  }
});

test('discoverScripts: only .js files, sorted, missing dirs skipped, explicit scripts appended', async () => {
  const dir = makeTmpDir('discover');
  try {
    writeScript(dir, 'b.js', '');
    writeScript(dir, 'a.js', '');
    const loose = path.join(dir, 'loose', 'c.js');
    fs.mkdirSync(path.dirname(loose), { recursive: true });
    fs.writeFileSync(loose, '');
    fs.writeFileSync(path.join(dir, 'modapi', 'scripts', 'notes.txt'), '');

    const found = discoverScripts({
      dshHome: dir,
      cwd: dir,
      scriptDirs: ['missing-dir'],
      scripts: ['modapi/scripts/a.js', 'loose/c.js'],
    });
    const scriptDir = path.join(dir, 'modapi', 'scripts');
    assert.deepEqual(found, [path.join(scriptDir, 'a.js'), path.join(scriptDir, 'b.js'), loose]);
  } finally {
    removeTmpDir(dir);
  }
});

test('load: registers top-level hook functions and records the file', async () => {
  await withHost('load', async ({ dir, host, hooks, logger }) => {
    const file = writeScript(dir, 'demo.js', DEMO);
    const files = await host.load();

    assert.equal(files.length, 1);
    const record = files[0];
    assert.equal(record.file, file);
    assert.equal(record.name, 'demo.js');
    assert.equal(record.source, `script:${file}`);
    assert.deepEqual(record.hooks, ['checkstart']);
    assert.equal(record.size, Buffer.byteLength(DEMO));
    assert.match(record.at, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(host.size, 1);
    assert.equal(hooks.count('checkstart'), 1);
    assert.equal(logger.has('info', 'demo.js registered: checkstart'), true);
    const wire = hooks.describe().find((entry) => entry.name === 'checkstart');
    assert.deepEqual(wire.sources, [`script:${file}`]);
  });
});

test('load: firing the prelude hook runs script code inside the sandbox', async () => {
  await withHost('fire', async ({ dir, host, hooks }) => {
    writeScript(dir, 'demo.js', DEMO);
    await host.load();
    assert.equal(hooks.count('demo-fired'), 0);
    await hooks.fire('checkstart', {});
    assert.equal(hooks.count('demo-fired'), 1);
  });
});

test('load: the sandbox exposes the documented globals', async () => {
  await withHost('globals', async ({ dir, host, hooks, logger }) => {
    writeScript(
      dir,
      'globals.js',
      `const ok = [
        typeof modapi === 'object',
        typeof work === 'object' && work.surface === 'work',
        typeof session === 'object' && typeof tool === 'object' && typeof fs === 'object',
        typeof notice === 'object' && typeof toast === 'object' && typeof 公告 === 'object',
        typeof sleep === 'function' && typeof log === 'function',
        typeof __filename === 'string' && __filename.endsWith('globals.js'),
        typeof __dirname === 'string' && __dirname.endsWith('scripts'),
        typeof __source === 'string' && __source.includes('const ok'),
      ];
      if (ok.every(Boolean)) modapi.hook('globals-ok', () => {});
      console.log('from script');
    `,
    );
    await host.load();
    assert.equal(hooks.count('globals-ok'), 1);
    assert.equal(logger.has('info', 'from script'), true);
  });
});

test('load: a runtime failure warns and is not recorded, and leaves no subscriptions', async () => {
  await withHost('boom', async ({ dir, host, hooks, logger }) => {
    const file = writeScript(
      dir,
      'bad.js',
      `modapi.hook('bad-hook', () => {}, { source: 'script:' + __filename });\nthrow new Error('boom');\n`,
    );
    const files = await host.load();
    assert.deepEqual(files, []);
    assert.equal(host.size, 0);
    assert.equal(hooks.count('bad-hook'), 0);
    assert.equal(logger.has('warn', `[dsh-modapi] script ${file} failed: boom`), true);
  });
});

test('load: a failing script leaks no subscriber even without an explicit source', async () => {
  await withHost('unsourced', async ({ dir, host, hooks }) => {
    writeScript(dir, 'leaky.js', `modapi.hook('leaky', () => {});
throw new Error('late');
`);
    assert.deepEqual(await host.load(), []);
    assert.equal(hooks.count('leaky'), 0);
    assert.deepEqual(hooks.names(), []);
  });
});

test('load: a compile failure warns and is not recorded', async () => {
  await withHost('syntax', async ({ dir, host, logger }) => {
    const file = writeScript(dir, 'broken.js', 'function (');
    assert.deepEqual(await host.load(), []);
    assert.equal(logger.has('warn', `[dsh-modapi] cannot compile script ${file}`), true);
  });
});

test('load: an unreadable explicit script warns without failing the whole load', async () => {
  await withHost(
    'missing',
    async ({ dir, host, logger }) => {
      writeScript(dir, 'good.js', 'function checkstart() {}\n');
      const files = await host.load();
      assert.equal(files.length, 1);
      assert.equal(files[0].name, 'good.js');
      assert.equal(logger.has('warn', `[dsh-modapi] cannot read script ${path.join(dir, 'nope.js')}`), true);
    },
    { config: { scripts: ['nope.js'] } },
  );
});

test('files: returns copies, so callers cannot corrupt the registry', async () => {
  await withHost('copies', async ({ dir, host }) => {
    writeScript(dir, 'demo.js', DEMO);
    await host.load();
    const [record] = host.files();
    record.hooks.push('forged');
    record.name = 'changed.js';
    const [again] = host.files();
    assert.deepEqual(again.hooks, ['checkstart']);
    assert.equal(again.name, 'demo.js');
  });
});

test('reload: replaces the record without duplicating subscriptions', async () => {
  await withHost('reload', async ({ dir, host, hooks }) => {
    const file = writeScript(dir, 'demo.js', DEMO);
    await host.load();
    fs.writeFileSync(file, `${DEMO}function checkstop() {}\n`);
    const record = await host.reload(file);
    assert.equal(record.name, 'demo.js');
    assert.deepEqual(record.hooks, ['checkstart', 'checkstop']);
    assert.equal(hooks.count('checkstart'), 1);
    assert.equal(hooks.count('checkstop'), 1);
    assert.equal(host.files().length, 1);
  });
});

test('reload: a script that starts failing drops its old subscriptions', async () => {
  await withHost('reload-bad', async ({ dir, host, hooks }) => {
    const file = writeScript(dir, 'demo.js', DEMO);
    await host.load();
    assert.equal(hooks.count('checkstart'), 1);
    fs.writeFileSync(file, 'throw new Error("later");\n');
    assert.equal(await host.reload(file), null);
    assert.equal(hooks.count('checkstart'), 0);
    assert.equal(host.size, 0);
  });
});

test('unload: removes a loaded script and reports unknown files', async () => {
  await withHost('unload', async ({ dir, host, hooks }) => {
    const file = writeScript(dir, 'demo.js', DEMO);
    await host.load();
    assert.equal(host.unload(path.join(dir, 'other.js')), false);
    assert.equal(host.unload(file), true);
    assert.equal(host.size, 0);
    assert.equal(hooks.count('checkstart'), 0);
    assert.equal(host.unload(file), false);
  });
});

test('watch: one watcher per existing script directory, idempotent, closed by dispose', async () => {
  await withHost('watch', async ({ dir, host }) => {
    writeScript(dir, 'demo.js', DEMO);
    await host.load();
    assert.equal(host.watch(), 1);
    assert.equal(host.watch(), 1);
  });
});

test('watchScripts: true starts the watcher during load', async () => {
  await withHost(
    'watch-auto',
    async ({ dir, host }) => {
      writeScript(dir, 'demo.js', DEMO);
      await host.load();
      assert.equal(host.watch(), 1);
    },
    { config: { watchScripts: true } },
  );
});

test('dispose: unloads every script and clears hook subscriptions', async () => {
  await withHost('dispose', async ({ dir, host, hooks }) => {
    writeScript(dir, 'one.js', 'function checkstart() {}\n');
    writeScript(dir, 'two.js', 'function checkstop() {}\n');
    await host.load();
    assert.equal(host.size, 2);
    host.dispose();
    assert.equal(host.size, 0);
    assert.deepEqual(host.files(), []);
    assert.equal(hooks.count('checkstart'), 0);
    assert.equal(hooks.count('checkstop'), 0);
  });
});
