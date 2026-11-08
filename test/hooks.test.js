import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HookRegistry, HOOK_NAMES, WIRED_HOOKS } from '../lib/hooks.js';
import { makeLogger, delay } from './helpers.js';

test('hook constants: eleven names, eight wired', () => {
  assert.equal(HOOK_NAMES.length, 11);
  assert.equal(WIRED_HOOKS.length, 8);
  assert.equal(Object.isFrozen(HOOK_NAMES), true);
  assert.equal(Object.isFrozen(WIRED_HOOKS), true);
  assert.deepEqual(
    [...HOOK_NAMES].sort(),
    ['checkstart', 'checkstop', 'messagereceive', 'onerror', 'pluginload', 'pluginunload', 'sessionarchive', 'sessioncreate', 'sessiondelete', 'toolcall', 'toolresult'],
  );
  for (const name of WIRED_HOOKS) assert.equal(HOOK_NAMES.includes(name), true, name);
});

test('on: returns a disposer that removes exactly that subscriber', () => {
  const registry = new HookRegistry();
  const handler = () => {};
  const off = registry.on('checkstart', handler);
  assert.equal(typeof off, 'function');
  assert.equal(registry.count('checkstart'), 1);
  assert.equal(registry.has('checkstart'), true);
  assert.equal(registry.off('checkstart', handler), true);
  assert.equal(registry.count('checkstart'), 0);
  assert.equal(registry.has('checkstart'), false);
  assert.equal(registry.off('checkstart', handler), false);
});

test('on: invalid names and handlers are BAD_ARGUMENT', () => {
  const registry = new HookRegistry();
  for (const name of ['', null, undefined, 7]) {
    assert.throws(() => registry.on(name, () => {}), (error) => error.code === 'BAD_ARGUMENT');
  }
  for (const handler of [null, undefined, 'nope', 7]) {
    assert.throws(() => registry.on('checkstart', handler), (error) => error.code === 'BAD_ARGUMENT');
  }
});

test('on: the default per-name limit is 64', () => {
  const registry = new HookRegistry();
  for (let index = 0; index < 64; index += 1) registry.on('toolcall', () => index);
  assert.equal(registry.count('toolcall'), 64);
  assert.throws(
    () => registry.on('toolcall', () => 'overflow'),
    (error) => error.code === 'CONFLICT' && /already has 64 subscribers \(limit 64\)/.test(error.message) && /hookLimitPerName/.test(error.hint),
  );
});

test('on: a lower limit throws CONFLICT with the configured number', () => {
  const registry = new HookRegistry({ limitPerName: 2 });
  registry.on('x', () => 1);
  registry.on('x', () => 2);
  assert.throws(() => registry.on('x', () => 3), (error) => error.code === 'CONFLICT' && error.message.includes('limit 2'));
});

test('fire: subscribers run in order-then-insertion order', async () => {
  const registry = new HookRegistry();
  const seen = [];
  registry.on('x', () => seen.push('b'), { order: 5 });
  registry.on('x', () => seen.push('a'), { order: -1 });
  registry.on('x', () => seen.push('c'));
  registry.on('x', () => seen.push('c2'));
  const result = await registry.fire('x');
  assert.deepEqual(seen, ['a', 'c', 'c2', 'b']);
  assert.equal(result.fired, 4);
  assert.equal(result.failed, 0);
});

test('fire: one throwing subscriber does not stop the others', async () => {
  const logger = makeLogger();
  const registry = new HookRegistry({ logger });
  registry.on('toolcall', () => {
    throw new Error('boom');
  }, { source: 'src-a' });
  registry.on('toolcall', async () => 'second', { source: 'src-b' });
  const result = await registry.fire('toolcall', { n: 1 });
  assert.equal(result.hook, 'toolcall');
  assert.equal(result.fired, 2);
  assert.equal(result.failed, 1);
  assert.deepEqual(result.results, [undefined, 'second']);
  assert.equal(logger.has('warn', 'hook toolcall from src-a failed: boom'), true);
});

