import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_NAMESPACE, Registry, RegistryManager, parseId, splitId } from '../lib/registry.js';

test('parseId: a bare name lands in the default namespace', () => {
  assert.equal(DEFAULT_NAMESPACE, 'modapi');
  assert.equal(parseId('help'), 'modapi:help');
  assert.equal(parseId('mymod:item/iron'), 'mymod:item/iron');
  assert.deepEqual(splitId('mymod:item/iron'), { namespace: 'mymod', path: 'item/iron' });
});

test('parseId: rejects ids a registry could never resolve consistently', () => {
  for (const bad of ['', '   ', 'Uppercase', 'a:b:c', 'mod api:item', ':item']) {
    assert.throws(() => parseId(bad), (error) => error.code === 'BAD_ARGUMENT', String(bad));
  }
});

test('register/get/has: values are addressed by id, not by insertion order', () => {
  const registry = new Registry('items');
  registry.register('iron', { kind: 'metal' });
  assert.equal(registry.get('modapi:iron').kind, 'metal');
  assert.equal(registry.has('modapi:iron'), true);
  assert.equal(registry.has('modapi:gold'), false);
  assert.equal(registry.get('modapi:gold', 'fallback'), 'fallback');
  assert.deepEqual(registry.keys(), ['modapi:iron']);
});

test('register: a duplicate id needs replace, and the limit is enforced', () => {
  const registry = new Registry('items', { limit: 2 });
  registry.register('a', 1);
  assert.throws(() => registry.register('a', 2), (error) => error.code === 'CONFLICT');
  registry.register('a', 2, { replace: true });
  assert.equal(registry.get('a'), 2);
  registry.register('b', 3);
  assert.throws(() => registry.register('c', 4), (error) => error.code === 'CONFLICT');
});

test('list/values: expose the current content in insertion order', () => {
  const registry = new Registry('items');
  registry.register('a', { v: 1 });
  registry.register('b', { v: 2 });
  assert.deepEqual(registry.values(), [{ v: 1 }, { v: 2 }]);
  assert.deepEqual(registry.list().map((entry) => entry.id), ['modapi:a', 'modapi:b']);
  registry.remove('a');
  assert.deepEqual(registry.keys(), ['modapi:b']);
  registry.clear();
  assert.equal(registry.size, 0);
});

test('describe: reports name, size and keys', () => {
  const registry = new Registry('items');
  registry.register('a', 1);
  const described = registry.describe();
  assert.equal(described.name, 'items');
  assert.equal(described.size, 1);
  assert.deepEqual(described.keys, ['modapi:a']);
});

test('RegistryManager: create is unique, use() creates on demand', () => {
  const manager = new RegistryManager();
  manager.create('items');
  assert.throws(() => manager.create('items'), (error) => error.code === 'CONFLICT');
  const same = manager.get('items');
  assert.equal(manager.use('items'), same);
  assert.ok(manager.use('blocks'));
  assert.deepEqual(manager.names(), ['items', 'blocks']);
  assert.equal(manager.remove('blocks'), true);
  assert.deepEqual(manager.names(), ['items']);
});

test('RegistryManager: a repeated create with replace swaps the whole registry', () => {
  const manager = new RegistryManager();
  manager.create('items').register('a', 1);
  const fresh = manager.create('items', { replace: true });
  assert.equal(fresh.size, 0);
  assert.equal(manager.get('items'), fresh);
});
