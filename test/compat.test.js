import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCompat } from '../lib/compat.js';

function ctxWith(services, onGet) {
  return {
    get(name, strict) {
      if (onGet !== undefined) onGet(name, strict);
      return services[name];
    },
  };
}

test('getService: resolves a present service and returns undefined for a missing one', () => {
  const seen = [];
  const service = { list() {} };
  const compat = createCompat(ctxWith({ workspaceRegistry: service }, (name, strict) => seen.push({ name, strict })), null);
  assert.equal(compat.getService('workspaceRegistry'), service);
  assert.equal(compat.getService('nope'), undefined);
  assert.deepEqual(seen, [
    { name: 'workspaceRegistry', strict: false },
    { name: 'nope', strict: false },
  ]);
});

test('getService: a ctx.get that throws is treated as a missing service', () => {
  const compat = createCompat(
    {
      get() {
        throw new Error('host exploded');
      },
    },
    null,
  );
  assert.equal(compat.getService('fs'), undefined);
});

test('getFirstService: first available alias wins, absent means undefined', () => {
  const sessions = { list() {} };
  const compat = createCompat(ctxWith({ sessions }), null);
  assert.deepEqual(compat.getFirstService(['sessions', 'sessionStore']), { name: 'sessions', service: sessions });
  assert.equal(compat.getFirstService('sessions').name, 'sessions');
  assert.equal(compat.getFirstService(['fs', 'filesystem']), undefined);
});

test('requireService: returns the service or throws UNSUPPORTED naming every alias', () => {
  const service = { list() {} };
  const compat = createCompat(ctxWith({ workspaceRegistry: service }), null);
  assert.equal(compat.requireService('workspaceRegistry', 'work', 'list'), service);
  assert.throws(
    () => compat.requireService(['fs', 'filesystem'], 'fs', 'read', 'custom hint'),
    (error) => {
      assert.equal(error.code, 'UNSUPPORTED');
      assert.equal(error.domain, 'fs');
      assert.equal(error.method, 'read');
      assert.equal(error.hint, 'custom hint');
      assert.equal(error.message, 'host service fs | filesystem is not available on this DSH build');
      return true;
    },
  );
  assert.throws(
    () => compat.requireService('nope', 'work', 'list'),
    (error) => error.hint === 'Check ctx.modapi.services(); the host renamed or removed that service.',
  );
});

test('methodOf: first callable, bound to its owner; requireMethod throws UNSUPPORTED', () => {
  const service = {
    tag: 'T',
    list() {
      return this.tag;
    },
  };
  const compat = createCompat(ctxWith({ svc: service }), null);
  const list = compat.methodOf(service, ['view', 'list']);
  assert.equal(typeof list, 'function');
  assert.equal(list(), 'T');
  assert.equal(compat.methodOf(service, ['view']), undefined);
  assert.equal(compat.methodOf(null, ['list']), undefined);
  assert.throws(
    () => compat.requireMethod(service, ['view', 'schemas']),
    (error) => error.code === 'UNSUPPORTED' && error.message === 'host method view | schemas is missing',
  );
});

test('run: returns the body value untouched', async () => {
  const compat = createCompat(ctxWith({}), null);
  assert.equal(await compat.run({ domain: 'work', method: 'list' }, async () => 42), 42);
});

test('run: a plain Error becomes INTERNAL with the call context and the cause', async () => {
  const compat = createCompat(ctxWith({}), null);
  const cause = new Error('boom');
  await assert.rejects(compat.run({ domain: 'fs', method: 'write' }, async () => {
    throw cause;
  }), (error) => {
    assert.equal(error.code, 'INTERNAL');
    assert.equal(error.message, 'boom');
    assert.equal(error.domain, 'fs');
    assert.equal(error.method, 'write');
    assert.equal(error.cause, cause);
    return true;
  });
});

test('run: a host ENOENT becomes NOT_FOUND with the host code as detail', async () => {
  const compat = createCompat(ctxWith({}), null);
  await assert.rejects(compat.run({ domain: 'fs', method: 'read' }, async () => {
    const error = new Error('gone');
    error.code = 'ENOENT';
    throw error;
  }), (error) => {
    assert.equal(error.code, 'NOT_FOUND');
    assert.equal(error.detail, 'ENOENT');
    assert.equal(error.message, 'gone');
    return true;
  });
});

test('run: an existing ModapiError passes through unchanged', async () => {
  const compat = createCompat(ctxWith({}), null);
  const original = await import('../lib/errors.js').then((m) => new m.ModapiError('DENIED', 'nope'));
  await assert.rejects(compat.run({}, async () => {
    throw original;
  }), (error) => error === original);
});

test('run: UNSUPPORTED reaches onUnsupported, and a throwing reporter cannot mask it', async () => {
  const seen = [];
  const compat = createCompat(ctxWith({}), null, {
    onUnsupported(info) {
      seen.push(info);
      throw new Error('reporter exploded');
    },
  });
  await assert.rejects(compat.run({ domain: 'work', method: 'list' }, async () => {
    compat.requireService('workspaceRegistry', 'work', 'list');
  }), (error) => error.code === 'UNSUPPORTED');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].code, 'UNSUPPORTED');
  assert.equal(seen[0].domain, 'work');
  assert.equal(seen[0].method, 'list');
  assert.match(seen[0].message, /not available on this DSH build/);
});

test('run: other failures do not reach onUnsupported', async () => {
  let calls = 0;
  const compat = createCompat(ctxWith({}), null, { onUnsupported: () => { calls += 1; } });
  await assert.rejects(compat.run({ domain: 'fs', method: 'read' }, async () => {
    throw new Error('plain');
  }));
  assert.equal(calls, 0);
});

test('probe: one boolean per service group', () => {
  const compat = createCompat(ctxWith({ workspaceRegistry: {}, sessions: {}, fs: {} }), null);
  assert.deepEqual(
    compat.probe({ work: ['workspaceRegistry'], session: ['sessions', 'sessionStore'], tool: ['tools'], fs: ['fs', 'filesystem'] }),
    { work: true, session: true, tool: false, fs: true },
  );
  assert.deepEqual(compat.probe(), {});
});

test('asOptions: objects survive, everything else becomes an empty object', () => {
  const compat = createCompat(ctxWith({}), null);
  const options = { a: 1 };
  assert.equal(compat.asOptions(options), options);
  const array = [1];
  assert.equal(compat.asOptions(array), array);
  assert.deepEqual(compat.asOptions(null), {});
  assert.deepEqual(compat.asOptions('str'), {});
  assert.deepEqual(compat.asOptions(undefined), {});
});
