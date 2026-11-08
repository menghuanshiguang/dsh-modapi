/**
 * Fabric-style events: a named invoker with ordered listeners.
 *
 * Fabric API's `Event<T>` is an object you call, backed by an ordered listener
 * array; the invoker decides what the return value means. The same three
 * shapes cover what mods actually use it for here:
 *
 * - `all`       every listener runs; the invoker returns the results array.
 * - `first`     the first non-`undefined` result wins (override-style events).
 * - `waterfall` listeners receive `(payload, next)`; not calling `next` stops
 *               the chain, exactly like cordis/cordis `waterfall`.
 *
 * Errors never escape a listener: each one is contained and reported through
 * `onError`, so one broken subscriber cannot starve the rest.
 */
import { ModapiError, ERROR_CODES, messageOf } from './errors.js';

export const COMBINERS = Object.freeze(['all', 'first', 'waterfall']);
export const DEFAULT_LIMIT = 64;

function assertName(name) {
  if (typeof name !== 'string' || name.trim() === '') {
    throw new ModapiError(ERROR_CODES.BAD_ARGUMENT, 'event name must be a non-empty string', { domain: 'event', method: 'create' });
  }
  return name.trim();
}

export class Event {
  #name;
  #combiner;
  #limit;
  #listeners = [];
  #sequence = 0;
  #report;

  constructor(name, options = {}) {
    this.#name = assertName(name);
    const combiner = options.combiner ?? 'all';
    if (!COMBINERS.includes(combiner)) {
      throw new ModapiError(ERROR_CODES.BAD_ARGUMENT, `event "${name}" has unknown combiner "${combiner}"`, {
        domain: 'event',
        method: 'create',
        hint: `Use one of: ${COMBINERS.join(', ')}`,
      });
    }
    this.#combiner = combiner;
    this.#limit = Number.isFinite(options.limit) && options.limit > 0 ? Math.floor(options.limit) : DEFAULT_LIMIT;
    this.#report = typeof options.onError === 'function' ? options.onError : null;
  }

  get name() {
    return this.#name;
  }

  get combiner() {
    return this.#combiner;
  }

  get size() {
    return this.#listeners.length;
  }

  listeners() {
    return this.#listeners.map((entry) => ({ listener: entry.listener, order: entry.order, source: entry.source }));
  }

  has(listener) {
    return this.#listeners.some((entry) => entry.listener === listener);
  }

  /** Registers `listener`; returns a disposer that can also be called twice safely. */
  register(listener, options = {}) {
    if (typeof listener !== 'function') {
      throw new ModapiError(ERROR_CODES.BAD_ARGUMENT, `event "${this.#name}" needs a function listener`, { domain: 'event', method: 'register' });
    }
    if (this.#listeners.length >= this.#limit) {
      throw new ModapiError(ERROR_CODES.CONFLICT, `event "${this.#name}" already has ${this.#listeners.length} listeners (limit ${this.#limit})`, {
        domain: 'event',
        method: 'register',
        hint: 'Raise hookLimitPerName in the plugin config.',
      });
    }
    const entry = {
      listener,
      order: Number.isFinite(options.order) ? options.order : 0,
      source: typeof options.source === 'string' && options.source !== '' ? options.source : 'plugin',
      sequence: (this.#sequence += 1),
    };
    this.#listeners.push(entry);
    this.#listeners.sort((left, right) => (left.order - right.order) || (left.sequence - right.sequence));
    let disposed = false;
    const dispose = () => {
      if (disposed) return false;
      disposed = true;
      const index = this.#listeners.indexOf(entry);
      if (index >= 0) this.#listeners.splice(index, 1);
      return index >= 0;
    };
    dispose.dispose = dispose;
    return dispose;
  }

  unregister(listener) {
    const index = this.#listeners.findIndex((entry) => entry.listener === listener);
    if (index < 0) return false;
    this.#listeners.splice(index, 1);
    return true;
  }

  removeBySource(source) {
    const before = this.#listeners.length;
    this.#listeners = this.#listeners.filter((entry) => entry.source !== source);
    return before - this.#listeners.length;
  }

  clear() {
    this.#listeners = [];
  }

  #call(entry, args) {
    try {
      return { ok: true, value: entry.listener(...args) };
    } catch (error) {
      this.#report?.(error, { event: this.#name, source: entry.source });
      return { ok: false, error };
    }
  }

