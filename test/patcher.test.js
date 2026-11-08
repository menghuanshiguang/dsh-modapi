import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Patcher, createPatcher } from '../lib/patcher.js';
import { makeLogger } from './helpers.js';

test('method: before can rewrite args, after can rewrite the result', () => {
  const patcher = new Patcher({ logger: makeLogger() });
  const target = { sum(a, b) { return a + b; } };
  patcher.method(target, 'sum', {
    before(args) { args[0] *= 10; },
    after(result) { return result * 2; },
  });
  assert.equal(target.sum(1, 2), 24);
  patcher.restoreAll();
  assert.equal(target.sum(1, 2), 3);
});

test('method: a before hook returning false cancels the call and skips after hooks', () => {
  const patcher = new Patcher({ logger: makeLogger() });
  const target = { value() { return 'original'; } };
  const controller = patcher.method(target, 'value', {
    before() { return false; },
    after(value) { return value + '!'; },
  });
  assert.equal(target.value(), undefined);
  controller.disable();
  assert.equal(target.value(), 'original');
});

test('method: replace wins over the original and still runs after hooks', () => {
  const patcher = new Patcher({ logger: makeLogger() });
  const target = { greet(name) { return 'hello ' + name; } };
  patcher.method(target, 'greet', {
    replace(args) { return 'replaced ' + args[0]; },
    after(value) { return value.toUpperCase(); },
  });
  assert.equal(target.greet('x'), 'REPLACED X');
});

test('method: an async original keeps its thenable and awaits after hooks', async () => {
  const patcher = new Patcher({ logger: makeLogger() });
  const target = { async double(n) { return n * 2; } };
  patcher.method(target, 'double', { after(value) { return value + 1; } });
  assert.equal(await target.double(5), 11);
});

test('method: restoring a prototype method leaves no own property behind', () => {
  const patcher = new Patcher({ logger: makeLogger() });
  class Service { ping() { return 'pong'; } }
  const instance = new Service();
  const controller = patcher.method(instance, 'ping', { before() {} });
  assert.equal(Object.prototype.hasOwnProperty.call(instance, 'ping'), true);
  controller.restore();
  assert.equal(Object.prototype.hasOwnProperty.call(instance, 'ping'), false);
  assert.equal(instance.ping(), 'pong');
});

test('method: a throwing hook is reported and does not break the call', () => {
  const logger = makeLogger();
  const patcher = new Patcher({ logger });
  const target = { read() { return 7; } };
  patcher.method(target, 'read', { before() { throw new Error('boom'); }, after(value) { return value + 1; } });
  assert.equal(target.read(), 8);
  assert.equal(patcher.list()[0].errors, 1);
  assert.equal(logger.has('warn', 'before hook failed'), true);
});

test('method: non-function keys and empty specs are rejected', () => {
  const patcher = createPatcher({ logger: makeLogger() });
  assert.throws(() => patcher.method({}, 'missing', { before() {} }), /not a function/);
  assert.throws(() => patcher.method({ go() {} }, 'go', {}), /at least one/);
  assert.throws(() => patcher.method(null, 'go', { before() {} }), /object or function/);
});

test('method: restoreBySource removes only that source and clears empty entries', () => {
  const patcher = new Patcher({ logger: makeLogger() });
  const target = { a() { return 'a'; }, b() { return 'b'; } };
  patcher.method(target, 'a', { source: 'script:x', before() {} });
  patcher.method(target, 'b', { source: 'plugin', before() {} });
  assert.equal(patcher.restoreBySource('script:x'), 1);
  assert.equal(patcher.list().length, 1);
  assert.equal(target.a(), 'a');
  assert.equal(target.b(), 'b');
});

test('method: the patch limit is enforced with CONFLICT', () => {
  const patcher = new Patcher({ limit: 1, logger: makeLogger() });
  const target = { a() {}, b() {} };
  patcher.method(target, 'a', { before() {} });
  assert.throws(() => patcher.method(target, 'b', { before() {} }), /limit/);
});
