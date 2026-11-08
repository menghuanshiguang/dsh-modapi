import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  BRIDGE_PREFIX,
  MAX_BODY_BYTES,
  createBridgeHandler,
  isSameOrigin,
  readJsonBody,
  registerBridge,
  sendJson,
} from '../lib/bridge.js';
import { ModapiError } from '../lib/errors.js';
import { fakeCtx, fakeRequest, httpRequest, makeLogger, startServer } from './helpers.js';

async function withServer(handlers, run, options = {}) {
  const handler = createBridgeHandler(handlers, options);
  const server = await startServer((request, response) => handler(request, response));
  try {
    await run(server);
  } finally {
    await server.close();
  }
}

test('bridge constants: the documented prefix and body cap', () => {
  assert.equal(BRIDGE_PREFIX, '/modapi/api');
  assert.equal(MAX_BODY_BYTES, 32768);
});

test('GET /info answers inside the ok/value envelope', async () => {
  await withServer({ info: async () => ({ version: '1', dshHome: 'C:/tmp' }) }, async (server) => {
    const response = await httpRequest(`${server.origin}${BRIDGE_PREFIX}/info`);
    assert.equal(response.status, 200);
    assert.match(response.headers['content-type'], /application\/json/);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(Number(response.headers['content-length']), Buffer.byteLength(response.text));
    assert.deepEqual(response.json, { ok: true, value: { version: '1', dshHome: 'C:/tmp' } });
  });
});

test('GET /info without a handler still answers 200 with {}', async () => {
  await withServer({}, async (server) => {
    const response = await httpRequest(`${server.origin}${BRIDGE_PREFIX}/info`);
    assert.equal(response.status, 200);
    assert.deepEqual(response.json, { ok: true, value: {} });
  });
});

test('GET /notices passes after and wait through and echoes the cursor', async () => {
  const calls = [];
  await withServer(
    {
      notices: (after, wait) => {
        calls.push({ after, wait });
        return [{ id: 'notice-1', seq: 4 }];
      },
    },
    async (server) => {
      const response = await httpRequest(`${server.origin}${BRIDGE_PREFIX}/notices?after=2&wait=250`);
      assert.equal(response.status, 200);
      assert.deepEqual(response.json, { ok: true, value: { notices: [{ id: 'notice-1', seq: 4 }], seq: 4 } });
      assert.deepEqual(calls, [{ after: 2, wait: 250 }]);
    },
  );
});

test('GET /notices defaults after/wait to 0 and keeps the cursor on an empty answer', async () => {
  const calls = [];
  await withServer(
    {
      notices: (after, wait) => {
        calls.push({ after, wait });
        return [];
      },
    },
    async (server) => {
      const blank = await httpRequest(`${server.origin}${BRIDGE_PREFIX}/notices`);
      assert.deepEqual(blank.json, { ok: true, value: { notices: [], seq: 0 } });
      const gapped = await httpRequest(`${server.origin}${BRIDGE_PREFIX}/notices?after=7&wait=not-a-number`);
      assert.deepEqual(gapped.json, { ok: true, value: { notices: [], seq: 7 } });
      assert.deepEqual(calls, [
        { after: 0, wait: 0 },
        { after: 7, wait: 0 },
      ]);
    },
  );
});

test('POST /notices/ack forwards the ids and counts the removals', async () => {
  let received = null;
  await withServer(
    {
      ack: (ids) => {
        received = ids;
        return 2;
      },
    },
    async (server) => {
      const response = await httpRequest(`${server.origin}${BRIDGE_PREFIX}/notices/ack`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ids: ['notice-1', 'notice-2'] }),
      });
      assert.equal(response.status, 200);
      assert.deepEqual(response.json, { ok: true, value: { acked: 2 } });
      assert.deepEqual(received, ['notice-1', 'notice-2']);
    },
  );
});

test('POST /notices/ack with an empty body acks nothing and succeeds', async () => {
  await withServer({ ack: () => 0 }, async (server) => {
    const response = await httpRequest(`${server.origin}${BRIDGE_PREFIX}/notices/ack`, { method: 'POST' });
    assert.equal(response.status, 200);
    assert.deepEqual(response.json, { ok: true, value: { acked: 0 } });
  });
});

