/**
 * The HTTP bridge the client half talks to.
 *
 * Route handler, auth, envelope and mount bookkeeping live here so the host
 * plugin file stays about composition. The route is same-origin only and, when
 * the host offers `connection.requestRejection`, inherits the host's own auth.
 */
import { ModapiError, ERROR_CODES, messageOf } from './errors.js';

export const BRIDGE_PREFIX = '/modapi/api';
export const MAX_BODY_BYTES = 32768;

export function sendJson(response, status, payload) {
  const text = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  });
  response.end(text);
}

function fail(response, status, code, message) {
  sendJson(response, status, { ok: false, error: { code, message } });
}

export function readJsonBody(request, options = {}) {
  const limit = Number.isFinite(options.limit) ? options.limit : MAX_BODY_BYTES;
  return new Promise((resolve, reject) => {
    let size = 0;
    let overflow = false;
    const chunks = [];
    request.on('data', (chunk) => {
      if (overflow) return;
      size += chunk.length;
      if (size > limit) {
        // Rejecting is enough: destroying the socket would replace the 400
        // envelope with ECONNRESET on the client side.
        overflow = true;
        chunks.length = 0;
        reject(new ModapiError(ERROR_CODES.BAD_ARGUMENT, `request body exceeds ${limit} bytes`, { domain: 'bridge', method: 'ack' }));
        request.resume();
        return;
      }
      chunks.push(chunk);
    });
    request.on('error', (error) => reject(new ModapiError(ERROR_CODES.INTERNAL, messageOf(error), { domain: 'bridge', cause: error })));
    request.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (text === '') return resolve({});
      try {
        const parsed = JSON.parse(text);
        resolve(parsed !== null && typeof parsed === 'object' ? parsed : {});
      } catch (error) {
        reject(new ModapiError(ERROR_CODES.BAD_ARGUMENT, 'request body is not valid JSON', { domain: 'bridge', cause: error }));
      }
    });
  });
}

