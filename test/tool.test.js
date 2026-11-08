import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCompat } from '../lib/compat.js';
import { createToolDomain, toToolRecord, TOOL_SERVICES } from '../lib/domains/tool.js';
import { fakeCtx } from './helpers.js';

function makeDomain(services) {
  const { ctx } = fakeCtx(services);
  return createToolDomain(createCompat(ctx, null));
}

test('tool constants and toToolRecord', () => {
  assert.deepEqual([...TOOL_SERVICES], ['tools']);
  assert.deepEqual(toToolRecord({ name: 'demo', description: 'd', inputSchema: { type: 'object' }, deferLoading: true }), {
    name: 'demo',
    description: 'd',
    parameters: { type: 'object' },
    deferred: true,
  });
  assert.deepEqual(toToolRecord({ name: 'demo', deferLoading: 'yes' }), { name: 'demo', description: '', parameters: null, deferred: false });
  assert.deepEqual(toToolRecord({ name: 'demo', parameters: { a: 1n } }), { name: 'demo', description: '', parameters: { a: '1' }, deferred: false });
});

test('list: a Map view is unwrapped and nameless entries are dropped', async () => {
  const domain = makeDomain({
    tools: {
      view: () => ({
        visible: new Map([
          ['a', { name: 'a' }],
          ['b', { name: 'b' }],
          ['empty', { name: '' }],
        ]),
      }),
    },
  });
  assert.deepEqual((await domain.list()).map((item) => item.name), ['a', 'b']);
  assert.deepEqual(await domain.names(), ['a', 'b']);
  assert.equal(await domain.count(), 2);
});

test('list: an array view and a {visible: []} view both work', async () => {
  const asArray = makeDomain({ tools: { view: () => [{ name: 'x' }, { name: 'y' }] } });
  assert.deepEqual((await asArray.list()).map((item) => item.name), ['x', 'y']);
  const asVisible = makeDomain({ tools: { view: () => ({ visible: [{ name: 'z' }] }) } });
  assert.deepEqual((await asVisible.list()).map((item) => item.name), ['z']);
  const empty = makeDomain({ tools: { view: () => null } });
  assert.deepEqual(await empty.list(), []);
});

test('list: falls back to schemas() and passes the scope through', async () => {
  const scopes = [];
  const domain = makeDomain({
    tools: {
      schemas: async (scope) => {
        scopes.push(scope);
        return [{ name: 'a' }, { name: '' }, { name: 'b' }];
      },
    },
  });
  assert.deepEqual((await domain.list('session-1')).map((item) => item.name), ['a', 'b']);
  assert.deepEqual(scopes, ['session-1']);
  assert.deepEqual((await domain.schemas()).map((item) => item.name), ['a', 'b']);
});

test('schemas is an alias of list, with the full record shape', async () => {
  const domain = makeDomain({ tools: { schemas: async () => [{ name: 'a' }] } });
  assert.deepEqual(await domain.schemas(), [{ name: 'a', description: '', parameters: null, deferred: false }]);
});

test('list: a schemas() answer that is not an array is INTERNAL', async () => {
  const domain = makeDomain({ tools: { schemas: async () => 'nope' } });
  await assert.rejects(domain.list(), (error) => {
    assert.equal(error.code, 'INTERNAL');
    assert.equal(error.message, 'tools.schemas() did not return an array');
    return true;
  });
});

test('get: service getter first, list fallback second, null when absent', async () => {
  const domain = makeDomain({
    tools: {
      get: async (name, scope) => (name === 'a' ? { name: 'a', description: 'from-get' } : null),
      schemas: async () => [{ name: 'b', description: 'from-list' }],
    },
  });
  assert.equal((await domain.get('a')).description, 'from-get');
  assert.equal((await domain.get('b')).description, 'from-list');
  assert.equal(await domain.get('c'), null);
  assert.equal(await domain.has('a'), true);
  assert.equal(await domain.has('c'), false);
  await assert.rejects(domain.get(''), (error) => {
    assert.equal(error.code, 'BAD_ARGUMENT');
    assert.equal(error.message, 'tool.get(name) needs a tool name');
    return true;
  });
});

