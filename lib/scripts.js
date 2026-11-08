/**
 * ModPE-style script host, extended with `modapi.mod.json` mods.
 *
 * Two shapes live here on purpose:
 *
 * - flat scripts: every `*.js` in `$DSH_HOME/modapi/scripts/` (or extra dirs)
 *   runs once, and top-level functions named after hooks auto-register;
 * - mods: a directory under `$DSH_HOME/modapi/mods/` with `modapi.mod.json`
 *   declares an id, a version, entrypoints and the API modules it needs.
 *
 * `vm` gives separate globals and file names in stack traces, not a security
 * boundary: these are the user's own scripts, running with the host's authority.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { AUTO_HOOK_NAMES } from './hooks.js';
import { messageOf } from './errors.js';
import { discoverMods } from './manifest.js';
import { satisfies } from './semver.js';

export function scriptDirectories(options = {}) {
  const out = [];
  const cwd = typeof options.cwd === 'string' && options.cwd.length > 0 ? options.cwd : process.cwd();
  if (typeof options.dshHome === 'string' && options.dshHome.length > 0) {
    out.push(path.join(options.dshHome, 'modapi', 'scripts'));
  }
  for (const dir of Array.isArray(options.scriptDirs) ? options.scriptDirs : []) {
    if (typeof dir === 'string' && dir.length > 0) out.push(path.resolve(cwd, dir));
  }
  return [...new Set(out)];
}

export function modDirectories(options = {}) {
  const out = [];
  const cwd = typeof options.cwd === 'string' && options.cwd.length > 0 ? options.cwd : process.cwd();
  if (typeof options.dshHome === 'string' && options.dshHome.length > 0) {
    out.push(path.join(options.dshHome, 'modapi', 'mods'));
  }
  for (const dir of Array.isArray(options.modDirs) ? options.modDirs : []) {
    if (typeof dir === 'string' && dir.length > 0) out.push(path.resolve(cwd, dir));
  }
  return [...new Set(out)];
}

export function discoverScripts(options = {}) {
  const cwd = typeof options.cwd === 'string' && options.cwd.length > 0 ? options.cwd : process.cwd();
  const found = new Map();
  for (const dir of scriptDirectories(options)) {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    const files = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.js'))
      .map((entry) => path.join(dir, entry.name))
      .sort((a, b) => a.localeCompare(b));
    for (const file of files) found.set(file, file);
  }
  for (const file of Array.isArray(options.scripts) ? options.scripts : []) {
    if (typeof file === 'string' && file.length > 0) {
      const resolved = path.resolve(cwd, file);
      if (!found.has(resolved)) found.set(resolved, resolved);
    }
  }
  return [...found.values()];
}

function buildPrelude(sourceTag) {
  const lines = [];
  for (const name of AUTO_HOOK_NAMES) {
    lines.push(`if (typeof ${name} === 'function') modapi.hook(${JSON.stringify(name)}, ${name}, { source: ${JSON.stringify(sourceTag)} });`);
  }
  return lines.join('\n');
}

export function createScriptHost(options = {}) {
  const api = options.api;
  const hooks = options.hooks;
  const events = options.events ?? null;
  const modules = options.modules ?? null;
  const logger = options.logger ?? console;
  const config = options.config ?? {};
  const cwd = typeof options.cwd === 'string' && options.cwd.length > 0 ? options.cwd : process.cwd();
  const loaded = new Map();
  const registeredMods = new Map();
  const ownedEvents = new Map();
  let watchers = [];
  let debounce = null;

  const log = {
    debug: (...args) => logger.debug?.(...args),
    info: (...args) => logger.info?.(...args),
    warn: (...args) => logger.warn?.(...args),
    error: (...args) => logger.error?.(...args),
  };

  function sourceTagFor(file) {
    return `script:${file}`;
  }

  /** Removes every subscription a file created, hooks and events alike. */
  function cleanupSource(tag) {
    hooks.removeBySource(tag);
    events?.removeBySource(tag);
    for (const name of ownedEvents.get(tag) ?? []) events?.remove(name);
    ownedEvents.delete(tag);
  }

  /**
   * Scripts get the same surface, but `hook()` defaults its source to this
   * file. A script that fails after registering must not leave subscribers
   * that no cleanup path can name.
   */
  function scopedApi(tag) {
    return new Proxy(api, {
      get(target, property) {
        if (property === 'hook') {
          return (name, handler, options = {}) => target.hook(name, handler, {
            source: tag,
            ...(options !== null && typeof options === 'object' ? options : {}),
          });
        }
        if (property === 'events' && target.events !== undefined) {
          return {
            ...target.events,
            on(name, listener, options = {}) {
              return target.events.on(name, listener, { source: tag, ...(options ?? {}) });
            },
            create(name, options = {}) {
              const event = target.events.create(name, options);
              const owned = ownedEvents.get(tag) ?? [];
              if (!owned.includes(name)) owned.push(name);
              ownedEvents.set(tag, owned);
              return event;
            },
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }

  function sandboxFor(file, source, tag = sourceTagFor(file)) {
    const sandbox = {
      modapi: scopedApi(tag),
      work: api.work,
      session: api.session,
      tool: api.tool,
      fs: api.fs,
      notice: api.notice,
      toast: api.toast,
      公告: api.公告,
      events: api.events,
      registry: api.registry,
      log: (...args) => log.info(...args),
      sleep: api.sleep,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      __filename: file,
      __dirname: path.dirname(file),
      __source: source,
    };
    sandbox.console = {
      log: (...args) => log.info(...args),
      info: (...args) => log.info(...args),
      warn: (...args) => log.warn(...args),
      error: (...args) => log.error(...args),
      debug: (...args) => log.debug(...args),
    };
    return vm.createContext(sandbox, { name: `modapi:${path.basename(file)}` });
  }

  async function runFile(file, { autoHooks = true } = {}) {
    const absolute = path.resolve(cwd, file);
    let source;
    try {
      source = fs.readFileSync(absolute, 'utf8');
    } catch (error) {
      log.warn(`[dsh-modapi] cannot read script ${absolute}: ${messageOf(error)}`);
      return null;
    }
    const tag = sourceTagFor(absolute);
    cleanupSource(tag);
    const prelude = autoHooks ? `\n;\n${buildPrelude(tag)}` : '';
    const wrapped = `(async () => {\n${source}${prelude}\n})()`;
    let script;
    try {
      script = new vm.Script(wrapped, { filename: absolute, displayErrors: true });
    } catch (error) {
      log.warn(`[dsh-modapi] cannot compile script ${absolute}: ${messageOf(error)}`);
      return null;
    }
    const context = sandboxFor(absolute, source, tag);
    try {
      await script.runInContext(context, { timeout: 15000, breakOnSigint: false });
    } catch (error) {
      cleanupSource(tag);
      log.warn(`[dsh-modapi] script ${absolute} failed: ${messageOf(error)}`);
      return null;
    }
    return { absolute, source, tag, hooks: AUTO_HOOK_NAMES.filter((name) => hooks.has(name) && hooks.describe().some((item) => item.name === name && item.sources.includes(tag))) };
  }

  async function loadFile(file) {
    const result = await runFile(file, { autoHooks: true });
    if (result === null) return null;
    const record = {
      file: result.absolute,
      name: path.basename(result.absolute),
      source: result.tag,
      hooks: result.hooks,
      size: Buffer.byteLength(result.source),
      at: new Date().toISOString(),
    };
    loaded.set(result.absolute, record);
    log.info(`[dsh-modapi] script ${record.name} registered: ${record.hooks.join(', ') || '(no hooks)'}`);
    return record;
  }

  /** Returns `{ok: true}` or `{ok: false, reason}` for the mod's `requires`. */
  function checkRequires(manifest) {
    const failures = [];
    for (const [name, range] of Object.entries(manifest.requires)) {
      if (name === 'modapi') {
        const version = typeof api.apiVersion === 'string' ? api.apiVersion : '1';
        if (!satisfies(version, range)) failures.push(`modapi ${version} does not satisfy ${range}`);
        continue;
      }
      const module = modules?.get(name);
      if (module === undefined) {
        failures.push(`${name} (missing) does not satisfy ${range}`);
        continue;
      }
      if (!satisfies(module.version, range)) failures.push(`${name} ${module.version} does not satisfy ${range}`);
    }
    return failures.length === 0 ? { ok: true } : { ok: false, reason: failures.join('; ') };
  }

  function recordMod(manifest, status, details = {}) {
    const record = {
      id: manifest.id,
      version: manifest.version,
      name: manifest.name,
      dir: manifest.dir,
      status,
      requires: { ...manifest.requires },
      depends: { ...manifest.depends },
      files: details.files ?? [],
      hooks: details.hooks ?? [],
      entrypoints: {
        start: [...(manifest.entrypoints.start ?? [])],
        stop: [...(manifest.entrypoints.stop ?? [])],
      },
      reason: details.reason ?? '',
    };
    registeredMods.set(manifest.id, record);
    return record;
  }
  async function loadMods() {
    const manifests = discoverMods({
      dshHome: options.dshHome,
      modDirs: config.modDirs,
      cwd,
      onError: (error, detail) => log.warn(`[dsh-modapi] mod manifest skipped (${detail?.file ?? '?'}): ${messageOf(error)}`),
    });
    const pending = new Map(manifests.map((manifest) => [manifest.id, manifest]));
    let progress = pending.size > 0;
    while (pending.size > 0 && progress) {
      progress = false;
      for (const [id, manifest] of [...pending]) {
        const depNames = Object.keys(manifest.depends);
        const ready = depNames.every((dep) => registeredMods.get(dep)?.status === 'loaded');
        if (!ready) continue;
        const badDep = Object.entries(manifest.depends).find(([dep, range]) => !satisfies(registeredMods.get(dep).version, range));
        pending.delete(id);
        progress = true;
        if (badDep !== undefined) {
          const [dep, range] = badDep;
          const reason = `${dep} ${registeredMods.get(dep).version} does not satisfy ${range}`;
          recordMod(manifest, 'failed', { reason });
          log.warn(`[dsh-modapi] mod ${id} skipped: ${reason}`);
          continue;
        }
        const requires = checkRequires(manifest);
        if (!requires.ok) {
          recordMod(manifest, 'failed', { reason: requires.reason });
          log.warn(`[dsh-modapi] mod ${id} skipped: ${requires.reason}`);
          continue;
        }
        const files = [];
        let ok = true;
        for (const entry of manifest.entrypoints.start ?? []) {
          const record = await loadFile(entry);
          if (record === null) {
            ok = false;
            break;
          }
          files.push(record);
        }
        if (!ok) {
          for (const entry of manifest.entrypoints.start ?? []) cleanupSource(sourceTagFor(path.resolve(cwd, entry)));
          for (const file of files) loaded.delete(file.file);
          recordMod(manifest, 'failed', { reason: 'an entrypoint did not run' });
          log.warn(`[dsh-modapi] mod ${id} failed while loading its entrypoints`);
          continue;
        }
        recordMod(manifest, 'loaded', { files: files.map((file) => file.file), hooks: [...new Set(files.flatMap((file) => file.hooks))] });
        log.info(`[dsh-modapi] mod ${id}@${manifest.version} loaded: ${files.length} entrypoint(s)`);
      }
    }
    for (const [id, manifest] of pending) {
      recordMod(manifest, 'failed', { reason: 'unmet dependency in the load order' });
      log.warn(`[dsh-modapi] mod ${id} skipped: unmet dependency in the load order`);
    }
    return mods();
  }
  async function unloadMod(id) {
    const record = registeredMods.get(id);
    if (record === undefined) return false;
    const stopFiles = [];
    for (const stop of record.entrypoints?.stop ?? []) {
      const absolute = path.resolve(cwd, stop);
      stopFiles.push(absolute);
      await runFile(absolute, { autoHooks: false });
    }
    for (const file of [...record.files, ...stopFiles]) cleanupSource(sourceTagFor(file));
    for (const file of [...record.files, ...stopFiles]) loaded.delete(file);
    registeredMods.delete(id);
    return true;
  }

  async function load() {
    const targets = discoverScripts({ dshHome: options.dshHome, scriptDirs: config.scriptDirs, scripts: config.scripts, cwd });
    for (const file of targets) await loadFile(file);
    await loadMods();
    if (config.watchScripts === true) watch();
    return files();
  }

  async function reload(file) {
    const absolute = path.resolve(cwd, file);
    cleanupSource(sourceTagFor(absolute));
    loaded.delete(absolute);
    return loadFile(absolute);
  }

  function unload(file) {
    const absolute = path.resolve(cwd, file);
    const record = loaded.get(absolute);
    if (record === undefined) return false;
    cleanupSource(record.source);
    loaded.delete(absolute);
    return true;
  }

  function watch() {
    if (watchers.length > 0) return watchers.length;
    for (const dir of scriptDirectories({ dshHome: options.dshHome, scriptDirs: config.scriptDirs, cwd })) {
      try {
        const watcher = fs.watch(dir, (_event, filename) => {
          if (typeof filename !== 'string' || !filename.endsWith('.js')) return;
          clearTimeout(debounce);
          debounce = setTimeout(() => {
            void reload(path.join(dir, filename));
          }, 200);
        });
        watcher.on?.('error', (error) => log.warn(`[dsh-modapi] script watcher failed: ${messageOf(error)}`));
        watchers.push(watcher);
      } catch {
        // A missing directory is normal: the user has not written scripts yet.
      }
    }
    return watchers.length;
  }
  function files() {
    return [...loaded.values()].map((record) => ({ ...record, hooks: [...record.hooks] }));
  }

  function mods() {
    return [...registeredMods.values()].map((record) => ({
      ...record,
      requires: { ...record.requires },
      depends: { ...record.depends },
      files: [...record.files],
      hooks: [...record.hooks],
      entrypoints: {
        start: [...record.entrypoints.start],
        stop: [...record.entrypoints.stop],
      },
    }));
  }

  function dispose() {
    clearTimeout(debounce);
    debounce = null;
    for (const watcher of watchers) {
      try {
        watcher.close();
      } catch {
        // Closing an already-dead watcher is not a failure worth reporting.
      }
    }
    watchers = [];
    for (const absolute of [...loaded.keys()]) unload(absolute);
    registeredMods.clear();
  }

  return {
    load,
    reload,
    unload,
    unloadMod,
    watch,
    dispose,
    files,
    mods,
    get size() { return loaded.size; },
    get modCount() { return registeredMods.size; },
  };
}