test('POST /notices/ack rejects invalid JSON with 400 BAD_ARGUMENT', async () => {
  await withServer({}, async (server) => {
    const response = await httpRequest(`${server.origin}${BRIDGE_PREFIX}/notices/ack`, {
      method: 'POST',
      body: '{oops',
    });
    assert.equal(response.status, 400);
    assert.equal(response.json.ok, false);
    assert.equal(response.json.error.code, 'BAD_ARGUMENT');
    assert.equal(response.json.error.message, 'request body is not valid JSON');
  });
});

test('POST /selfcheck answers when wired and reports UNSUPPORTED when not', async () => {
  await withServer({ selfcheck: async () => ({ ok: true, checked: 10 }) }, async (server) => {
    const response = await httpRequest(`${server.origin}${BRIDGE_PREFIX}/selfcheck`, { method: 'POST' });
    assert.equal(response.status, 200);
    assert.deepEqual(response.json, { ok: true, value: { ok: true, checked: 10 } });
  });
  await withServer({}, async (server) => {
    const response = await httpRequest(`${server.origin}${BRIDGE_PREFIX}/selfcheck`, { method: 'POST' });
    assert.equal(response.status, 501);
    assert.equal(response.json.error.code, 'UNSUPPORTED');
  });
});

test('a wrong method on a known route is 405', async () => {
  await withServer({}, async (server) => {
    const cases = [
      ['POST', '/info', 'POST is not allowed on /info'],
      ['GET', '/notices/ack', 'GET is not allowed on /notices/ack'],
      ['GET', '/selfcheck', 'GET is not allowed on /selfcheck'],
    ];
    for (const [method, route, message] of cases) {
      const response = await httpRequest(`${server.origin}${BRIDGE_PREFIX}${route}`, { method });
      assert.equal(response.status, 405, `${method} ${route}`);
      assert.equal(response.json.error.code, 'BAD_ARGUMENT');
      assert.equal(response.json.error.message, message);
    }
  });
});

test('unknown paths, the bare prefix and foreign prefixes are 404', async () => {
  await withServer({}, async (server) => {
    const unknown = await httpRequest(`${server.origin}${BRIDGE_PREFIX}/nope`);
    assert.equal(unknown.status, 404);
    assert.equal(unknown.json.error.code, 'NOT_FOUND');
    assert.equal(unknown.json.error.message, `no route for /nope`);
    const bare = await httpRequest(`${server.origin}${BRIDGE_PREFIX}`);
    assert.equal(bare.status, 404);
    assert.equal(bare.json.error.message, 'no route for /');
    const unprefixed = await httpRequest(`${server.origin}/info`);
    assert.equal(unprefixed.status, 404);
    assert.equal(unprefixed.json.error.message, 'no route for /info');
  });
});

test('a cross-origin request is refused with 403 DENIED before routing', async () => {
  let infoCalls = 0;
  await withServer(
    { info: () => { infoCalls += 1; return {}; } },
    async (server) => {
      const response = await httpRequest(`${server.origin}${BRIDGE_PREFIX}/info`, {
        headers: { origin: 'http://evil.example' },
      });
      assert.equal(response.status, 403);
      assert.equal(response.json.error.code, 'DENIED');
      assert.equal(response.json.error.message, 'cross-origin request refused');
      assert.equal(infoCalls, 0);
      const sameOrigin = await httpRequest(`${server.origin}${BRIDGE_PREFIX}/info`, {
        headers: { origin: server.origin },
      });
      assert.equal(sameOrigin.status, 200);
      assert.equal(infoCalls, 1);
    },
  );
});

test('a host rejection short-circuits with 401 or 403', async () => {
  let infoCalls = 0;
  const info = () => {
    infoCalls += 1;
    return {};
  };
  await withServer({ info, reject: () => 401 }, async (server) => {
    const response = await httpRequest(`${server.origin}${BRIDGE_PREFIX}/info`);
    assert.equal(response.status, 401);
    assert.equal(response.json.error.code, 'UNAUTHORIZED');
    assert.equal(response.json.error.message, 'dsh web authentication required');
  });
  await withServer({ info, reject: () => 403 }, async (server) => {
    const response = await httpRequest(`${server.origin}${BRIDGE_PREFIX}/info`);
    assert.equal(response.status, 403);
    assert.equal(response.json.error.code, 'DENIED');
    assert.equal(response.json.error.message, 'request rejected by the host');
  });
  await withServer({ info, reject: () => true }, async (server) => {
    const response = await httpRequest(`${server.origin}${BRIDGE_PREFIX}/info`);
    assert.equal(response.status, 200);
  });
  assert.equal(infoCalls, 1);
});