test('fire: awaits each subscriber before starting the next', async () => {
  const registry = new HookRegistry();
  const seen = [];
  registry.on('x', async () => {
    seen.push('a-start');
    await delay(5);
    seen.push('a-end');
  });
  registry.on('x', () => seen.push('b'));
  await registry.fire('x');
  assert.deepEqual(seen, ['a-start', 'a-end', 'b']);
});

test('fire: failures are forwarded to onerror with hook, source and error', async () => {
  const registry = new HookRegistry();
  const seen = [];
  registry.on('onerror', (payload) => seen.push(payload));
  registry.on('toolresult', () => {
    throw new Error('boom');
  }, { source: 'script:/a.js' });
  const result = await registry.fire('toolresult');
  assert.equal(result.failed, 1);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].hook, 'toolresult');
  assert.equal(seen[0].source, 'script:/a.js');
  assert.equal(seen[0].error.message, 'boom');
});

test('fire: a throwing onerror handler is logged, not re-entered', async () => {
  const logger = makeLogger();
  const registry = new HookRegistry({ logger });
  registry.on('onerror', () => {
    throw new Error('report boom');
  });
  registry.on('toolcall', () => {
    throw new Error('boom');
  });
  const result = await registry.fire('toolcall');
  assert.equal(result.failed, 1);
  assert.equal(logger.has('warn', 'onerror handler from plugin failed: report boom'), true);
});

test('fire: an unknown hook fires nothing', async () => {
  const registry = new HookRegistry();
  assert.deepEqual(await registry.fire('nothing-here', {}), { hook: 'nothing-here', fired: 0, failed: 0, results: [] });
});

test('fireAll: fires every registered hook and returns one result per name', async () => {
  const registry = new HookRegistry();
  registry.on('checkstart', () => 'start');
  registry.on('toolcall', () => 'call');
  const all = await registry.fireAll({ k: 1 });
  assert.equal(all.checkstart.fired, 1);
  assert.deepEqual(all.checkstart.results, ['start']);
  assert.deepEqual(all.toolcall.results, ['call']);
});

test('describe: every hook name, wired flags and sources', () => {
  const registry = new HookRegistry();
  registry.on('checkstart', () => {}, { source: 'plugin' });
  registry.on('toolcall', () => {}, { source: 'script:/x.js' });
  registry.on('demo-fired', () => {}, { source: 'plugin' });
  const described = registry.describe();
  const byName = new Map(described.map((item) => [item.name, item]));
  assert.equal(described.length, HOOK_NAMES.length + 1);
  assert.deepEqual(
    described.filter((item) => item.wired).map((item) => item.name).sort(),
    [...WIRED_HOOKS].sort(),
  );
  assert.equal(byName.get('checkstart').count, 1);
  assert.deepEqual(byName.get('checkstart').sources, ['plugin']);
  assert.deepEqual(byName.get('toolcall').sources, ['script:/x.js']);
  assert.equal(byName.get('sessionarchive').wired, false);
  assert.equal(byName.get('sessionarchive').count, 0);
  assert.equal(byName.get('demo-fired').wired, false);
});

test('removeBySource: only the matching source loses its subscribers', async () => {
  const registry = new HookRegistry();
  let pluginFired = 0;
  registry.on('toolcall', () => {
    pluginFired += 1;
  }, { source: 'plugin' });
  registry.on('toolcall', () => {}, { source: 'script:/a.js' });
  registry.on('toolresult', () => {}, { source: 'plugin' });
  assert.equal(registry.removeBySource('plugin'), 2);
  assert.equal(registry.count('toolcall'), 1);
  assert.equal(registry.count('toolresult'), 0);
  await registry.fire('toolcall');
  assert.equal(pluginFired, 0);
  assert.equal(registry.removeBySource('plugin'), 0);
});

test('clear: drops every subscriber and every name', async () => {
  const registry = new HookRegistry();
  registry.on('checkstart', () => {});
  registry.on('toolcall', () => {});
  registry.clear();
  assert.equal(registry.count('checkstart'), 0);
  assert.equal(registry.count('toolcall'), 0);
  const result = await registry.fire('checkstart');
  assert.equal(result.fired, 0);
});
