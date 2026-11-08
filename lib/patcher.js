/**
 * Method hooks — the Xposed half of this API.
 *
 * `patch.method(target, "name", { before, after, replace })` replaces
 * `target.name` with a wrapper that keeps the original reachable only through
 * the controller. Every hook sees the same `this` and the same argument array,
 * and `before` returning `false` cancels the original (Xposed's `XC_MethodHook`
 * contract). Restoring puts the original function back, including the
 * "was it an own property" detail, so a patched prototype method disappears
 * again instead of leaving a shadow on the instance.
 */
import { ModapiError, ERROR_CODES, messageOf } from './errors.js';

export const DEFAULT_PATCH_LIMIT = 512;

function isObjectLike(value) {
  return (typeof value === 'object' && value !== null) || typeof value === 'function';
}

function isThenable(value) {
  return value !== null && typeof value === 'object' && typeof value.then === 'function';
}

export class Patcher {
  #targets = new Map();
  #byId = new Map();
  #nextId = 1;
  #limit;
  #logger;
  #onError;

  constructor(options = {}) {
    this.#limit = Number.isFinite(options.limit) && options.limit > 0 ? options.limit : DEFAULT_PATCH_LIMIT;
    this.#logger = options.logger ?? null;
    this.#onError = typeof options.onError === 'function' ? options.onError : null;
  }

  get size() {
    return this.#byId.size;
  }

  /**
   * Hooks one method. `spec` may contain any of `before`, `after`, `replace`
   * (functions), plus `name` and `source` for bookkeeping.
   */
  method(target, key, spec = {}) {
    if (!isObjectLike(target)) {
      throw new ModapiError(ERROR_CODES.BAD_ARGUMENT, 'patch.method needs an object or function as target', { domain: 'patch', method: 'method' });
    }
    if (typeof key !== 'string' || key.length === 0) {
      throw new ModapiError(ERROR_CODES.BAD_ARGUMENT, 'patch.method needs a method name', { domain: 'patch', method: 'method' });
    }
    const hasBefore = typeof spec.before === 'function';
    const hasAfter = typeof spec.after === 'function';
    const hasReplace = typeof spec.replace === 'function';
    if (!hasBefore && !hasAfter && !hasReplace) {
      throw new ModapiError(ERROR_CODES.BAD_ARGUMENT, 'patch.method needs at least one of before/after/replace', { domain: 'patch', method: 'method' });
    }

    const entry = this.#ensureEntry(target, key);
    if (this.#byId.size >= this.#limit) {
      throw new ModapiError(ERROR_CODES.CONFLICT, `patch limit (${this.#limit}) reached`, { domain: 'patch', method: 'method', hint: 'call patch.restore() for hooks you no longer need' });
    }

    const hook = {
      id: `patch-${this.#nextId++}`,
      key,
      before: hasBefore ? spec.before : null,
      after: hasAfter ? spec.after : null,
      replace: hasReplace ? spec.replace : null,
      name: typeof spec.name === 'string' ? spec.name : key,
      source: typeof spec.source === 'string' ? spec.source : 'plugin',
      enabled: true,
      hits: 0,
      errors: 0,
      createdAt: Date.now(),
    };
    entry.hooks.push(hook);
    this.#byId.set(hook.id, { entry, hook });
    this.#install(entry);

    const patcher = this;
    return {
      id: hook.id,
      get enabled() {
        return hook.enabled;
      },
      enable() {
        hook.enabled = true;
        return hook.id;
      },
      disable() {
        hook.enabled = false;
        return hook.id;
      },
      restore() {
        return patcher.restore(hook.id);
      },
      describe() {
        return { id: hook.id, target: entry.label, method: hook.key, name: hook.name, source: hook.source, hooks: { before: Boolean(hook.before), after: Boolean(hook.after), replace: Boolean(hook.replace) }, enabled: hook.enabled, hits: hook.hits };
      },
    };
  }

  restore(id) {
    const record = this.#byId.get(id);
    if (record === undefined) return false;
    const { entry, hook } = record;
    this.#byId.delete(id);
    entry.hooks = entry.hooks.filter((item) => item !== hook);
    if (entry.hooks.length === 0) this.#uninstall(entry);
    return true;
  }

  /** Removes every hook registered from `source` (used when a script unloads). */
  restoreBySource(source) {
    let removed = 0;
    for (const [id, record] of [...this.#byId.entries()]) {
      if (record.hook.source === source) {
        this.restore(id);
        removed += 1;
      }
    }
    return removed;
  }

  restoreAll() {
    let removed = 0;
    for (const id of [...this.#byId.keys()]) {
      this.restore(id);
      removed += 1;
    }
    return removed;
  }

  list() {
    return [...this.#byId.values()].map(({ entry, hook }) => ({
      id: hook.id,
      target: entry.label,
      method: hook.key,
      name: hook.name,
      source: hook.source,
      hooks: { before: Boolean(hook.before), after: Boolean(hook.after), replace: Boolean(hook.replace) },
      enabled: hook.enabled,
      hits: hook.hits,
      errors: hook.errors,
    }));
  }

