import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COMBINERS, Event, EventBus } from '../lib/events.js';

test('exports the three combiners Fabric-style events need', () => {
  assert.deepEqual(COMBINERS, ['all', 'first', 'waterfall']);
});

test('all: listeners run in order, then in registration order', () => {
  const seen = [];
  const event = new Event('demo:all');
  event.register(() => seen.push('first'));
  event.register(() => seen.push('last'), { order: 10 });
  event.register(() => seen.push('early'), { order: -5 });
  event.fire();
  assert.deepEqual(seen, ['early', 'first', 'last']);
});

test('register returns a disposer that is safe to call twice', () => {
  const event = new Event('demo:dispose');
  let calls = 0;
  const dispose = event.register(() => { calls += 1; });
  event.fire();
  dispose();
  dispose();
  event.fire();
  assert.equal(calls, 1);
  assert.equal(event.size, 0);
});

test('all: a throwing listener is reported and the rest still run', () => {
  const errors = [];
  const event = new Event('demo:error', { onError: (error, context) => errors.push({ message: error.message, context }) });
  const seen = [];
  event.register(() => { throw new Error('boom'); });
  event.register(() => seen.push('after'));
  event.fire({ id: 1 });
  assert.deepEqual(seen, ['after']);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].message, 'boom');
  assert.equal(errors[0].context.source, 'plugin');
});

test('first: the earliest listener with a value wins and later ones are skipped', () => {
  const event = new Event('demo:first', { combiner: 'first' });
  event.register(() => undefined);
  event.register(() => 'winner');
  event.register(() => 'loser');
  assert.equal(event.fire(), 'winner');
});

test('waterfall: listeners wrap outward and each decides whether the chain continues', () => {
  // The last registered listener is the outermost one, so the payload flows in
  // through it first and unwinds back out through the earlier listeners.
  const sum = new Event('demo:waterfall', { combiner: 'waterfall' });
  sum.register((value, next) => next(value + 1));
  sum.register((value, next) => next(value * 2));
  assert.equal(sum.fire(3), 7);

  const stop = new Event('demo:stop', { combiner: 'waterfall' });
  stop.register((value) => value + 1);
  stop.register(() => 1000);
  assert.equal(stop.fire(3), 1000);
});

test('register: rejects a non-function and enforces the listener limit', () => {
  const event = new Event('demo:limit', { limit: 2 });
  assert.throws(() => event.register('nope'), /listener/);
  event.register(() => {});
  event.register(() => {});
  assert.throws(() => event.register(() => {}), /limit|full/i);
});

test('removeBySource: drops one script without touching the others', () => {
  const event = new Event('demo:source');
  event.register(() => {}, { source: 'script:a' });
  event.register(() => {}, { source: 'script:a' });
  event.register(() => {}, { source: 'plugin' });
  assert.equal(event.removeBySource('script:a'), 2);
  assert.equal(event.size, 1);
});

test('EventBus: create is unique, get/has/names follow, remove detaches', () => {
  const bus = new EventBus();
  const event = bus.create('demo:bus');
  assert.equal(bus.get('demo:bus'), event);
  assert.equal(bus.has('demo:bus'), true);
  assert.deepEqual(bus.names(), ['demo:bus']);
  assert.throws(() => bus.create('demo:bus'), /already/);
  assert.equal(bus.remove('demo:bus'), true);
  assert.equal(bus.remove('demo:bus'), false);
  assert.deepEqual(bus.names(), []);
});

test('EventBus: on() creates a missing event, fire() of an unknown event is undefined', () => {
  const bus = new EventBus();
  const seen = [];
  const dispose = bus.on('demo:on', (value) => seen.push(value));
  bus.fire('demo:on', 'payload');
  dispose();
  bus.fire('demo:on', 'again');
  assert.deepEqual(seen, ['payload']);
  assert.equal(bus.fire('demo:missing'), undefined);
});
