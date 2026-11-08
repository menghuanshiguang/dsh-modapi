import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NoticeStore, Toast, NOTICE_LEVELS, createNoticeFactory } from '../lib/notices.js';
import { delay } from './helpers.js';

test('NOTICE_LEVELS: the four presentation levels', () => {
  assert.deepEqual([...NOTICE_LEVELS], ['info', 'success', 'warn', 'error']);
  assert.equal(Object.isFrozen(NOTICE_LEVELS), true);
});

test('normalize: a string is the body, defaults fill the rest', () => {
  const store = new NoticeStore();
  assert.deepEqual(store.normalize('hello'), { title: '', body: 'hello', level: 'info', duration: 0, kind: 'modapi.notice' });
});

test('normalize: object fields and the text/message aliases', () => {
  const store = new NoticeStore();
  assert.deepEqual(
    store.normalize({ title: 'T', body: 'B', level: 'warn', duration: 1500.9, kind: 'demo' }),
    { title: 'T', body: 'B', level: 'warn', duration: 1500, kind: 'demo' },
  );
  assert.equal(store.normalize({ text: 'by-text' }).body, 'by-text');
  assert.equal(store.normalize({ message: 'by-message' }).body, 'by-message');
  assert.equal(store.normalize({ body: 'b', kind: '' }).kind, 'modapi.notice');
  assert.equal(store.normalize({ body: 'b', level: 'loud' }).level, 'info');
  assert.equal(store.normalize({ body: 'b', duration: -5 }).duration, 0);
});

test('normalize: an empty notice is BAD_ARGUMENT', () => {
  const store = new NoticeStore();
  for (const input of ['', '   ', {}, { title: '  ', body: '' }, null, 7]) {
    assert.throws(() => store.normalize(input), (error) => {
      assert.equal(error.code, 'BAD_ARGUMENT');
      assert.equal(error.domain, 'notice');
      assert.equal(error.message, 'a notice needs a title or a body');
      return true;
    });
  }
});

test('push: record shape, monotonic id and seq, timestamp from the clock', () => {
  const store = new NoticeStore({ now: () => 1700000000000 });
  const first = store.push({ title: 'T', body: 'B' });
  const second = store.push('second');
  assert.equal(first.id, 'notice-1');
  assert.equal(second.id, 'notice-2');
  assert.equal(first.seq, 1);
  assert.equal(second.seq, 2);
  assert.equal(first.at, 1700000000000);
  assert.equal(store.seq, 2);
  assert.equal(store.size, 2);
  assert.equal(store.since(0)[1].body, 'second');
});

test('push: custom id prefix is honoured', () => {
  const store = new NoticeStore({ idPrefix: 'modapi' });
  assert.equal(store.push('x').id, 'modapi-1');
});

test('push: the limit drops the oldest notices', () => {
  const store = new NoticeStore({ limit: 2 });
  store.push('a');
  store.push('b');
  store.push('c');
  assert.equal(store.size, 2);
  assert.deepEqual(store.since(0).map((item) => item.body), ['b', 'c']);
  assert.equal(store.seq, 3);
});

test('push: the default limit is 64', () => {
  const store = new NoticeStore();
  for (let index = 0; index < 70; index += 1) store.push(`n${index}`);
  assert.equal(store.size, 64);
  assert.equal(store.since(0)[0].body, 'n6');
});

test('prune: drops notices older than the ttl', () => {
  let clock = 1000;
  const store = new NoticeStore({ ttlMs: 100, now: () => clock });
  store.push('a');
  clock = 1075;
  store.push('b');
  assert.equal(store.size, 2);
  clock = 1110;
  assert.equal(store.prune(), 1);
  assert.deepEqual(store.since(0).map((item) => item.body), ['b']);
});

test('prune: a ttl boundary is inclusive and prune returns the size', () => {
  let clock = 1000;
  const store = new NoticeStore({ ttlMs: 100, now: () => clock });
  store.push('a');
  clock = 1100;
  assert.equal(store.prune(), 1);
  clock = 1101;
  assert.equal(store.prune(), 0);
});

