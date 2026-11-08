import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCompat } from '../lib/compat.js';
import { createFsDomain, FS_SERVICES } from '../lib/domains/fs.js';
import { ModapiError } from '../lib/errors.js';
import { fakeCtx } from './helpers.js';

function baseService(overrides = {}) {
  return {
    resolve: async (path, options) => ({ targetKey: `tk:${path}`, displayPath: `/abs/${path}`, options }),
    stat: async () => ({ type: 'file', size: 12, version: 'v1' }),
    readText: async () => 'hello',
    readBytes: async () => Buffer.from('abc'),
    listDir: async () => [],
    writeText: async () => ({ operation: 'write', version: 'v2', before: 'old', after: 'new' }),
    editText: async () => ({ operation: 'edit' }),
    fileUrl: async (target) => `file://${target.displayPath}`,
    contains: () => true,
    ...overrides,
  };
}

/** Domain over a fake `fs` service (override individual methods). */
function makeDomain(overrides = {}) {
  const { ctx } = fakeCtx({ fs: baseService(overrides) });
  return createFsDomain(createCompat(ctx, null));
}

/** Domain over an exact services map, for missing-service and alias cases. */
function makeRawDomain(services) {
  const { ctx } = fakeCtx(services);
  return createFsDomain(createCompat(ctx, null));
}

test('fs constants', () => {
  assert.deepEqual([...FS_SERVICES], ['fs', 'filesystem']);
});

test('resolve: host targets, string paths and cwd', async () => {
  const calls = [];
  const domain = makeDomain({
    resolve: async (path, options) => {
      calls.push([path, options]);
      return { targetKey: 'tk', displayPath: '/abs' };
    },
  });
  assert.deepEqual(await domain.resolve('x'), { targetKey: 'tk', displayPath: '/abs' });
  await domain.resolve('x', { cwd: '/work' });
  assert.deepEqual(calls, [
    ['x', undefined],
    ['x', { cwd: '/work' }],
  ]);
  const target = { targetKey: 'given', displayPath: '/given' };
  assert.equal((await domain.resolve(target)).targetKey, 'given');
  assert.equal(calls.length, 2);
  assert.equal(domain.targetOf, domain.resolve);
});

test('resolve: bad paths are BAD_ARGUMENT and a non-object answer is INTERNAL', async () => {
  const domain = makeDomain();
  for (const path of ['', null, 42, undefined]) {
    await assert.rejects(domain.resolve(path), (error) => {
      assert.equal(error.code, 'BAD_ARGUMENT');
      assert.equal(error.message, 'a path string or a host target is required');
      return true;
    });
  }
  const broken = makeDomain({ resolve: async () => null });
  await assert.rejects(broken.resolve('x'), (error) => {
    assert.equal(error.code, 'INTERNAL');
    assert.equal(error.message, 'fs.resolve() did not return a target');
    return true;
  });
});

test('stat: normalises fields and returns null for a missing target', async () => {
  const domain = makeDomain();
  assert.deepEqual(await domain.stat('x'), { type: 'file', size: 12, version: 'v1' });
  const missing = makeDomain({ stat: async () => null });
  assert.equal(await missing.stat('x'), null);
  const odd = makeDomain({ stat: async () => ({ type: 7, size: 'big', version: 3 }) });
  assert.deepEqual(await odd.stat('x'), { type: '7', size: 0, version: '' });
});

test('exists: DENIED and NOT_FOUND are false, other failures rethrow', async () => {
  assert.equal(await makeDomain().exists('x'), true);
  const missing = makeDomain({ stat: async () => null });
  assert.equal(await missing.exists('x'), false);
  const denied = makeDomain({
    stat: async () => {
      throw new ModapiError('DENIED', 'no');
    },
  });
  assert.equal(await denied.exists('x'), false);
  const notFound = makeDomain({
    stat: async () => {
      throw new ModapiError('NOT_FOUND', 'no');
    },
  });
  assert.equal(await notFound.exists('x'), false);
  const broken = makeDomain({
    stat: async () => {
      throw new ModapiError('INTERNAL', 'boom');
    },
  });
  await assert.rejects(broken.exists('x'), (error) => {
    assert.equal(error.code, 'INTERNAL');
    assert.equal(error.message, 'boom');
    return true;
  });
});

test('read: text passes through, a non-string answer becomes empty', async () => {
  const domain = makeDomain();
  assert.equal(await domain.read('x'), 'hello');
  assert.equal(domain.readText, domain.read);
  const odd = makeDomain({ readText: async () => 7 });
  assert.equal(await odd.read('x'), '');
});

