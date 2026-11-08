import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCompat } from '../lib/compat.js';
import { createSessionDomain, lastTitle, toSessionRecord, SESSION_SERVICES } from '../lib/domains/session.js';
import { fakeCtx } from './helpers.js';

function makeDomain(services, options) {
  const { ctx } = fakeCtx(services);
  return createSessionDomain(createCompat(ctx, null), options);
}

function titled(title) {
  return { type: 'session/title', title };
}

test('session constants and lastTitle', () => {
  assert.deepEqual([...SESSION_SERVICES], ['sessions', 'sessionStore']);
  assert.equal(lastTitle({ log: [{ type: 'session/start' }, titled('first'), { type: 'other' }] }), 'first');
  assert.equal(lastTitle({ log: [titled('first'), titled('second')] }), 'second');
  assert.equal(lastTitle({ log: [titled('first'), titled('')] }), 'first');
  assert.equal(lastTitle({ events: [{ kind: 'session/title', value: 'via-value' }] }), 'via-value');
  assert.equal(lastTitle({}), '');
  assert.equal(lastTitle({ log: 'nope' }), '');
});

test('toSessionRecord: title, cwd and header fallbacks', () => {
  const record = toSessionRecord({
    id: 's1',
    title: 'session-title',
    cwd: '/fallback',
    createdAt: '2024-01-02T03:04:05.000Z',
    log: [{ type: 'session/title', title: 'from-event' }, { type: 'message' }],
    header: {
      cwd: '/header-cwd',
      createdAt: '2024-02-03T00:00:00.000Z',
      parentSession: 'p1',
      agentPreset: 'dev',
      isSeeded: true,
      origin: 'host',
      delegationDepth: 2,
    },
  });
  assert.deepEqual(record, {
    id: 's1',
    title: 'from-event',
    cwd: '/header-cwd',
    createdAt: '2024-02-03T00:00:00.000Z',
    parentSession: 'p1',
    agentPreset: 'dev',
    isSeeded: true,
    origin: 'host',
    delegationDepth: 2,
    events: 2,
  });
  const empty = toSessionRecord({});
  assert.deepEqual(empty, {
    id: '',
    title: '',
    cwd: '',
    createdAt: '',
    parentSession: null,
    agentPreset: null,
    isSeeded: false,
    origin: null,
    delegationDepth: 0,
    events: 0,
  });
});

test('toSessionRecord: header id and session title fill the gaps', () => {
  const record = toSessionRecord({ header: { id: 'h1', title: 'header-title' }, title: 'session-title' });
  assert.equal(record.id, 'h1');
  assert.equal(record.title, 'session-title');
  assert.equal(toSessionRecord({ header: { id: 'h2', title: 'header-title' } }).title, 'header-title');
  assert.equal(toSessionRecord({ header: { isSeeded: 'true' } }).isSeeded, false);
  assert.equal(toSessionRecord({ header: { delegationDepth: '3' } }).delegationDepth, 0);
});

test('list: maps every session and rejects a non-array answer', async () => {
  const domain = makeDomain({
    sessions: {
      list: async () => [
        { id: 's1', log: [titled('A')] },
        { id: 's2', header: { title: 'B' } },
      ],
    },
  });
  const records = await domain.list();
  assert.deepEqual(records.map((item) => item.id), ['s1', 's2']);
  assert.deepEqual(records.map((item) => item.title), ['A', 'B']);
  assert.deepEqual(await domain.ids(), ['s1', 's2']);
  assert.equal(domain.all, domain.list);
  const broken = makeDomain({ sessions: { list: async () => ({}) } });
  await assert.rejects(broken.list(), (error) => {
    assert.equal(error.code, 'INTERNAL');
    assert.equal(error.message, 'sessions.list() did not return an array');
    return true;
  });
});

test('list: the sessionStore alias and all() are honoured', async () => {
  const domain = makeDomain({ sessionStore: { all: async () => [{ id: 's1' }] } });
  assert.deepEqual((await domain.list()).map((item) => item.id), ['s1']);
});

test('get: BAD_ARGUMENT without an id, null when absent, record when found', async () => {
  const domain = makeDomain({
    sessions: {
      get: async (id) => (id === 's1' ? { id: 's1', title: 'A' } : null),
    },
  });
  assert.equal((await domain.get('s1')).title, 'A');
  assert.equal(await domain.get('s2'), null);
  await assert.rejects(domain.get(''), (error) => {
    assert.equal(error.code, 'BAD_ARGUMENT');
    assert.equal(error.message, 'session.get(id) needs a session id');
    return true;
  });
  await assert.rejects(domain.get(null), (error) => error.code === 'BAD_ARGUMENT');
});