test('handler failures become 400 for BAD_ARGUMENT and 500 otherwise', async () => {
  const logger = makeLogger();
  await withServer(
    {
      info: () => {
        throw new ModapiError('BAD_ARGUMENT', 'bad input');
      },
    },
    async (server) => {
      const response = await httpRequest(`${server.origin}${BRIDGE_PREFIX}/info`);
      assert.equal(response.status, 400);
      assert.equal(response.json.error.code, 'BAD_ARGUMENT');
      assert.equal(response.json.error.message, 'bad input');
    },
    { log: logger },
  );
  await withServer(
    {
      info: () => {
        throw new Error('ka-boom');
      },
    },
    async (server) => {
      const response = await httpRequest(`${server.origin}${BRIDGE_PREFIX}/info`);
      assert.equal(response.status, 500);
      assert.equal(response.json.error.code, 'INTERNAL');
      assert.equal(response.json.error.message, 'ka-boom');
    },
    { log: logger },
  );
  assert.equal(logger.has('warn', 'bridge error: bad input'), true);
  assert.equal(logger.has('warn', 'bridge error: ka-boom'), true);
});

test('a custom prefix mounts the same routes and nothing else', async () => {
  const handler = createBridgeHandler({ info: () => ({ v: 1 }) }, { prefix: '/x' });
  const server = await startServer((request, response) => handler(request, response));
  try {
    const mounted = await httpRequest(`${server.origin}/x/info`);
    assert.equal(mounted.status, 200);
    assert.deepEqual(mounted.json, { ok: true, value: { v: 1 } });
    const foreign = await httpRequest(`${server.origin}${BRIDGE_PREFIX}/info`);
    assert.equal(foreign.status, 404);
  } finally {
    await server.close();
  }
});

test('isSameOrigin: missing Origin passes, a foreign host fails', () => {
  assert.equal(isSameOrigin({ headers: {} }), true);
  assert.equal(isSameOrigin({}), true);
  assert.equal(isSameOrigin({ headers: { origin: 'http://a.test', host: 'a.test' } }), true);
  assert.equal(isSameOrigin({ headers: { origin: 'http://a.test', host: 'b.test' } }), false);
  assert.equal(isSameOrigin({ headers: { origin: 'http://a.test' } }), false);
  assert.equal(isSameOrigin({ headers: { origin: 'not a url', host: 'a.test' } }), false);
});

test('readJsonBody: parses objects, blanks and non-objects', async () => {
  assert.deepEqual(await readJsonBody(fakeRequest(['{"ids":["a"],"extra":1}'])), { ids: ['a'], extra: 1 });
  assert.deepEqual(await readJsonBody(fakeRequest(['   '])), {});
  assert.deepEqual(await readJsonBody(fakeRequest(['5'])), {});
  assert.deepEqual(await readJsonBody(fakeRequest(['null'])), {});
});

test('readJsonBody: invalid JSON is BAD_ARGUMENT; a stream error is INTERNAL', async () => {
  await assert.rejects(readJsonBody(fakeRequest(['{oops'])), (error) => {
    assert.equal(error.code, 'BAD_ARGUMENT');
    assert.equal(error.message, 'request body is not valid JSON');
    return true;
  });
  const failing = new EventEmitter();
  const pending = readJsonBody(failing);
  setImmediate(() => failing.emit('error', new Error('socket boom')));
  await assert.rejects(pending, (error) => {
    assert.equal(error.code, 'INTERNAL');
    assert.equal(error.message, 'socket boom');
    assert.equal(error.cause.message, 'socket boom');
    return true;
  });
});

test('readJsonBody: an oversized body is BAD_ARGUMENT and the socket stays open', async () => {
  const big = fakeRequest(['x'.repeat(MAX_BODY_BYTES + 1)]);
  await assert.rejects(readJsonBody(big), (error) => {
    assert.equal(error.code, 'BAD_ARGUMENT');
    assert.match(error.message, /exceeds 32768 bytes/);
    return true;
  });
  // Destroying here would turn the 400 envelope into ECONNRESET for the client.
  assert.equal(big.destroyed, false);
  assert.equal(big.resumed, true);
  const tiny = fakeRequest(['abcde']);
  await assert.rejects(readJsonBody(tiny, { limit: 4 }), (error) => error.code === 'BAD_ARGUMENT');
});

