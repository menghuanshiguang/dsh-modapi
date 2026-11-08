import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readField, toId, toText, toISO, toStringArray, toJSONValue, pick } from '../lib/json.js';

test('readField: first non-null alias wins', () => {
  assert.equal(readField({ a: null, b: 0, c: 'c' }, ['a', 'b', 'c']), 0);
  assert.equal(readField({ a: '', b: 'b' }, ['a', 'b']), '');
  assert.equal(readField({}, ['a']), undefined);
  assert.equal(readField(null, ['a']), undefined);
  assert.equal(readField(undefined, ['a']), undefined);
});

test('readField: a throwing getter counts as absent', () => {
  const source = {
    get a() {
      throw new Error('boom');
    },
    get b() {
      return 'b';
    },
  };
  assert.equal(readField(source, ['a', 'b']), 'b');
  assert.equal(readField(source, ['a']), undefined);
});

test('toId/toText: strings and finite numbers only', () => {
  assert.equal(toId('s'), 's');
  assert.equal(toId(7), '7');
  assert.equal(toId(Number.NaN), '');
  assert.equal(toId(Infinity), '');
  assert.equal(toId({}), '');
  assert.equal(toId(null), '');
  assert.equal(toText(true), '');
  assert.equal(toText(0), '0');
});

test('toISO: ISO strings, Dates and finite timestamps; empty otherwise', () => {
  assert.equal(toISO('2020-01-02T03:04:05.000Z'), '2020-01-02T03:04:05.000Z');
  assert.equal(toISO(new Date('2020-01-02T03:04:05.000Z')), '2020-01-02T03:04:05.000Z');
  assert.equal(toISO(0), '1970-01-01T00:00:00.000Z');
  assert.equal(toISO(new Date('nope')), '');
  assert.equal(toISO(Number.NaN), '');
  assert.equal(toISO(undefined), '');
  assert.equal(toISO(null), '');
  assert.equal(toISO(true), '');
  assert.equal(toISO({}), '');
});

test('toStringArray: usable ids survive, empty ids do not', () => {
  assert.deepEqual(toStringArray(['a', 2, '', null, undefined, {}, Number.NaN]), ['a', '2']);
  assert.deepEqual(toStringArray('a'), []);
  assert.deepEqual(toStringArray(null), []);
  assert.deepEqual(toStringArray([]), []);
});

test('toJSONValue: primitives and special values', () => {
  assert.equal(toJSONValue(null), null);
  assert.equal(toJSONValue(undefined), null);
  assert.equal(toJSONValue('x'), 'x');
  assert.equal(toJSONValue(3), 3);
  assert.equal(toJSONValue(false), false);
  assert.equal(toJSONValue(10n), '10');
  assert.equal(toJSONValue(() => {}), null);
  assert.equal(toJSONValue(Symbol('s')), null);
  assert.equal(toJSONValue(new Date(0)), '1970-01-01T00:00:00.000Z');
  assert.equal(toJSONValue(new Date('nope')), '');
});

test('toJSONValue: Error, Map, Set and class instances', () => {
  const error = Object.assign(new Error('boom'), { code: 'FS_IO_ERROR' });
  assert.deepEqual(toJSONValue(error), { name: 'Error', message: 'boom', code: 'FS_IO_ERROR' });
  assert.deepEqual(toJSONValue(new Error('bare')), { name: 'Error', message: 'bare', code: null });
  assert.deepEqual(toJSONValue(new Map([['a', 1], ['b', { c: 2 }]])), { a: 1, b: { c: 2 } });
  assert.deepEqual(toJSONValue(new Set([1, 2])), [1, 2]);
  class Thing {
    constructor() {
      this.x = 1;
    }
    get y() {
      return 2;
    }
  }
  assert.deepEqual(toJSONValue(new Thing()), { x: 1 });
});

test('toJSONValue: cycles, depth cap and item cap', () => {
  const cyclic = { name: 'root' };
  cyclic.self = cyclic;
  assert.deepEqual(toJSONValue(cyclic), { name: 'root', self: '[circular]' });
  assert.deepEqual(toJSONValue({ a: { b: { c: 1 } } }, { maxDepth: 1 }), { a: '[depth]' });
  assert.deepEqual(toJSONValue([1, 2, 3], { maxItems: 2 }), [1, 2]);
  assert.deepEqual(toJSONValue(new Map([['a', 1], ['b', 2]]), { maxItems: 1 }), { a: 1 });
  assert.deepEqual(toJSONValue(new Set([1, 2, 3]), { maxItems: 2 }), [1, 2]);
});

test('toJSONValue: a throwing getter becomes null, siblings survive', () => {
  const source = {
    ok: 1,
    get bad() {
      throw new Error('boom');
    },
  };
  assert.deepEqual(toJSONValue(source), { ok: 1, bad: null });
});

test('pick: named fields through their readers', () => {
  const out = pick({ a: 1, b: 'x' }, ['a', 'b', 'c'], { a: (value) => value + 1 });
  assert.deepEqual(out, { a: 2, b: 'x', c: undefined });
  assert.deepEqual(pick(null, ['a']), { a: undefined });
});