  /** The callable form of this event. Each call runs the listeners in order. */
  invoker() {
    const event = this;
    if (this.#combiner === 'first') {
      return function invokeFirst(...args) {
        for (const entry of [...event.#listeners]) {
          const result = event.#call(entry, args);
          if (!result.ok) continue;
          if (result.value !== undefined) return result.value;
        }
        return undefined;
      };
    }
    if (this.#combiner === 'waterfall') {
      return function invokeWaterfall(payload) {
        const chain = [...event.#listeners].reverse();
        let index = -1;
        const next = (value) => {
          index += 1;
          while (index < chain.length) {
            const entry = chain[index];
            const result = event.#call(entry, [value, next]);
            if (!result.ok) {
              index += 1;
              continue;
            }
            return result.value;
          }
          return value;
        };
        return next(payload);
      };
    }
    return function invokeAll(...args) {
      const results = [];
      for (const entry of [...event.#listeners]) {
        const result = event.#call(entry, args);
        results.push(result.ok ? result.value : undefined);
      }
      return results;
    };
  }

  /** Calls `invoker()` with these arguments. */
  fire(...args) {
    return this.invoker()(...args);
  }

  describe() {
    return {
      name: this.#name,
      combiner: this.#combiner,
      listeners: this.#listeners.length,
      sources: [...new Set(this.#listeners.map((entry) => entry.source))],
    };
  }
}

/** A namespace of named events; the `modapi.events` surface. */
export class EventBus {
  #events = new Map();
  #limit;
  #report;
  #logger;

  constructor(options = {}) {
    this.#limit = Number.isFinite(options.limit) && options.limit > 0 ? Math.floor(options.limit) : DEFAULT_LIMIT;
    this.#report = typeof options.onError === 'function' ? options.onError : null;
    this.#logger = options.logger ?? null;
  }

  create(name, options = {}) {
    const key = assertName(name);
    const existing = this.#events.get(key);
    if (existing !== undefined) {
      if (options.replace === true) {
        this.#events.delete(key);
      } else {
        throw new ModapiError(ERROR_CODES.CONFLICT, `event "${key}" already exists`, {
          domain: 'event',
          method: 'create',
          hint: 'Pass { replace: true } to replace it, or use get() to subscribe.',
        });
      }
    }
    const event = new Event(key, {
      combiner: options.combiner ?? 'all',
      limit: Number.isFinite(options.limit) ? options.limit : this.#limit,
      onError: options.onError ?? this.#report ?? undefined,
    });
    this.#events.set(key, event);
    return event;
  }

  get(name) {
    return this.#events.get(name);
  }

  has(name) {
    return this.#events.has(name);
  }

  names() {
    return [...this.#events.keys()];
  }

  remove(name) {
    return this.#events.delete(name);
  }

  /** Subscribes to `name`, creating it as an `all` event when absent. */
  on(name, listener, options = {}) {
    const event = this.#events.get(name) ?? this.create(name, options.createOptions);
    return event.register(listener, options);
  }

  /** Calls a registered event; an unknown name is a silent `undefined`. */
  fire(name, ...args) {
    const event = this.#events.get(name);
    if (event === undefined) return undefined;
    return event.fire(...args);
  }

  removeBySource(source) {
    let removed = 0;
    for (const event of this.#events.values()) removed += event.removeBySource(source);
    return removed;
  }

  clear() {
    this.#events.clear();
  }

  describe() {
    return [...this.#events.values()].map((event) => event.describe());
  }
}
