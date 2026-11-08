import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCompat } from '../lib/compat.js';
import { createWorkDomain, normalizePath, toWorkspaceRecord, WORK_SERVICES } from '../lib/domains/work.js';
import { fakeCtx } from './helpers.js';

function makeDomain(services) {
  const { ctx } = fakeCtx(services);
  return createWorkDomain(createCompat(ctx, null));
}

class HostWorkspace {
  constructor(fields) {
    this.fields = fields;
  }

  get workspaceId() {
    return this.fields.id;
  }

  get name() {
    return this.fields.name;
  }

  get dir() {
    return this.fields.dir;
  }

  get created() {
    return this.fields.created;
  }

  get updated() {
    return this.fields.updated;
  }

  get sessions() {
    return this.fields.sessions;
  }
}

test('work constants and normalizePath', () => {
  assert.deepEqual([...WORK_SERVICES], ['workspaceRegistry']);
  assert.equal(normalizePath('C:\\Work\\Proj\\'), 'c:/work/proj');
  assert.equal(normalizePath('/a/b///'), '/a/b');
  assert.equal(normalizePath(''), '');
  assert.equal(normalizePath(42), '');
  assert.equal(normalizePath(null), '');
});

test('toWorkspaceRecord: aliases, getters and defaults', () => {
  const created = new Date('2024-05-06T07:08:09.000Z');
  const record = toWorkspaceRecord(
    new HostWorkspace({ id: 'w1', name: 'Demo', dir: 'D:\\work\\demo', created, sessions: ['s1', 7, ''] }),
  );
  assert.deepEqual(record, {
    id: 'w1',
    title: 'Demo',
    path: 'D:\\work\\demo',
    createdAt: '2024-05-06T07:08:09.000Z',
    updatedAt: '',
    sessionIds: ['s1', '7'],
  });
  assert.deepEqual(toWorkspaceRecord({}), { id: '', title: '', path: '', createdAt: '', updatedAt: '', sessionIds: [] });
});

test('list: maps host entities to flat records', async () => {
  const work = makeDomain({
    workspaceRegistry: {
      list: async () => [new HostWorkspace({ id: 'w1', name: 'A', dir: '/a' }), new HostWorkspace({ id: 'w2', name: 'B', dir: '/b' })],
    },
  });
  assert.deepEqual((await work.list()).map((item) => item.id), ['w1', 'w2']);
  assert.deepEqual(await work.paths(), ['/a', '/b']);
  assert.equal(await work.count(), 2);
});

test('list: a non-array answer is INTERNAL', async () => {
  const work = makeDomain({ workspaceRegistry: { list: async () => 'nope' } });
  await assert.rejects(work.list(), (error) => {
    assert.equal(error.code, 'INTERNAL');
    assert.equal(error.message, 'workspaceRegistry.list() did not return an array');
    return true;
  });
});

test('get: uses the service getter, null for a missing entity, BAD_ARGUMENT without an id', async () => {
  const entity = { id: 'w1', title: 'A', path: '/a' };
  const work = makeDomain({
    workspaceRegistry: {
      list: async () => [],
      get: async (id) => (id === 'w1' ? entity : null),
    },
  });
  assert.equal((await work.get('w1')).title, 'A');
  assert.equal(await work.get('missing'), null);
  await assert.rejects(work.get(''), (error) => error.code === 'BAD_ARGUMENT');
  await assert.rejects(work.get(7), (error) => error.code === 'BAD_ARGUMENT');
});

test('get: falls back to the list when the service has no getter', async () => {
  const work = makeDomain({
    workspaceRegistry: {
      list: async () => [{ id: 'w1', title: 'A', path: '/a' }],
    },
  });
  assert.equal((await work.get('w1')).title, 'A');
  assert.equal(await work.get('w2'), null);
});

test('findByPath: slashes, trailing slash and case are normalised', async () => {
  const work = makeDomain({
    workspaceRegistry: {
      list: async () => [
        { id: 'w1', title: 'A', path: 'D:\\Work\\Demo' },
        { id: 'w2', title: 'B', path: '/srv/app/' },
      ],
    },
  });
  assert.equal((await work.findByPath('d:/work/demo')).id, 'w1');
  assert.equal((await work.findByPath('/srv/app')).id, 'w2');
  assert.equal(await work.findByPath('d:/work/other'), null);
  await assert.rejects(work.findByPath(''), (error) => error.code === 'BAD_ARGUMENT');
  await assert.rejects(work.findByPath(null), (error) => error.code === 'BAD_ARGUMENT');
});

