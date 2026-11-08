/**
 * dsh-modapi — the stable function table DSH plugins code against.
 *
 * `apply()` provides one service (`modapi`) and mounts one HTTP route
 * (`/modapi/api`) for the notice channel. Everything else lives in lib/ so a
 * DSH upgrade has exactly one place to be absorbed.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createModapi, CONFIG_DEFAULTS, API_VERSION } from './lib/modapi.js';
import { registerBridge, BRIDGE_PREFIX } from './lib/bridge.js';
import { messageOf } from './lib/errors.js';

export const name = 'dsh-modapi';
export const version = '0.3.0';
export { CONFIG_DEFAULTS, API_VERSION, BRIDGE_PREFIX };

const NUMERIC_LIMITS = Object.freeze({
  startupTimeoutMs: 1000,
  noticeLimit: 1,
  noticeTtlMs: 1000,
  hookLimitPerName: 1,
});

function toStringList(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => typeof item === 'string' && item.length > 0)
    .map((item) => path.resolve(process.cwd(), item));
}

/** Keep unknown keys, clamp the numbers, resolve the paths, coerce the flags. */
export function normalizeConfig(raw) {
  const input = raw !== null && typeof raw === 'object' ? raw : {};
  const out = { ...input };
  for (const [key, minimum] of Object.entries(NUMERIC_LIMITS)) {
    const value = input[key];
    out[key] = Number.isFinite(value) ? Math.max(minimum, Math.floor(value)) : CONFIG_DEFAULTS[key];
  }
  out.watchScripts = input.watchScripts === true;
  out.scriptDirs = toStringList(input.scriptDirs);
  out.scripts = toStringList(input.scripts);
  out.modDirs = toStringList(input.modDirs);
  return out;
}

export function resolveDshHome() {
  const fromEnv = process.env.DSH_HOME;
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv;
  return path.join(os.homedir(), '.dsh');
}

let hostVersionCache;

/** Desktop build version, read from the runtime manifest once per process. */
export function readHostVersion() {
  if (hostVersionCache !== undefined) return hostVersionCache;
  hostVersionCache = '';
  const fromEnv = process.env.DSH_VERSION;
  if (typeof fromEnv === 'string' && fromEnv.length > 0) {
    hostVersionCache = fromEnv;
    return hostVersionCache;
  }
  const candidates = [
    path.join(path.dirname(process.execPath), 'resources', 'runtime', 'primary-runtime', 'runtime.json'),
    path.join(path.dirname(process.execPath), 'runtime', 'primary-runtime', 'runtime.json'),
  ];
  for (const file of candidates) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (typeof parsed?.desktopVersion === 'string' && parsed.desktopVersion.length > 0) {
        hostVersionCache = parsed.desktopVersion;
        return hostVersionCache;
      }
    } catch {
      // Not every layout has this file; try the next one.
    }
  }
  return hostVersionCache;
}

export function createLogger(ctx) {
  const target = ctx !== null && typeof ctx === 'object' ? ctx.logger : undefined;
  const prefix = '[dsh-modapi]';
  const make = (level) => (...args) => {
    try {
      if (target !== undefined && typeof target[level] === 'function') target[level](...args);
      else if (level === 'debug') return;
      else console[level === 'warn' ? 'warn' : level === 'error' ? 'error' : 'log'](prefix, ...args);
    } catch {
      // Logging never breaks the plugin.
    }
  };
  return { debug: make('debug'), info: make('info'), warn: make('warn'), error: make('error') };
}

export function apply(ctx, rawConfig = {}) {
  const config = normalizeConfig(rawConfig);
  const logger = createLogger(ctx);
  const instance = createModapi({
    ctx,
    config,
    dshHome: resolveDshHome(),
    logger,
    hostVersion: readHostVersion(),
    currentSessionId: process.env.DSH_SESSION_ID,
  });
  const api = instance.api;

  ctx.provide('modapi', api);

  const bridge = registerBridge(ctx, {
    info: () => api.info(),
    notices: (after, waitMs) => instance.store.wait(after, waitMs),
    ack: (ids) => instance.store.ack(ids),
    selfcheck: () => instance.selfcheck.run({ deep: true, notify: false }),
    ui: () => api.ui.serialize(),
    uiHit: (id) => api.ui.hit(id),
    clientPing: (body) => instance.noteClientPing(body),
    reject: (request) => {
      const connection = instance.compat.getService('connection');
      const check = connection?.requestRejection;
      if (typeof check !== 'function') return undefined;
      try {
        return check.call(connection, request);
      } catch {
        return undefined;
      }
    },
  }, { log: logger });

  instance.setBridgeProbe(() => (bridge.installed() ? true : (bridge.failure() ?? 'pending')));
  if (!bridge.installed()) logger.debug(`[dsh-modapi] notice bridge not mounted yet: ${bridge.failure() ?? 'pending'}`);

  ctx.effect(() => () => {
    bridge.dispose();
    return instance.dispose();
  });

  void instance.start()
    .then((result) => {
      if (result.report !== undefined && result.report.ok === false) {
        logger.warn(`[dsh-modapi] started with ${result.report.missing.length} missing capability(ies): ${result.report.missing.map((item) => item.id).join(', ')}`);
      }
      logger.info(`[dsh-modapi] started (api ${API_VERSION}, host ${readHostVersion() || 'unknown'}, ready ${result.ready})`);
    })
    .catch((error) => {
      logger.error(`[dsh-modapi] start failed: ${messageOf(error)}`);
      try {
        api.公告({ level: 'error', title: 'modapi 启动失败', body: messageOf(error), duration: 0 }).show();
      } catch {
        // The notice channel may be the thing that failed.
      }
    });

  return api;
}

export const __internals = {
  normalizeConfig,
  resolveDshHome,
  readHostVersion,
  createLogger,
  createModapi,
  registerBridge,
  BRIDGE_PREFIX,
};
