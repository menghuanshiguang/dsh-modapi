/**
 * Shared harness for the dsh-modapi suite.
 *
 * Nothing here talks to a real DSH host: fake ctx objects and fake services
 * are the whole point, so a test failure means dsh-modapi broke, not the host.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';

export const TMP_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '.tmp');

export function makeTmpDir(label = 'case') {
  const safe = label.replace(/[^a-z0-9_-]/gi, '_');
  const dir = path.join(TMP_ROOT, `${safe}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function removeTmpDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // A locked temporary file must not turn a passing test into a failure.
  }
}

export function makeLogger() {
  const entries = [];
  const push = (level) => (...args) => {
    entries.push({ level, text: args.map((value) => (typeof value === 'string' ? value : String(value))).join(' ') });
  };
  const logger = {
    entries,
    debug: push('debug'),
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
    has(level, needle) {
      return entries.some((entry) => entry.level === level && entry.text.includes(needle));
    },
  };
  return logger;
}

export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() >= deadline) return false;
    await delay(10);
  }
}

/** Fake cordis ctx: records every call the plugin makes into it. */
export function fakeCtx(services = {}, options = {}) {
  const calls = { get: [], on: [], provide: [], effect: [], inject: [], disposers: [] };
  const ctx = {
    logger: options.logger,
    get(name, strict) {
      calls.get.push({ name, strict });
      return services[name];
    },
    on(event, handler) {
      calls.on.push({ event, handler });
      const disposer = () => {
        calls.disposers.push(event);
      };
      return disposer;
    },
    provide(name, value) {
      calls.provide.push({ name, value });
      return () => {};
    },
    effect(fn) {
      calls.effect.push(fn);
      return () => {};
    },
    inject(names, callback) {
      calls.inject.push({ names, callback });
      const scope = {
        dispose: () => {
          calls.disposers.push('inject-scope');
        },
      };
      const serviceCtx = { get: (name) => services[name] };
      const result = callback(serviceCtx);
      return result !== null && typeof result === 'object' ? result : scope;
    },
  };
  return { ctx, calls };
}

/** A http server on 127.0.0.1:0, closed flush in the caller's finally block. */
export async function startServer(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  return {
    port,
    origin: `http://127.0.0.1:${port}`,
    async close() {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

/** Node-side request with exact header control (fetch forbids some headers). */
export function httpRequest(url, options = {}) {
  const target = new URL(url);
  const method = options.method ?? 'GET';
  const headers = { ...(options.headers ?? {}) };
  const body = options.body;
  return new Promise((resolve, reject) => {
    const request = http.request(
      { hostname: target.hostname, port: target.port, path: target.pathname + target.search, method, headers },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json;
          try {
            json = text === '' ? undefined : JSON.parse(text);
          } catch {
            json = undefined;
          }
          resolve({ status: response.statusCode, headers: response.headers, text, json });
        });
      },
    );
    request.on('error', reject);
    if (body !== undefined) request.write(body);
    request.end();
  });
}

/** Minimal readable stand-in for readJsonBody(), which only needs events. */
export function fakeRequest(chunks) {
  const emitter = new EventEmitter();
  emitter.destroyed = false;
  emitter.resumed = false;
  emitter.destroy = () => {
    emitter.destroyed = true;
  };
  emitter.resume = () => {
    emitter.resumed = true;
  };
  setImmediate(() => {
    for (const chunk of chunks) {
      if (emitter.destroyed) return;
      emitter.emit('data', Buffer.from(chunk));
    }
    if (!emitter.destroyed) emitter.emit('end');
  });
  return emitter;
}