  describe() {
    return { size: this.#byId.size, targets: this.#targets.size, hooks: this.list() };
  }

  #ensureEntry(target, key) {
    let byKey = this.#targets.get(target);
    if (byKey === undefined) {
      byKey = new Map();
      this.#targets.set(target, byKey);
    }
    const existing = byKey.get(key);
    if (existing !== undefined) return existing;

    const descriptor = findDescriptor(target, key);
    if (descriptor === undefined || typeof descriptor.value !== 'function') {
      throw new ModapiError(ERROR_CODES.BAD_ARGUMENT, `${describeTarget(target)}.${key} is not a function`, { domain: 'patch', method: 'method' });
    }
    if (descriptor.writable === false && descriptor.configurable === false) {
      throw new ModapiError(ERROR_CODES.DENIED, `${describeTarget(target)}.${key} is not patchable`, { domain: 'patch', method: 'method' });
    }

    const entry = {
      target,
      key,
      label: describeTarget(target),
      original: descriptor.value,
      descriptor,
      hadOwn: Object.prototype.hasOwnProperty.call(target, key),
      hooks: [],
      enabled: true,
      installed: false,
      wrapper: null,
    };
    byKey.set(key, entry);
    return entry;
  }

  #install(entry) {
    if (entry.installed) return;
    const patcher = this;
    const wrapper = function patched(...args) {
      return patcher.#dispatch(entry, this, args);
    };
    Object.defineProperty(wrapper, 'name', { value: entry.key, configurable: true });
    entry.wrapper = wrapper;
    entry.installed = true;
    defineValue(entry.target, entry.key, wrapper, entry.descriptor);
  }

  #uninstall(entry) {
    if (!entry.installed) return;
    entry.installed = false;
    if (entry.hadOwn) {
      defineValue(entry.target, entry.key, entry.original, entry.descriptor);
    } else {
      try {
        delete entry.target[entry.key];
      } catch (error) {
        defineValue(entry.target, entry.key, entry.original, entry.descriptor);
      }
    }
    entry.wrapper = null;
    const byKey = this.#targets.get(entry.target);
    if (byKey !== undefined) {
      byKey.delete(entry.key);
      if (byKey.size === 0) this.#targets.delete(entry.target);
    }
  }

  #dispatch(entry, thisArg, args) {
    const active = entry.hooks.filter((hook) => hook.enabled);
    if (active.length === 0) return entry.original.apply(thisArg, args);

    for (const hook of active) {
      hook.hits += 1;
      if (hook.before === null) continue;
      let decision;
      try {
        decision = hook.before.call(thisArg, args);
      } catch (error) {
        this.#report(error, hook, 'before');
        continue;
      }
      if (decision === false) return this.#finish(entry, active, thisArg, args, undefined, true);
    }

    const replacer = active.find((hook) => hook.replace !== null);
    let result;
    if (replacer !== undefined) {
      try {
        result = replacer.replace.call(thisArg, args);
      } catch (error) {
        this.#report(error, replacer, 'replace');
        result = undefined;
      }
      return this.#finish(entry, active, thisArg, args, result, false);
    }

    result = entry.original.apply(thisArg, args);
    if (isThenable(result) && active.some((hook) => hook.after !== null)) {
      return result.then((value) => this.#finish(entry, active, thisArg, args, value, false));
    }
    return this.#finish(entry, active, thisArg, args, result, false);
  }

  #finish(entry, active, thisArg, args, initial, cancelled) {
    // A cancelled call has no result to post-process: running after hooks here
    // would hand them undefined and produce surprises like "undefined!".
    if (cancelled) return initial;
    let value = initial;
    for (let index = active.length - 1; index >= 0; index -= 1) {
      const hook = active[index];
      if (hook.after === null) continue;
      try {
        const next = hook.after.call(thisArg, value, { args, cancelled, target: entry.target, method: entry.key });
        if (next !== undefined) value = next;
      } catch (error) {
        this.#report(error, hook, 'after');
      }
    }
    return value;
  }

  #report(error, hook, phase) {
    hook.errors += 1;
    const message = `[dsh-modapi] patch ${hook.key} ${phase} hook failed: ${messageOf(error)}`;
    this.#logger?.warn?.(message);
    this.#onError?.(error, { domain: 'patch', method: hook.key, phase, source: hook.source });
  }
}

function findDescriptor(target, key) {
  let cursor = target;
  while (cursor !== null && cursor !== undefined) {
    const descriptor = Object.getOwnPropertyDescriptor(cursor, key);
    if (descriptor !== undefined) return descriptor;
    cursor = Object.getPrototypeOf(cursor);
  }
  return undefined;
}

function defineValue(target, key, value, descriptor) {
  Object.defineProperty(target, key, {
    value,
    writable: descriptor.writable !== false,
    enumerable: descriptor.enumerable === true,
    configurable: true,
  });
}

function describeTarget(target) {
  if (typeof target === 'function') return target.name === '' ? 'anonymous function' : `function ${target.name}`;
  const ctor = target?.constructor;
  if (typeof ctor?.name === 'string' && ctor.name !== '') return ctor.name;
  return 'object';
}

export function createPatcher(options = {}) {
  return new Patcher(options);
}
