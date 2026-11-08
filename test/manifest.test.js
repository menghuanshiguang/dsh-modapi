import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { MANIFEST_NAME, discoverMods, readManifest, scanModRoot, validateManifest } from '../lib/manifest.js';
import { makeTmpDir, removeTmpDir } from './helpers.js';

const FILE = path.join('D:', 'mods', 'demo', MANIFEST_NAME);

test('validateManifest: fills defaults and resolves entrypoints against the manifest dir', () => {
  const manifest = validateManifest(
    { id: 'demo', version: '1.2', entrypoints: { start: 'main.js', stop: ['stop.js'] } },
    { file: FILE },
  );
  assert.equal(manifest.id, 'demo');
  assert.equal(manifest.version, '1.2.0');
  assert.equal(manifest.name, 'demo');
  assert.deepEqual(manifest.entrypoints.start, [path.resolve(path.dirname(FILE), 'main.js')]);
  assert.deepEqual(manifest.entrypoints.stop, [path.resolve(path.dirname(FILE), 'stop.js')]);
  assert.deepEqual(manifest.requires, {});
  assert.deepEqual(manifest.depends, {});
});

test('validateManifest: an explicit name wins over the id', () => {
  const manifest = validateManifest({ id: 'demo', version: '1.0.0', name: '  Demo Mod  ', entrypoints: { start: 'main.js' } }, { file: FILE });
  assert.equal(manifest.name, 'Demo Mod');
});

test('validateManifest: rejects the manifests that would break the loader', () => {
  const cases = [
    [{ version: '1.0.0' }, /id/],
    [{ id: 'Bad Id', version: '1.0.0' }, /id/],
    [{ id: 'demo' }, /version/],
    [{ id: 'demo', version: '1.0.0' }, /entrypoints.start/],
    [{ id: 'demo', version: '1.0.0', entrypoints: { start: [1] } }, /entrypoints/],
    [{ id: 'demo', version: '1.0.0', entrypoints: { boot: 'main.js' } }, /known entrypoint/],
    [{ id: 'demo', version: '1.0.0', entrypoints: { start: 'main.js' }, requires: { work: 1 } }, /range string/],
    [{ id: 'demo', version: '1.0.0', entrypoints: { start: 'main.js' }, depends: 'other' }, /object/],
  ];
  for (const [raw, pattern] of cases) {
    assert.throws(() => validateManifest(raw, { file: FILE }), (error) => error.code === 'BAD_ARGUMENT' && pattern.test(error.message), JSON.stringify(raw));
  }
});

test('readManifest: missing file is NOT_FOUND, broken JSON is BAD_ARGUMENT', () => {
  const dir = makeTmpDir('manifest');
  try {
    assert.throws(() => readManifest(path.join(dir, 'nope.json')), (error) => error.code === 'NOT_FOUND');
    const broken = path.join(dir, MANIFEST_NAME);
    fs.writeFileSync(broken, '{ nope');
    assert.throws(() => readManifest(broken), (error) => error.code === 'BAD_ARGUMENT');
    fs.writeFileSync(broken, JSON.stringify({ id: 'demo', version: '1.0.0', entrypoints: { start: 'main.js' } }));
    assert.equal(readManifest(broken).id, 'demo');
  } finally {
    removeTmpDir(dir);
  }
});

test('scanModRoot: one manifest per directory, sorted, missing roots are empty', () => {
  const dir = makeTmpDir('scan');
  try {
    for (const name of ['b-mod', 'a-mod']) {
      fs.mkdirSync(path.join(dir, name), { recursive: true });
      fs.writeFileSync(path.join(dir, name, MANIFEST_NAME), JSON.stringify({ id: name, version: '1.0.0', entrypoints: { start: 'main.js' } }));
    }
    fs.mkdirSync(path.join(dir, 'no-manifest'));
    fs.writeFileSync(path.join(dir, 'loose.json'), '{}');
    assert.deepEqual(scanModRoot(dir).map((file) => path.basename(path.dirname(file))), ['a-mod', 'b-mod']);
    assert.deepEqual(scanModRoot(path.join(dir, 'absent')), []);
  } finally {
    removeTmpDir(dir);
  }
});

test('discoverMods: keeps good manifests, reports bad ones, rejects duplicate ids', () => {
  const home = makeTmpDir('discover');
  try {
    const mods = path.join(home, 'modapi', 'mods');
    for (const name of ['one', 'two']) {
      fs.mkdirSync(path.join(mods, name), { recursive: true });
      fs.writeFileSync(path.join(mods, name, MANIFEST_NAME), JSON.stringify({ id: name, version: '1.0.0', entrypoints: { start: 'main.js' } }));
    }
    fs.mkdirSync(path.join(mods, 'broken'), { recursive: true });
    fs.writeFileSync(path.join(mods, 'broken', MANIFEST_NAME), '{ nope');
    const errors = [];
    const found = discoverMods({ dshHome: home, cwd: home, onError: (error, detail) => errors.push(detail.file) });
    assert.deepEqual(found.map((manifest) => manifest.id), ['one', 'two']);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /broken/);

    const extra = makeTmpDir('discover-extra');
    try {
      fs.mkdirSync(path.join(extra, 'dup'), { recursive: true });
      fs.writeFileSync(path.join(extra, 'dup', MANIFEST_NAME), JSON.stringify({ id: 'one', version: '2.0.0', entrypoints: { start: 'main.js' } }));
      const dupErrors = [];
      // The broken manifest in the home root is reported again; only the
      // duplicate from the extra root is this assertion's business.
      const found = discoverMods({ dshHome: home, modDirs: [extra], cwd: home, onError: (error, detail) => dupErrors.push({ error, detail }) });
      const duplicates = dupErrors.filter((entry) => /duplicate/i.test(entry.error.message));
      assert.equal(duplicates.length, 1);
      assert.match(duplicates[0].error.message, /duplicate mod id "one"/);
      assert.deepEqual(found.map((manifest) => manifest.id), ['one', 'two']);
    } finally {
      removeTmpDir(extra);
    }
  } finally {
    removeTmpDir(home);
  }
});