test('since: cursor filtering and defensive copies', () => {
  const store = new NoticeStore();
  store.push('a');
  store.push('b');
  assert.deepEqual(store.since(0).map((item) => item.body), ['a', 'b']);
  assert.deepEqual(store.since(1).map((item) => item.body), ['b']);
  assert.deepEqual(store.since(5), []);
  assert.deepEqual(store.since(Number.NaN).map((item) => item.body), ['a', 'b']);
  const copy = store.since(0);
  copy[0].body = 'mutated';
  assert.equal(store.since(0)[0].body, 'a');
});

test('update: rewrites a stored notice and reports unknown ids', () => {
  const store = new NoticeStore();
  const record = store.push('a');
  assert.equal(store.update(record.id, { body: 'b', level: 'success' }), true);
  const [updated] = store.since(0);
  assert.equal(updated.body, 'b');
  assert.equal(updated.level, 'success');
  assert.equal(updated.seq, record.seq);
  assert.equal(store.update('notice-404', { body: 'nope' }), false);
});

test('update: clearing both title and body is BAD_ARGUMENT', () => {
  const store = new NoticeStore();
  const record = store.push({ title: 'T' });
  assert.throws(() => store.update(record.id, { title: '' }), (error) => error.code === 'BAD_ARGUMENT');
});

test('ack: removes listed ids and counts only real removals', () => {
  const store = new NoticeStore();
  const first = store.push('a');
  store.push('b');
  assert.equal(store.ack([first.id, 42, 'notice-404']), 1);
  assert.equal(store.size, 1);
  assert.deepEqual(store.since(0).map((item) => item.body), ['b']);
  assert.equal(store.ack([]), 0);
  assert.equal(store.ack('notice-2'), 0);
});

test('wait: resolves immediately when the cursor is behind', async () => {
  const store = new NoticeStore();
  store.push('a');
  const started = Date.now();
  const ready = await store.wait(0, 5000);
  assert.equal(ready.length, 1);
  assert.ok(Date.now() - started < 100, 'wait must not park when items are ready');
});

test('wait: an empty store parks for the budget and resolves []', async () => {
  const store = new NoticeStore();
  const started = Date.now();
  const ready = await store.wait(0, 50);
  const elapsed = Date.now() - started;
  assert.deepEqual(ready, []);
  assert.ok(elapsed >= 40, `expected to wait, elapsed ${elapsed}`);
});

test('wait: a push wakes a parked poll with the new notices', async () => {
  const store = new NoticeStore();
  const pending = store.wait(store.seq, 5000);
  await delay(10);
  store.push('wake-me');
  const ready = await pending;
  assert.equal(ready.length, 1);
  assert.equal(ready[0].body, 'wake-me');
});

test('wait: a zero, negative or non-finite budget returns at once', async () => {
  const store = new NoticeStore();
  assert.deepEqual(await store.wait(0, 0), []);
  assert.deepEqual(await store.wait(0, -10), []);
  assert.deepEqual(await store.wait(0, Number.NaN), []);
  assert.deepEqual(await store.wait(0), []);
});

test('wake: reports how many parked polls it woke', async () => {
  const store = new NoticeStore();
  assert.equal(store.wake(), 0);
  const first = store.wait(0, 5000);
  const second = store.wait(0, 5000);
  const cursor = store.seq;
  store.push('a');
  assert.equal(await first.then((items) => items.length), 1);
  assert.equal(await second.then((items) => items.length), 1);
  assert.equal(store.wake(), 0);
  assert.ok(cursor >= 0);
});

test('clear: empties the queue and keeps the sequence', () => {
  const store = new NoticeStore();
  store.push('a');
  store.push('b');
  assert.equal(store.clear(), true);
  assert.equal(store.size, 0);
  assert.equal(store.seq, 2);
  assert.deepEqual(store.since(0), []);
});

test('close: resolves parked polls with [] and stops storing', async () => {
  const store = new NoticeStore();
  store.push('a');
  const pending = store.wait(store.seq, 5000);
  store.close();
  assert.deepEqual(await pending, []);
  assert.equal(store.closed, true);
  assert.equal(store.size, 0);
  const record = store.push('after-close');
  assert.equal(record.seq, 2);
  assert.equal(store.size, 0);
  assert.deepEqual(await store.wait(0, 10), []);
});

test('snapshot: sequence, size and copies of the items', () => {
  const store = new NoticeStore();
  store.push('a');
  const snapshot = store.snapshot();
  assert.equal(snapshot.seq, 1);
  assert.equal(snapshot.size, 1);
  assert.deepEqual(snapshot.items.map((item) => item.body), ['a']);
  snapshot.items[0].body = 'mutated';
  assert.equal(store.since(0)[0].body, 'a');
});

