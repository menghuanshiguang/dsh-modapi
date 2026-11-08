/**
 * Named hooks with an honest wiring report.
 *
 * Only three hooks are wired by the runtime (`checkstart`, `checkstop`,
 * `onerror`). Everything else is a reserved name: registerable, fireable by
 * hand, but `describe()` reports `wired: false` so nobody believes a hook will
 * fire when it never will.
 */
import { ModapiError, ERROR_CODES, messageOf } from './errors.js';

export const HOOK_NAMES = Object.freeze([
  'checkstart',
  'checkstop',
  'onerror',
  'sessioncreate',
  'sessiondelete',
  'sessionarchive',
  'messagereceive',
  'toolcall',
  'toolresult',
  'pluginload',
  'pluginunload',
]);

export const WIRED_HOOKS = Object.freeze(['checkstart', 'checkstop', 'onerror', 'sessioncreate', 'sessiondelete', 'messagereceive', 'toolcall', 'toolresult']);

/** Top-level functions a script file may expose to auto-register. */
export const AUTO_HOOK_NAMES = HOOK_NAMES;

export class HookRegistry {
  #entries = new Map();
  #limit;
  #logger;
  #reporting = false;
  #sequence = 0;

  constructor(options = {}) {
    this.#limit = Number.isFinite(options.limitPerName) && options.limitPerName > 0 ? Math.floor(options.limitPerName) : 64;
    this.#logger = options.logger ?? null;
  }

  on(name, handler, options = {}) {
    if (typeof name !== 'string' || name.length === 0) {
      throw new ModapiError(ERROR_CODES.BAD_ARGUMENT, 'hook(name, handler) needs a hook name', { domain: 'hook', method: 'on' });
    }
    if (typeof handler !== 'function') {
      throw new ModapiError(ERROR_CODES.BAD_ARGUMENT, `hook "${name}" needs a function`, { domain: 'hook', method: 'on' });
    }
    const list = this.#entries.get(name) ?? [];
    if (list.length >= this.#limit) {
      throw new ModapiError(ERROR_CODES.CONFLICT, `hook "${name}" already has ${list.length} subscribers (limit ${this.#limit})`, {
        domain: 'hook',
        method: 'on',
        hint: 'Raise hookLimitPerName in the plugin config.',
      });
    }
    const entry = {
      handler,
      source: typeof options.source === 'string' && options.source.length > 0 ? options.source : 'plugin',
      order: Number.isFinite(options.order) ? options.order : 0,
      seq: this.#sequence++,
    };
    list.push(entry);
    list.sort((a, b) => a.order - b.order || a.seq - b.seq);
    this.#entries.set(name, list);
    return () => this.off(name, handler);
  }

  off(name, handler) {
    const list = this.#entries.get(name);
    if (list === undefined) return false;
    const index = list.findIndex((entry) => entry.handler === handler);
    if (index < 0) return false;
    list.splice(index, 1);
    if (list.length === 0) this.#entries.delete(name);
    return true;
  }

  has(name) {
    const list = this.#entries.get(name);
    return list !== undefined && list.length > 0;
  }

  count(name) {
    return this.#entries.get(name)?.length ?? 0;
  }

  names() {
    return [...this.#entries.keys()];
  }

  describe() {
    const out = [];
    for (const name of new Set([...HOOK_NAMES, ...this.#entries.keys()])) {
      const list = this.#entries.get(name) ?? [];
      out.push({
        name,
        count: list.length,
        wired: WIRED_HOOKS.includes(name),
        sources: [...new Set(list.map((entry) => entry.source))],
      });
    }
    return out;
  }

  /** Fire one hook. A throwing subscriber never prevents the others. */
  async fire(name, payload) {
    const list = [...(this.#entries.get(name) ?? [])];
    const results = [];
    let failed = 0;
    for (const entry of list) {
      try {
        results.push(await entry.handler(payload));
      } catch (error) {
        failed += 1;
        results.push(undefined);
        await this.#notifyError(error, { hook: name, source: entry.source });
      }
    }
    return { hook: name, fired: list.length, failed, results };
  }

  async fireAll(payload) {
    const out = {};
    for (const name of this.names()) out[name] = await this.fire(name, payload);
    return out;
  }

  /** Forward a hook failure to `onerror`, without recursing into itself. */
  async #notifyError(error, context) {
    this.#logger?.warn?.(`[dsh-modapi] hook ${context.hook} from ${context.source} failed: ${messageOf(error)}`);
    if (this.#reporting) return;
    const list = this.#entries.get('onerror');
    if (list === undefined || list.length === 0) return;
    this.#reporting = true;
    try {
      for (const entry of [...list]) {
        try {
          await entry.handler({ error, ...context });
        } catch (nested) {
          this.#logger?.warn?.(`[dsh-modapi] onerror handler from ${entry.source} failed: ${messageOf(nested)}`);
        }
      }
    } finally {
      this.#reporting = false;
    }
  }

  removeBySource(source) {
    let removed = 0;
    for (const [name, list] of [...this.#entries.entries()]) {
      const keep = list.filter((entry) => entry.source !== source);
      removed += list.length - keep.length;
      if (keep.length === 0) this.#entries.delete(name);
      else this.#entries.set(name, keep);
    }
    return removed;
  }

  clear() {
    this.#entries.clear();
  }
}