test('call: assembles the host execute() arguments', async () => {
  let captured = null;
  const domain = makeDomain({
    tools: {
      execute: async (request) => {
        captured = request;
        return { ok: true, content: 'done' };
      },
    },
  });
  const result = await domain.call('demo', { a: 1 }, { callId: 'call-1', timeoutMs: 1000 });
  assert.equal(captured.callId, 'call-1');
  assert.equal(captured.name, 'demo');
  assert.deepEqual(captured.arguments, { a: 1 });
  assert.ok(captured.signal instanceof AbortSignal);
  assert.equal('agent' in captured, false);
  assert.equal(result.scoped, false);
  assert.deepEqual(result, { name: 'demo', ok: true, scoped: false, content: 'done', result: { ok: true, content: 'done' } });
});

test('call: a generated callId is a UUID and missing arguments become {}', async () => {
  let captured = null;
  const domain = makeDomain({
    tools: {
      execute: async (request) => {
        captured = request;
        return {};
      },
    },
  });
  await domain.call('demo', undefined, { timeoutMs: 1000 });
  assert.match(captured.callId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.deepEqual(captured.arguments, {});
});

test('call: an agent scopes the call and is forwarded', async () => {
  let captured = null;
  const agent = { id: 'agent-1' };
  const domain = makeDomain({
    tools: {
      execute: async (request) => {
        captured = request;
        return { ok: true };
      },
    },
  });
  const result = await domain.call('demo', {}, { agent, timeoutMs: 1000 });
  assert.equal(result.scoped, true);
  assert.equal(captured.agent, agent);
});

test('call: an explicit signal is forwarded, a timeout signal is aborted afterwards', async () => {
  const seen = [];
  const explicit = new AbortController();
  const domain = makeDomain({
    tools: {
      execute: async (request) => {
        seen.push(request.signal);
        return { ok: true };
      },
    },
  });
  await domain.call('demo', {}, { signal: explicit.signal });
  assert.equal(seen[0], explicit.signal);
  await domain.call('demo', {}, { timeoutMs: 50 });
  assert.equal(seen[1].aborted, true);
  assert.notEqual(seen[1], explicit.signal);
});

test('call: without a signal or a positive timeout it refuses', async () => {
  const domain = makeDomain({ tools: { execute: async () => ({}) } });
  for (const settings of [{}, { timeoutMs: 0 }, { timeoutMs: -5 }, { timeoutMs: 'soon' }]) {
    await assert.rejects(domain.call('demo', {}, settings), (error) => {
      assert.equal(error.code, 'BAD_ARGUMENT');
      assert.equal(error.message, 'tool.call() needs a signal or a positive timeoutMs');
      return true;
    });
  }
  await assert.rejects(domain.call('', {}, { timeoutMs: 1000 }), (error) => error.code === 'BAD_ARGUMENT');
});

test('call: ok/success/content normalisation', async () => {
  const answers = [
    [{ ok: true, content: 'hi' }, true, 'hi'],
    [{ success: true, output: 'out' }, true, 'out'],
    [{ ok: false }, false, null],
    [{ ok: 'yes' }, false, null],
    [{ value: 7 }, true, 7],
    [undefined, false, null],
  ];
  for (const [answer, ok, content] of answers) {
    const domain = makeDomain({ tools: { execute: async () => answer } });
    const result = await domain.call('demo', {}, { timeoutMs: 1000 });
    assert.equal(result.ok, ok, JSON.stringify(answer));
    assert.deepEqual(result.content, content);
    assert.deepEqual(result.result, answer === undefined ? null : answer);
  }
});

test('call: a host failure is translated and still aborts the timeout signal', async () => {
  let captured = null;
  const domain = makeDomain({
    tools: {
      execute: async (request) => {
        captured = request;
        throw new Error('tool blew up');
      },
    },
  });
  await assert.rejects(domain.call('demo', {}, { timeoutMs: 1000 }), (error) => {
    assert.equal(error.code, 'INTERNAL');
    assert.equal(error.message, 'tool blew up');
    return true;
  });
  assert.equal(captured.signal.aborted, true);
});

test('run is call; missing service or execute is UNSUPPORTED', async () => {
  const domain = makeDomain({ tools: { execute: async () => ({ ok: true }) } });
  assert.equal(domain.run, domain.call);
  const missing = makeDomain({});
  await assert.rejects(missing.list(), (error) => {
    assert.equal(error.code, 'UNSUPPORTED');
    assert.match(error.message, /tools/);
    return true;
  });
  const noExecute = makeDomain({ tools: { schemas: async () => [] } });
  await assert.rejects(noExecute.call('demo', {}, { timeoutMs: 1000 }), (error) => {
    assert.equal(error.code, 'UNSUPPORTED');
    assert.match(error.message, /execute/);
    return true;
  });
});