test('Toast: a single string becomes the body; accessors read it back', () => {
  const store = new NoticeStore();
  const toast = new Toast(store, '正文');
  assert.equal(toast.body(), '正文');
  assert.equal(toast.title(), '');
  assert.equal(toast.id, null);
  assert.equal(store.size, 0);
  const returned = toast.title('标题').body('改过');
  assert.equal(returned, toast);
  assert.equal(toast.title(), '标题');
  assert.equal(toast.body(), '改过');
});

test('Toast: title + body + options form reaches the record', () => {
  const store = new NoticeStore();
  const record = new Toast(store, '标题', '正文', { level: 'warn', duration: 1500, kind: 'demo' }).show();
  assert.equal(record.title, '标题');
  assert.equal(record.body, '正文');
  assert.equal(record.level, 'warn');
  assert.equal(record.duration, 1500);
  assert.equal(record.kind, 'demo');
  assert.equal(store.size, 1);
});

test('Toast: object forms merge title, body and options', () => {
  const store = new NoticeStore();
  const record = new Toast(store, { title: 'T', body: 'B' }, { level: 'success' }).show();
  assert.equal(record.title, 'T');
  assert.equal(record.body, 'B');
  assert.equal(record.level, 'success');
  assert.deepEqual(Toast.options('正文'), { title: '', body: '正文', level: 'info', duration: 0, kind: 'modapi.notice' });
});

test('Toast: repeated show() updates the same record in place', () => {
  const store = new NoticeStore();
  const toast = new Toast(store, '正文');
  const first = toast.show();
  const second = toast.show({ level: 'error' });
  assert.equal(first.id, second.id);
  assert.equal(second.level, 'error');
  assert.equal(store.size, 1);
  assert.equal(store.since(0)[0].id, first.id);
  assert.equal(toast.id, first.id);
});

test('Toast: set() before show() only edits options, after show() writes through', () => {
  const store = new NoticeStore();
  const toast = new Toast(store, '正文');
  toast.set({ body: 'before-show' });
  assert.equal(store.size, 0);
  toast.show();
  assert.equal(store.since(0)[0].body, 'before-show');
  toast.set({ body: 'after-show', title: '标题' });
  assert.equal(store.size, 1);
  assert.equal(store.since(0)[0].body, 'after-show');
  assert.equal(store.since(0)[0].title, '标题');
});

test('Toast: close() acks the record and is idempotent', () => {
  const store = new NoticeStore();
  const toast = new Toast(store, '正文');
  assert.equal(toast.close(), false);
  toast.show();
  assert.equal(store.size, 1);
  assert.equal(toast.close(), true);
  assert.equal(store.size, 0);
  assert.equal(toast.id, null);
  assert.equal(toast.close(), false);
});

test('Toast: an empty notice throws on show, not on construction', () => {
  const store = new NoticeStore();
  const toast = new Toast(store, '   ');
  assert.equal(store.size, 0);
  assert.throws(() => toast.show(), (error) => error.code === 'BAD_ARGUMENT');
  assert.equal(store.size, 0);
});

test('Toast: toJSON carries the options and the live id', () => {
  const store = new NoticeStore();
  const toast = new Toast(store, '正文');
  assert.deepEqual(toast.toJSON(), { title: '', body: '正文', level: 'info', duration: 0, kind: 'modapi.notice', id: null });
  toast.show();
  assert.equal(toast.toJSON().id, 'notice-1');
});

test('createNoticeFactory: callable factory plus the store surface', () => {
  const store = new NoticeStore();
  const factory = createNoticeFactory(store);
  assert.equal(typeof factory, 'function');
  assert.equal(factory.store, store);
  assert.deepEqual(factory.levels, NOTICE_LEVELS);
  assert.equal(factory.Toast, Toast);
  assert.equal(factory.toast, factory);
  assert.ok(factory('正文') instanceof Toast);
  const record = factory.show('提示');
  assert.equal(record.body, '提示');
  assert.equal(store.size, 1);
  factory.push('pushed');
  assert.equal(factory.since(0).length, 2);
  assert.equal(factory.snapshot().size, 2);
  assert.equal(factory.clear(), true);
  assert.equal(store.size, 0);
});