test('get: falls back to scanning list when the store has no get', async () => {
  const domain = makeDomain({
    sessions: {
      list: async () => [{ id: 's1', title: 'A' }, { id: 's2' }],
    },
  });
  assert.equal((await domain.get('s2')).id, 's2');
  assert.equal(await domain.get('s3'), null);
});

test('exists: true only when the record resolves', async () => {
  const domain = makeDomain({
    sessions: { get: async (id) => (id === 's1' ? { id: 's1' } : null) },
  });
  assert.equal(await domain.exists('s1'), true);
  assert.equal(await domain.exists('nope'), false);
});

test('current: null without an id, the record with one', async () => {
  const without = makeDomain({ sessions: { get: async () => ({ id: 's1' }) } });
  assert.equal(await without.current(), null);
  assert.equal(without.currentSessionId, undefined);
  const withId = makeDomain({ sessions: { get: async (id) => ({ id }) } }, { currentSessionId: 's7' });
  assert.equal((await withId.current()).id, 's7');
  assert.equal(withId.currentSessionId, 's7');
});

function messageDomain(messages) {
  return makeDomain({
    sessions: {
      get: async (id) => (id === 's1' ? { id: 's1', deriveMessages: async () => messages } : null),
    },
  });
}

test('messages: default limit keeps the last 200', async () => {
  const messages = Array.from({ length: 250 }, (_, index) => ({ role: 'user', index }));
  const domain = messageDomain(messages);
  const tail = await domain.messages('s1');
  assert.equal(tail.length, 200);
  assert.equal(tail[0].index, 50);
  assert.equal(tail[199].index, 249);
});

test('messages: an explicit limit slices the tail, zero and negatives mean all', async () => {
  const messages = Array.from({ length: 10 }, (_, index) => ({ index }));
  const domain = messageDomain(messages);
  assert.deepEqual((await domain.messages('s1', { limit: 3 })).map((item) => item.index), [7, 8, 9]);
  assert.equal((await domain.messages('s1', { limit: 0 })).length, 10);
  assert.equal((await domain.messages('s1', { limit: -4 })).length, 10);
  assert.equal((await domain.messages('s1', { limit: Number.NaN })).length, 10);
  assert.equal(await domain.count('s1'), 10);
});

test('messages: the 2000 cap holds', async () => {
  const messages = Array.from({ length: 2100 }, (_, index) => ({ index }));
  const domain = messageDomain(messages);
  const capped = await domain.messages('s1', { limit: 5000 });
  assert.equal(capped.length, 2000);
  assert.equal(capped[0].index, 100);
});

test('messages: JSON values are sanitised before leaving the domain', async () => {
  const domain = messageDomain([{ role: 'user', at: new Date('2024-01-01T00:00:00.000Z'), meta: new Map([['k', 'v']]) }]);
  const [message] = await domain.messages('s1');
  assert.equal(message.at, '2024-01-01T00:00:00.000Z');
  assert.deepEqual(message.meta, { k: 'v' });
});

test('messages: a missing session is NOT_FOUND, a missing deriveMessages UNSUPPORTED', async () => {
  const domain = messageDomain([]);
  await assert.rejects(domain.messages('nope'), (error) => {
    assert.equal(error.code, 'NOT_FOUND');
    assert.equal(error.message, 'no session with id "nope"');
    return true;
  });
  const noDerive = makeDomain({ sessions: { get: async () => ({ id: 's1' }) } });
  await assert.rejects(noDerive.messages('s1'), (error) => {
    assert.equal(error.code, 'UNSUPPORTED');
    assert.match(error.message, /deriveMessages/);
    return true;
  });
  const broken = makeDomain({ sessions: { get: async () => ({ id: 's1', deriveMessages: async () => 'nope' }) } });
  await assert.rejects(broken.messages('s1'), (error) => {
    assert.equal(error.code, 'INTERNAL');
    assert.equal(error.message, 'deriveMessages() did not return an array');
    return true;
  });
});

test('flush: forwards the host entity and reports success', async () => {
  const seen = [];
  const entity = { id: 's1' };
  const domain = makeDomain({
    sessions: {
      get: async () => entity,
      flush: async (target) => {
        seen.push(target);
      },
    },
  });
  assert.equal(await domain.flush('s1'), true);
  assert.deepEqual(seen, [entity]);
});

test('a missing session service is UNSUPPORTED', async () => {
  const domain = makeDomain({});
  await assert.rejects(domain.list(), (error) => {
    assert.equal(error.code, 'UNSUPPORTED');
    assert.match(error.message, /sessions \| sessionStore/);
    return true;
  });
});