test('sendJson: JSON content type, no-store, byte-accurate length', () => {
  const captured = [];
  const response = {
    writeHead(status, headers) {
      captured.push({ status, headers });
    },
    end(text) {
      captured.push({ text });
    },
  };
  sendJson(response, 201, { ok: true, value: '公告' });
  assert.equal(captured[0].status, 201);
  assert.equal(captured[0].headers['content-type'], 'application/json; charset=utf-8');
  assert.equal(captured[0].headers['cache-control'], 'no-store');
  assert.equal(captured[0].headers['content-length'], Buffer.byteLength(captured[1].text));
  assert.deepEqual(JSON.parse(captured[1].text), { ok: true, value: '公告' });
});

test('registerBridge: mounts on webServer and reports installed', async () => {
  const logger = makeLogger();
  const mounts = [];
  const { ctx, calls } = fakeCtx({
    webServer: {
      register(options) {
        mounts.push(options);
        return () => mounts.push('disposed');
      },
    },
  });
  const bridge = registerBridge(ctx, { info: () => ({ v: 1 }) }, { log: logger });
  assert.deepEqual(calls.inject.map((entry) => entry.names), [['webServer']]);
  assert.equal(mounts.length, 1);
  assert.equal(mounts[0].kind, 'prefix');
  assert.equal(mounts[0].path, BRIDGE_PREFIX);
  assert.equal(typeof mounts[0].handler, 'function');
  assert.equal(bridge.prefix, BRIDGE_PREFIX);
  assert.equal(typeof bridge.handler, 'function');
  assert.equal(bridge.installed(), true);
  assert.equal(bridge.failure(), null);
  bridge.dispose();
  assert.equal(mounts.includes('disposed'), true);
  assert.equal(calls.disposers.includes('inject-scope'), true);
  assert.equal(bridge.installed(), false);
  assert.equal(bridge.failure(), 'disposed');
});

test('registerBridge: a webServer without register is a reported failure', () => {
  const { ctx } = fakeCtx({ webServer: {} });
  const bridge = registerBridge(ctx, {});
  assert.equal(bridge.installed(), false);
  assert.match(bridge.failure(), /webServer\.register is unavailable/);
});

test('registerBridge: a missing webServer service is a reported failure', () => {
  const { ctx } = fakeCtx({});
  const bridge = registerBridge(ctx, {});
  assert.equal(bridge.installed(), false);
  assert.match(bridge.failure(), /webServer\.register is unavailable/);
});

test('registerBridge: a throwing register is caught, logged and reported', () => {
  const logger = makeLogger();
  const { ctx } = fakeCtx({
    webServer: {
      register() {
        throw new Error('mount boom');
      },
    },
  });
  const bridge = registerBridge(ctx, {}, { log: logger });
  assert.equal(bridge.installed(), false);
  assert.equal(bridge.failure(), 'failed: mount boom');
  assert.equal(logger.has('warn', 'cannot mount /modapi/api: mount boom'), true);
});

test('GET /ui returns the serialized rule set, empty when nothing is wired', async () => {
  await withServer({ ui: () => ({ version: 3, rules: [{ id: 'ui-1', selector: '.a', event: 'click', mode: 'before', handler: 'x();', once: false }] }) }, async (server) => {
    const response = await httpRequest(`${server.origin}${BRIDGE_PREFIX}/ui`);
    assert.equal(response.status, 200);
    assert.equal(response.json.ok, true);
    assert.equal(response.json.value.version, 3);
    assert.equal(response.json.value.rules[0].id, 'ui-1');
  });
  await withServer({}, async (server) => {
    const response = await httpRequest(`${server.origin}${BRIDGE_PREFIX}/ui`);
    assert.deepEqual(response.json, { ok: true, value: { version: 0, rules: [] } });
  });
});

test('POST /ui/hit forwards the rule id and reports whether it was known', async () => {
  const seen = [];
  await withServer({ uiHit: (id) => { seen.push(id); return id === 'ui-1'; } }, async (server) => {
    const response = await httpRequest(`${server.origin}${BRIDGE_PREFIX}/ui/hit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'ui-1' }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(response.json, { ok: true, value: { hit: true } });
    const blank = await httpRequest(`${server.origin}${BRIDGE_PREFIX}/ui/hit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(blank.status, 200);
    assert.equal(blank.json.value.hit, false);
  });
  assert.deepEqual(seen, ['ui-1', '']);
});