test('create: forwards path and title, omitting an empty title', async () => {
  const calls = [];
  const work = makeDomain({
    workspaceRegistry: {
      list: async () => [],
      create: async (path, title) => {
        calls.push([path, title]);
        return { id: 'w9', title: title ?? 'untitled', path };
      },
    },
  });
  assert.equal((await work.create('/new', 'Title')).title, 'Title');
  assert.equal((await work.create('/new2', '')).title, 'untitled');
  assert.deepEqual(calls, [
    ['/new', 'Title'],
    ['/new2', undefined],
  ]);
  await assert.rejects(work.create('', 'T'), (error) => error.code === 'BAD_ARGUMENT');
});

test('rename: rewrites the title through setTitle and reports a missing workspace', async () => {
  const entity = {
    id: 'w1',
    title: 'old',
    setTitle(title) {
      this.title = title;
      return undefined;
    },
  };
  const work = makeDomain({
    workspaceRegistry: {
      list: async () => [],
      get: async (id) => (id === 'w1' ? entity : null),
    },
  });
  const renamed = await work.rename('w1', 'new');
  assert.equal(renamed.title, 'new');
  assert.equal(entity.title, 'new');
  await assert.rejects(work.rename('missing', 'x'), (error) => {
    assert.equal(error.code, 'NOT_FOUND');
    assert.equal(error.message, 'no workspace with id "missing"');
    return true;
  });
  await assert.rejects(work.rename('w1', 5), (error) => error.code === 'BAD_ARGUMENT');
});

test('remove: true only when the host confirms; delete is the same function', async () => {
  const work = makeDomain({
    workspaceRegistry: {
      list: async () => [],
      delete: async (id) => id === 'w1',
    },
  });
  assert.equal(await work.remove('w1'), true);
  assert.equal(await work.remove('w2'), false);
  assert.equal(work.delete, work.remove);
});

test('move: maps the host order ids and tolerates a non-array answer', async () => {
  const received = [];
  const work = makeDomain({
    workspaceRegistry: {
      list: async () => [],
      insertBefore: async (id, beforeId) => {
        received.push([id, beforeId]);
        return ['w1', 7, ''];
      },
    },
  });
  assert.deepEqual(await work.move('w1', 'w2'), ['w1', '7']);
  assert.deepEqual(await work.move('w1'), ['w1', '7']);
  assert.deepEqual(received[1], ['w1', undefined]);
  const plain = makeDomain({ workspaceRegistry: { list: async () => [], move: async () => null } });
  assert.deepEqual(await plain.move('w1'), []);
});

test('forSession: filters by membership and rejects an empty id', async () => {
  const work = makeDomain({
    workspaceRegistry: {
      list: async () => [
        { id: 'w1', sessionIds: ['s1', 's2'] },
        { id: 'w2', sessionIds: ['s3'] },
        { id: 'w3' },
      ],
    },
  });
  assert.deepEqual((await work.forSession('s1')).map((item) => item.id), ['w1']);
  assert.deepEqual(await work.forSession('s9'), []);
  await assert.rejects(work.forSession(''), (error) => error.code === 'BAD_ARGUMENT');
});

test('aliases: getlist/getAll point at list, byId/find at get/findByPath', async () => {
  const work = makeDomain({
    workspaceRegistry: { list: async () => [{ id: 'w1', path: '/a' }] },
  });
  assert.equal(work.getlist, work.list);
  assert.equal(work.getAll, work.list);
  assert.equal(work.byId, work.get);
  assert.equal(work.find, work.findByPath);
  assert.deepEqual((await work.getlist()).map((item) => item.id), ['w1']);
});

test('a missing or unusable workspace service is UNSUPPORTED', async () => {
  await assert.rejects(makeDomain({}).list(), (error) => {
    assert.equal(error.code, 'UNSUPPORTED');
    assert.match(error.message, /workspaceRegistry/);
    return true;
  });
  await assert.rejects(makeDomain({ workspaceRegistry: { create: async () => ({}) } }).list(), (error) => {
    assert.equal(error.code, 'UNSUPPORTED');
    assert.match(error.message, /neither list\(\) nor get\(\)/);
    assert.equal(error.hint, 'The host workspace service was renamed; update dsh-modapi.');
    return true;
  });
});
