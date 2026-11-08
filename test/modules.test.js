import { test } from 'node:test';
import assert from 'node:assert/strict';
import { API_MODULES, MODULE_VERSION, ModuleRegistry } from '../lib/modules.js';

test('a fresh registry carries every documented API module at the current version', () => {
  const modules = new ModuleRegistry({ apiVersion: '1' });
  assert.equal(modules.apiVersion, '1');
  assert.deepEqual(modules.names(), Object.keys(API_MODULES));
  for (const name of modules.names()) {
    assert.equal(modules.get(name).version, MODULE_VERSION);
    assert.equal(modules.get(name).source, 'builtin');
  }
});

test('require: a satisfied range returns the matched modules', () => {
  const modules = new ModuleRegistry({ apiVersion: '1' });
  assert.deepEqual(modules.require({ work: '^1.0.0', fs: '>=1.0.0 <2.0.0' }), [
    { name: 'work', version: '1.0.0' },
    { name: 'fs', version: '1.0.0' },
  ]);
  assert.equal(modules.supports({ work: '^1.0.0' }), true);
});

test('require: every unmet range is listed in one UNSUPPORTED error', () => {
  const modules = new ModuleRegistry({ apiVersion: '1' });
  assert.throws(
    () => modules.require({ work: '^2.0.0', nope: '^1.0.0' }, { context: 'demo' }),
    (error) => {
      assert.equal(error.code, 'UNSUPPORTED');
      assert.match(error.message, /demo needs API modules it cannot get/);
      assert.match(error.message, /work 1\.0\.0 does not satisfy \^2\.0\.0/);
      assert.match(error.message, /nope \(missing\) does not satisfy \^1\.0\.0/);
      assert.equal(error.detail.failures.length, 2);
      assert.equal(modules.supports({ work: '^2.0.0' }), false);
      return true;
    },
  );
});

test('require: a malformed spec or range is BAD_ARGUMENT, not UNSUPPORTED', () => {
  const modules = new ModuleRegistry();
  assert.throws(() => modules.require(null), (error) => error.code === 'BAD_ARGUMENT');
  assert.throws(() => modules.require({ work: '^' }), (error) => error.code === 'BAD_ARGUMENT');
});

test('provide: a plugin may publish its own module and later replace it', () => {
  const modules = new ModuleRegistry();
  const record = modules.provide('demo', '0.3.0', { source: 'demo-mod' });
  assert.deepEqual(record, { name: 'demo', version: '0.3.0', deprecated: false, note: '', source: 'demo-mod' });
  assert.equal(modules.get('demo').version, '0.3.0');
  modules.provide('demo', '0.4.0', { deprecated: true, note: 'use demo2' });
  assert.equal(modules.get('demo').version, '0.4.0');
  assert.equal(modules.get('demo').deprecated, true);
  assert.equal(modules.get('demo').note, 'use demo2');
});

test('provide: rejects bad names and versions', () => {
  const modules = new ModuleRegistry();
  assert.throws(() => modules.provide('', '1.0.0'), (error) => error.code === 'BAD_ARGUMENT');
  assert.throws(() => modules.provide('demo', 'nope'), (error) => error.code === 'BAD_ARGUMENT');
});

test('describe: reports apiVersion plus a copy of every module', () => {
  const modules = new ModuleRegistry({ apiVersion: '3' });
  const described = modules.describe();
  assert.equal(described.apiVersion, '3');
  assert.equal(described.modules.length, Object.keys(API_MODULES).length);
  described.modules[0].version = 'tampered';
  assert.equal(modules.list()[0].version, MODULE_VERSION);
});

test('list: omits the API face and reports hasValue', () => {
  const modules = new ModuleRegistry();
  const face = { read: () => 'x' };
  modules.provide('demo', '1.0.0', { value: face });
  const entry = modules.list().find((item) => item.name === 'demo');
  assert.equal(entry.hasValue, true);
  assert.equal('value' in entry, false);
  assert.equal(modules.get('demo').value, face);
  assert.equal(modules.list().find((item) => item.name === 'work').hasValue, false);
});
