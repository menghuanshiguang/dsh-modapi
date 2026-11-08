/**
 * Assembly: one API object exposed as the `modapi` service.
 *
 * Domains are built once; each resolves its host service lazily on call, so a
 * DSH build missing a domain still yields a working plugin that reports the gap
 * instead of failing to load.
 */
import { createCompat } from './compat.js';
import { EventBus } from './events.js';
import { RegistryManager } from './registry.js';
import { ModuleRegistry, MODULE_VERSION } from './modules.js';
import { HookRegistry, HOOK_NAMES, WIRED_HOOKS, AUTO_HOOK_NAMES } from './hooks.js';
import { NoticeStore, createNoticeFactory, NOTICE_LEVELS } from './notices.js';
import { createSelfCheck } from './selfcheck.js';
import { createScriptHost } from './scripts.js';
import { createWorkDomain } from './domains/work.js';
import { createSessionDomain } from './domains/session.js';
import { createToolDomain } from './domains/tool.js';
import { createFsDomain } from './domains/fs.js';
import { createPatcher } from './patcher.js';
import { createUiDomain } from './ui.js';
import { messageOf } from './errors.js';

export const API_VERSION = '1';
export const PLUGIN_NAME = 'dsh-modapi';
export const PLUGIN_VERSION = '0.3.0';