/** Same-origin check: a browser sends Origin; a same-origin fetch matches Host. */
export function isSameOrigin(request) {
  const origin = request.headers?.origin;
  const host = request.headers?.host;
  if (typeof origin !== 'string' || origin === '') return true;
  if (typeof host !== 'string' || host === '') return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function stripPrefix(rawUrl, prefix) {
  const pathname = new URL(rawUrl ?? '/', 'http://bridge.invalid').pathname;
  if (pathname === prefix) return { pathname: '/', search: '' };
  if (!pathname.startsWith(prefix + '/')) return null;
  const rest = pathname.slice(prefix.length);
  const url = new URL(rawUrl, 'http://bridge.invalid');
  return { pathname: rest, search: url.search };
}

export function createBridgeHandler(handlers = {}, options = {}) {
  const prefix = typeof options.prefix === 'string' && options.prefix.length > 0 ? options.prefix : BRIDGE_PREFIX;
  const log = options.log ?? null;

  return async function handle(request, response) {
    try {
      const rejection = typeof handlers.reject === 'function' ? handlers.reject(request) : undefined;
      if (rejection === 401 || rejection === 403) {
        return fail(response, rejection, rejection === 401 ? 'UNAUTHORIZED' : 'DENIED', rejection === 401 ? 'dsh web authentication required' : 'request rejected by the host');
      }
      if (!isSameOrigin(request)) {
        return fail(response, 403, 'DENIED', 'cross-origin request refused');
      }

      const route = stripPrefix(request.url, prefix);
      if (route === null) return fail(response, 404, 'NOT_FOUND', `no route for ${request.url ?? '/'}`);
      const { pathname, search } = route;
      const params = new URLSearchParams(search);
      const method = (request.method ?? 'GET').toUpperCase();

      if (pathname === '/info' && method === 'GET') {
        const value = typeof handlers.info === 'function' ? await handlers.info() : {};
        return sendJson(response, 200, { ok: true, value });
      }

      if (pathname === '/notices' && method === 'GET') {
        const afterRaw = params.get('after');
        const waitRaw = params.get('wait');
        const after = afterRaw === null ? 0 : Number.parseInt(afterRaw, 10);
        const wait = waitRaw === null ? 0 : Number.parseInt(waitRaw, 10);
        const notices = typeof handlers.notices === 'function' ? await handlers.notices(Number.isFinite(after) ? after : 0, Number.isFinite(wait) ? wait : 0) : [];
        const list = Array.isArray(notices) ? notices : [];
        const seq = list.reduce((max, item) => (Number.isFinite(item?.seq) && item.seq > max ? item.seq : max), Number.isFinite(after) ? after : 0);
        return sendJson(response, 200, { ok: true, value: { notices: list, seq } });
      }

      if (pathname === '/notices/ack' && method === 'POST') {
        const body = await readJsonBody(request);
        const ids = Array.isArray(body.ids) ? body.ids : [];
        const count = typeof handlers.ack === 'function' ? await handlers.ack(ids) : 0;
        return sendJson(response, 200, { ok: true, value: { acked: Number.isFinite(count) ? count : 0 } });
      }

      if (pathname === '/ui' && method === 'GET') {
        const value = typeof handlers.ui === 'function' ? await handlers.ui() : { version: 0, rules: [] };
        return sendJson(response, 200, { ok: true, value });
      }

      if (pathname === '/ui/hit' && method === 'POST') {
        const body = await readJsonBody(request);
        const id = typeof body.id === 'string' ? body.id : '';
        const hit = typeof handlers.uiHit === 'function' ? await handlers.uiHit(id) : false;
        return sendJson(response, 200, { ok: true, value: { hit } });
      }

      if (pathname === '/selfcheck' && method === 'POST') {
        if (typeof handlers.selfcheck !== 'function') return fail(response, 501, 'UNSUPPORTED', 'selfcheck is not wired');
        const report = await handlers.selfcheck();
        return sendJson(response, 200, { ok: true, value: report });
      }

      if (['/info', '/notices', '/notices/ack', '/selfcheck'].includes(pathname)) {
        return fail(response, 405, 'BAD_ARGUMENT', `${method} is not allowed on ${pathname}`);
      }

      return fail(response, 404, 'NOT_FOUND', `no route for ${pathname}`);
    } catch (error) {
      const code = error instanceof ModapiError ? error.code : ERROR_CODES.INTERNAL;
      const status = code === ERROR_CODES.BAD_ARGUMENT ? 400 : 500;
      log?.warn?.(`[dsh-modapi] bridge error: ${messageOf(error)}`);
      return fail(response, status, code, messageOf(error));
    }
  };
}

export function registerBridge(ctx, handlers, options = {}) {
  const prefix = typeof options.prefix === 'string' && options.prefix.length > 0 ? options.prefix : BRIDGE_PREFIX;
  const log = options.log ?? null;
  const handler = createBridgeHandler(handlers, { prefix, log });
  let state = 'pending';
  let mountDispose = null;

  const scope = ctx.inject(['webServer'], (serviceCtx) => {
    try {
      const webServer = serviceCtx?.webServer ?? serviceCtx?.get?.('webServer', false);
      if (webServer === undefined || typeof webServer.register !== 'function') {
        state = 'failed: webServer.register is unavailable';
        return;
      }
      mountDispose = webServer.register({ kind: 'prefix', path: prefix, handler });
      state = 'installed';
    } catch (error) {
      state = `failed: ${messageOf(error)}`;
      log?.warn?.(`[dsh-modapi] cannot mount ${prefix}: ${messageOf(error)}`);
    }
  });

  return {
    prefix,
    handler,
    installed() {
      return state === 'installed';
    },
    failure() {
      return state === 'installed' || state === 'pending' ? null : state;
    },
    dispose() {
      try {
        mountDispose?.();
      } catch (error) {
        log?.warn?.(`[dsh-modapi] bridge dispose failed: ${messageOf(error)}`);
      }
      try {
        scope?.dispose?.();
      } catch {
        // Disposal is best effort; the host may already be tearing down.
      }
      mountDispose = null;
      if (state === 'installed') state = 'disposed';
    },
  };
}