test('readBytes: base64 plus size, with the max clamped to the host window', async () => {
  const seen = [];
  const domain = makeDomain({
    readBytes: async (target, signal, maxBytes) => {
      seen.push(maxBytes);
      return Buffer.from('abc');
    },
  });
  assert.deepEqual(await domain.readBytes('x'), { base64: 'YWJj', size: 3 });
  await domain.readBytes('x', { maxBytes: 0 });
  await domain.readBytes('x', { maxBytes: 999999999 });
  await domain.readBytes('x', { maxBytes: Number.NaN });
  assert.deepEqual(seen, [4194304, 1, 16777216, 4194304]);
  const asArray = makeDomain({ readBytes: async () => [0x61] });
  assert.deepEqual(await asArray.readBytes('x'), { base64: 'YQ==', size: 1 });
});

test('list: normalises entries and sorts them by name', async () => {
  const domain = makeDomain({
    listDir: async () => [
      { name: 'b.txt', type: 'file', path: '/b.txt', size: 2, version: 'v2' },
      { name: 'a', type: 'dir', target: { displayPath: '/a' } },
      { name: 'c', type: 'file', path: '/c', size: 'big', version: 3 },
    ],
  });
  assert.deepEqual(await domain.list('x'), [
    { name: 'a', type: 'dir', path: '/a', size: undefined, version: undefined },
    { name: 'b.txt', type: 'file', path: '/b.txt', size: 2, version: 'v2' },
    { name: 'c', type: 'file', path: '/c', size: undefined, version: undefined },
  ]);
  assert.equal(domain.listDir, domain.list);
});

test('list: a non-array answer is INTERNAL', async () => {
  const domain = makeDomain({ listDir: async () => 'nope' });
  await assert.rejects(domain.list('x'), (error) => {
    assert.equal(error.code, 'INTERNAL');
    assert.equal(error.message, 'listDir() did not return an array');
    return true;
  });
});

test('write: create, version and expected guards reach the host', async () => {
  const seen = [];
  const domain = makeDomain({
    writeText: async (target, content, expected, signal) => {
      seen.push({ content, expected, signal });
      return { operation: 'writeText', version: 'v9', before: 'a', after: 'b' };
    },
  });
  const result = await domain.write('x', 'body', { create: true });
  assert.deepEqual(result, { path: '/abs/x', operation: 'writeText', version: 'v9', before: 'a', after: 'b' });
  await domain.write('x', 'body', { version: 'v3' });
  await domain.write('x', 'body', { expected: { kind: 'custom' } });
  await domain.write('x', 'body');
  assert.deepEqual(seen.map((entry) => entry.expected), [
    { kind: 'createIfAbsent' },
    { kind: 'replaceIfVersion', version: 'v3' },
    { kind: 'custom' },
    undefined,
  ]);
  assert.equal(seen[0].content, 'body');
  assert.equal(domain.writeText, domain.write);
});

test('write: non-string content is BAD_ARGUMENT before any host call', async () => {
  let called = false;
  const domain = makeDomain({
    writeText: async () => {
      called = true;
      return {};
    },
  });
  await assert.rejects(domain.write('x', 5), (error) => {
    assert.equal(error.code, 'BAD_ARGUMENT');
    assert.equal(error.message, 'fs.write(path, content) needs a string');
    return true;
  });
  assert.equal(called, false);
});

test('edit: both strings are required, replaceAll defaults to false', async () => {
  const seen = [];
  const domain = makeDomain({
    editText: async (target, patch) => {
      seen.push(patch);
      return { operation: 'editText' };
    },
  });
  assert.deepEqual(await domain.edit('x', { oldString: 'a', newString: 'b' }), {
    path: '/abs/x',
    operation: 'editText',
    version: undefined,
    before: undefined,
    after: undefined,
  });
  await domain.edit('x', { oldString: 'a', newString: 'b', replaceAll: true });
  assert.deepEqual(seen, [
    { oldString: 'a', newString: 'b', replaceAll: false },
    { oldString: 'a', newString: 'b', replaceAll: true },
  ]);
  await assert.rejects(domain.edit('x', { oldString: 'a' }), (error) => {
    assert.equal(error.code, 'BAD_ARGUMENT');
    assert.equal(error.message, 'fs.edit(path, { oldString, newString }) needs both strings');
    return true;
  });
  await assert.rejects(domain.edit('x', null), (error) => error.code === 'BAD_ARGUMENT');
});

test('fileUrl and contains go through the host', async () => {
  const domain = makeDomain();
  assert.equal(await domain.fileUrl('x'), 'file:///abs/x');
  assert.equal(await domain.contains('x', 'y'), true);
  const no = makeDomain({ contains: () => 'yes' });
  assert.equal(await no.contains('x', 'y'), false);
});

test('a missing fs service is UNSUPPORTED and names both aliases', async () => {
  const domain = makeRawDomain({});
  await assert.rejects(domain.read('x'), (error) => {
    assert.equal(error.code, 'UNSUPPORTED');
    assert.match(error.message, /fs \| filesystem/);
    return true;
  });
});

test('the filesystem alias is picked up when fs is absent', async () => {
  const domain = makeRawDomain({ filesystem: baseService() });
  assert.equal(await domain.read('x'), 'hello');
});