export const CONFIG_DEFAULTS = Object.freeze({
  startupTimeoutMs: 15000,
  noticeLimit: 64,
  noticeTtlMs: 600000,
  hookLimitPerName: 64,
  patchLimit: 512,
  uiRuleLimit: 64,
  scriptDirs: [],
  scripts: [],
  modDirs: [],
  watchScripts: false,
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

export const PROBE_SERVICES = Object.freeze({
  work: ['workspaceRegistry'],
  session: ['sessions', 'sessionStore'],
  tool: ['tools'],
  fs: ['fs', 'filesystem'],
  webServer: ['webServer'],
  appReady: ['appReady'],
  connection: ['connection'],
});

export function createModapi(options = {}) {
  const { ctx, config = {}, dshHome, logger = console, hostVersion = '', currentSessionId } = options;
  const merged = { ...CONFIG_DEFAULTS, ...config };

  const store = new NoticeStore({ limit: merged.noticeLimit, ttlMs: merged.noticeTtlMs });
  const notice = createNoticeFactory(store);
  const hooks = new HookRegistry({ limitPerName: merged.hookLimitPerName, logger });
  const events = new EventBus({
    limit: merged.hookLimitPerName,
    logger,
    onError: (error, context) => hooks.report(error, { hook: context.event, source: context.source }),
  });
  const registries = new RegistryManager({ limit: merged.hookLimitPerName * 64 });
  const modules = new ModuleRegistry({ apiVersion: API_VERSION, logger });
  const patches = createPatcher({
    limit: merged.patchLimit,
    logger,
    onError: (error, context) => hooks.report(error, { hook: 'patch', source: context.source }),
  });
  const ui = createUiDomain({ limit: merged.uiRuleLimit });

  let selfcheck;
  const compat = createCompat(ctx, logger, {
    onUnsupported: (info) => selfcheck?.noteUnsupported(info),
  });

  const domains = {
    work: createWorkDomain(compat),
    session: createSessionDomain(compat, { currentSessionId }),
    tool: createToolDomain(compat),
    fs: createFsDomain(compat),
  };

  let bridgeProbe = () => 'pending';
  selfcheck = createSelfCheck({
    compat,
    notices: notice,
    logger,
    dshHome,
    hostVersion,
    probeBridge: () => bridgeProbe(),
  });

  let startedAt;
  let started = false;
  let disposing = false;
  let lastReport;
  let disposers = [];
  let scriptHost;

  function logAt(level) {
    return (...args) => {
      try {
        const target = logger?.[level] ?? logger?.log;
        if (typeof target === 'function') target.apply(logger, args);
      } catch {
        // A logging failure must never become an API failure.
      }
    };
  }

  const api = {
    /** Plugin version, matching `info().version`. */
    version: PLUGIN_VERSION,
    /** Contract revision this build implements. */
    apiVersion: API_VERSION,
    name: PLUGIN_NAME,
    pluginVersion: PLUGIN_VERSION,
    work: domains.work,
    session: domains.session,
    tool: domains.tool,
    fs: domains.fs,
    patch: {
      method: (target, key, spec) => patches.method(target, key, spec),
      restore: (id) => patches.restore(id),
      restoreBySource: (source) => patches.restoreBySource(source),
      restoreAll: () => patches.restoreAll(),
      list: () => patches.list(),
      describe: () => patches.describe(),
      get size() {
        return patches.size;
      },
    },
    ui: {
      hook: (spec) => ui.add(spec),
      unhook: (id) => ui.remove(id),
      hit: (id) => ui.hit(id),
      get: (id) => ui.get(id),
      has: (id) => ui.has(id),
      list: () => ui.list(),
      clear: () => ui.clear(),
      serialize: () => ui.serialize(),
      removeBySource: (source) => ui.removeBySource(source),
      describe: () => ui.describe(),
      get version() {
        return ui.version;
      },
    },

    hook(name, handler, hookOptions = {}) {
      return hooks.on(name, handler, hookOptions);
    },
    unhook(name, handler) {
      return hooks.off(name, handler);
    },
    fire(name, payload) {
      return hooks.fire(name, payload);
    },
    hooks() {
      return hooks.describe();
    },
    hookNames: HOOK_NAMES,
    wiredHooks: WIRED_HOOKS,

    /**
     * Canonical hook namespace. The flat `hook/unhook/fire` names are kept as
     * aliases because scripts written against 0.1.x call them directly.
     */
    hooks: {
      on: (name, handler, hookOptions) => hooks.on(name, handler, hookOptions),
      off: (name, handler) => hooks.off(name, handler),
      fire: (name, payload) => hooks.fire(name, payload),
      describe: () => hooks.describe(),
      names: () => hooks.names(),
      wired: () => [...WIRED_HOOKS],
      clear: () => hooks.clear(),
    },

    /** Named events (Fabric-style), independent of the fixed hook list. */
    events: {
      create: (name, eventOptions) => events.create(name, eventOptions),
      get: (name) => events.get(name),
      has: (name) => events.has(name),
      names: () => events.names(),
      remove: (name) => events.remove(name),
      on: (name, listener, listenerOptions) => events.on(name, listener, listenerOptions),
      fire: (name, ...args) => events.fire(name, ...args),
      describe: () => events.describe(),
    },

    /** Namespaced content registries, e.g. "mymod:item". */
    registry: {
      create: (name, registryOptions) => registries.create(name, registryOptions),
      use: (name) => registries.use(name),
      get: (name) => registries.get(name),
      has: (name) => registries.has(name),
      names: () => registries.names(),
      remove: (name) => registries.remove(name),
      describe: () => registries.describe(),
    },

    /** Per-module API versions: a mod states what it needs, not what exists. */
    modules: {
      has: (name) => modules.has(name),
      get: (name) => modules.get(name),
      names: () => modules.names(),
      list: () => modules.list(),
      describe: () => modules.describe(),
      supports: (spec) => modules.supports(spec),
    },
    requires(spec) {
      return modules.require(spec, { context: 'modapi.requires' });
    },
    api(name) {
      const record = modules.get(name);
      return record && record.value !== undefined ? record.value : record;
    },

    notice,
    公告: notice,
    toast: notice,
    Toast: notice.Toast,
    noticeLevels: NOTICE_LEVELS,

    selfcheck: {
      run: (runOptions) => selfcheck.run(runOptions),
      snapshot: () => selfcheck.snapshot(),
      resetFailures: () => selfcheck.resetFailures(),
      get statePath() {
        return selfcheck.statePath;
      },
    },

    health() {
      return {
        ok: lastReport === undefined ? null : lastReport.ok,
        started,
        apiVersion: API_VERSION,
        hostVersion,
        services: compat.probe(PROBE_SERVICES),
        hooks: hooks.names().length,
        events: events.names().length,
        registries: registries.names().length,
        patches: patches.size,
        uiRules: ui.size,
        notices: store.size,
        scripts: scriptHost === undefined ? 0 : scriptHost.size,
        mods: scriptHost === undefined ? 0 : scriptHost.modCount,
        missing: lastReport === undefined ? [] : lastReport.missing.map((item) => item.id),
      };
    },
    info() {
      return {
        name: PLUGIN_NAME,
        version: PLUGIN_VERSION,
        apiVersion: API_VERSION,
        hostVersion,
        dshHome: dshHome ?? null,
        startedAt: startedAt ?? null,
        uptimeMs: startedAt === undefined ? 0 : Date.now() - Date.parse(startedAt),
        hooks: hooks.describe(),
        events: events.describe(),
        registries: registries.describe(),
        patches: patches.describe(),
        ui: ui.describe(),
        modules: modules.describe(),
        mods: scriptHost === undefined ? [] : scriptHost.mods(),
        notices: store.size,
        scripts: scriptHost === undefined ? [] : scriptHost.files(),
        selfcheck: selfcheck.snapshot(),
      };
    },
    services() {
      return compat.probe(PROBE_SERVICES);
    },
    require(name) {
      return compat.requireService(name, 'modapi', 'require', 'pass a host service name such as "workspaceRegistry"');
    },

    log: {
      debug: logAt('debug'),
      info: logAt('info'),
      warn: logAt('warn'),
      error: logAt('error'),
    },
    sleep,
    utils: { sleep },
  };

  scriptHost = createScriptHost({ api, hooks, events, modules, logger, dshHome, config: merged });
  Object.defineProperty(api, 'scripts', {
    enumerable: true,
    value: {
      load: () => scriptHost.load(),
      reload: (file) => scriptHost.reload(file),
      unload: (file) => scriptHost.unload(file),
      watch: () => scriptHost.watch(),
      files: () => scriptHost.files(),
      mods: () => scriptHost.mods(),
      unloadMod: (id) => scriptHost.unloadMod(id),
      get size() {
        return scriptHost.size;
      },
      get modCount() {
        return scriptHost.modCount;
      },
    },
  });

  // Expose the real API face behind each built-in module so `modapi.api('work')`
  // returns the same object as `modapi.work`, while `modules.get()` stays the record.
  for (const [moduleName, moduleValue] of Object.entries({
    work: domains.work,
    session: domains.session,
    tool: domains.tool,
    fs: domains.fs,
    notice,
    events: api.events,
    registry: api.registry,
    patch: api.patch,
    ui: api.ui,
    hooks: api.hooks,
    scripts: api.scripts,
    selfcheck: api.selfcheck,
  })) {
    modules.provide(moduleName, MODULE_VERSION, { source: 'builtin', value: moduleValue });
  }

  /** Listen to host events; each listener is removed by its own disposer. */
  function wireHostEvents() {
    const attached = [];
    const listen = (event, handler) => {
      try {
        const disposer = ctx.on(event, handler);
        attached.push(disposer);
      } catch (error) {
        logAt('warn')(`[dsh-modapi] cannot subscribe to ${event}: ${messageOf(error)}`);
      }
    };
    const fanOut = (hook, event, build) => {
      listen(event, (...args) => {
        const payload = build(...args);
        void hooks.fire(hook, payload);
        events.fire(event, payload);
      });
    };
    fanOut('sessioncreate', 'session/created', (session) => ({ session }));
    fanOut('sessiondelete', 'session/disposed', (session) => ({ session }));
    fanOut('messagereceive', 'session/event', (session, event) => ({ session, event }));
    fanOut('toolresult', 'tools/result', (exec, result) => ({ exec, result }));
    listen('tools/pre-execute', (exec, next) => {
      void hooks.fire('toolcall', { exec });
      events.fire('tools/pre-execute', { exec });
      return typeof next === 'function' ? next() : undefined;
    });
    return attached;
  }

  /** Resolve when the host is ready, without blocking the plugin forever. */
  async function waitForReady() {
    const budget = Math.max(0, merged.startupTimeoutMs);
    const appReady = compat.getService('appReady');
    if (appReady !== undefined && typeof appReady.then === 'function') {
      try {
        await Promise.race([appReady, sleep(budget).then(() => Symbol.for('modapi.timeout'))]);
        return 'ready';
      } catch {
        return 'failed';
      }
    }
    const deadline = Date.now() + budget;
    while (Date.now() < deadline) {
      if (compat.getFirstService(['sessions', 'sessionStore']) !== undefined) return 'polled';
      await sleep(100);
    }
    return 'timeout';
  }

  /**
   * Give late-activating services a moment: a plugin mounted after the host
   * reports ready must not look like a DSH regression.
   */
  async function settleServices(budgetMs) {
    const names = ['workspaceRegistry', 'sessions', 'sessionStore', 'tools', 'fs', 'filesystem', 'webServer', 'appReady', 'connection'];
    const deadline = Date.now() + Math.min(budgetMs, 8000);
    let previous = -1;
    let stable = 0;
    while (Date.now() < deadline) {
      const present = names.filter((name) => compat.getService(name) !== undefined).length;
      if (present === previous) {
        stable += 1;
        if (stable >= 2) return present;
      } else {
        previous = present;
        stable = 0;
      }
      await sleep(100);
    }
    return names.filter((name) => compat.getService(name) !== undefined).length;
  }

  async function start() {
    if (started) return { report: lastReport, disposers, ready: 'already-started' };
    startedAt = new Date().toISOString();
    disposers = wireHostEvents();
    try {
      await scriptHost.load();
    } catch (error) {
      logAt('warn')(`[dsh-modapi] script load failed: ${messageOf(error)}`);
    }
    const ready = await waitForReady();
    const settled = await settleServices(Math.min(merged.startupTimeoutMs, 8000));
    logAt('debug')(`[dsh-modapi] ${settled} services available after ready (${ready})`);
    lastReport = await selfcheck.run({ deep: true, notify: true });
    const payload = { api, info: api.info(), selfcheck: lastReport, ready };
    events.fire('modapi:startup', payload);
    await hooks.fire('checkstart', payload);
    started = true;
    return { report: lastReport, disposers, ready };
  }

  /**
   * Tear down in reverse order. Cleanup runs even when `checkstop` throws: a
   * plugin that cannot tear down cleanly leaks listeners across a hot reload.
   */
  async function dispose() {
    if (disposing) return;
    disposing = true;
    let stopError;
    const payload = { api, info: api.info() };
    try {
      events.fire('modapi:shutdown', payload);
      await hooks.fire('checkstop', payload);
    } catch (error) {
      stopError = error;
    }
    for (const disposer of disposers.splice(0)) {
      try {
        disposer?.();
      } catch (error) {
        logAt('warn')(`[dsh-modapi] disposer failed: ${messageOf(error)}`);
      }
    }
    try {
      scriptHost.dispose();
    } catch (error) {
      logAt('warn')(`[dsh-modapi] script dispose failed: ${messageOf(error)}`);
    }
    patches.restoreAll();
    ui.clear();
    hooks.clear();
    events.clear();
    store.close();
    if (stopError !== undefined) logAt('warn')(`[dsh-modapi] checkstop failed: ${messageOf(stopError)}`);
  }

  return {
    api,
    start,
    dispose,
    hooks,
    events,
    registries,
    modules,
    patches,
    ui,
    store,
    selfcheck,
    compat,
    scripts: () => scriptHost,
    setBridgeProbe(probe) {
      bridgeProbe = typeof probe === 'function' ? probe : () => 'pending';
    },
  };
}
