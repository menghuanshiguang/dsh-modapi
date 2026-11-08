/**
 * Namespaced registries, in the shape Fabric mods already know.
 *
 * Fabric's `Registry.register(key, value)` needs a `minecraft:`-style id and
 * refuses duplicates; mods create their own registries when the game does not
 * provide one. That is the same contract here, minus the game: ids are
 * `namespace:path`, the default namespace is `modapi`, and every registry is a
 * plain in-memory map that a plugin or script can own.
 */
import { ModapiError, ERROR_CODES } from './errors.js';

const ID = /^[a-z0-9_.-]+:[a-z0-9/._-]+$/;
const NAMESPACE = /^[a-z0-9_.-]+$/;
export const DEFAULT_NAMESPACE = 'modapi';
export const DEFAULT_LIMIT = 4096;

/** `path` → `modapi:path`; validates the full id either way. */
export function parseId(input, { fallback = DEFAULT_NAMESPACE } = {}) {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new ModapiError(ERROR_CODES.BAD_ARGUMENT, 'id must be a non-empty string', { domain: 'registry', method: 'parseId' });
  }
  const text = input.trim();
  const id = text.includes(':') ? text : `${fallback}:${text}`;
  if (!ID.test(id)) {
    throw new ModapiError(ERROR_CODES.BAD_ARGUMENT, `id "${id}" is not a namespaced id`, {
      domain: 'registry',
      method: 'parseId',
      hint: 'Use lowercase letters, digits, `_`, `-`, `.`, a single colon, and `/` inside the path.',
    });
  }
  return id;
}

export function splitId(id) {
  const [namespace, path] = id.split(':', 2);
  return { namespace, path };
}

export class Registry {
  #name;
  #entries = new Map();
  #limit;
  #onReplace;

  constructor(name, options = {}) {
    if (typeof name !== 'string' || !NAMESPACE.test(name)) {
      throw new ModapiError(ERROR_CODES.BAD_ARGUMENT, `registry name "${String(name)}" must match ${NAMESPACE}`, {
        domain: 'registry',
        method: 'create',
      });
    }
    this.#name = name;
    this.#limit = Number.isFinite(options.limit) && options.limit > 0 ? Math.floor(options.limit) : DEFAULT_LIMIT;
    this.#onReplace = typeof options.onReplace === 'function' ? options.onReplace : null;
  }

  get name() {
    return this.#name;
  }

  get size() {
    return this.#entries.size;
  }

  keys() {
    return [...this.#entries.keys()];
  }

  values() {
    return [...this.#entries.values()];
  }

  list() {
    return [...this.#entries.entries()].map(([id, value]) => ({ id, value }));
  }

  has(id) {
    return this.#entries.has(parseId(id));
  }

  get(id, fallback = undefined) {
    return this.#entries.get(parseId(id)) ?? fallback;
  }

  /** Registers `value`; duplicate ids throw unless `{ replace: true }`. */
  register(id, value, options = {}) {
    const key = parseId(id);
    const existing = this.#entries.get(key);
    if (existing !== undefined && options.replace !== true) {
      throw new ModapiError(ERROR_CODES.CONFLICT, `registry "${this.#name}" already has "${key}"`, {
        domain: 'registry',
        method: 'register',
        hint: 'Pass { replace: true } to overwrite it.',
      });
    }
    if (existing === undefined && this.#entries.size >= this.#limit) {
      throw new ModapiError(ERROR_CODES.CONFLICT, `registry "${this.#name}" is full (${this.#limit} entries)`, {
        domain: 'registry',
        method: 'register',
      });
    }
    if (existing !== undefined) this.#onReplace?.(key, existing, value);
    this.#entries.set(key, value);
    return value;
  }

  remove(id) {
    return this.#entries.delete(parseId(id));
  }

  clear() {
    this.#entries.clear();
  }

  describe() {
    return { name: this.#name, size: this.#entries.size, keys: this.keys() };
  }
}

/** The `modapi.registry` surface: named registries plus direct access. */
export class RegistryManager {
  #registries = new Map();
  #limit;
  #onReplace;

  constructor(options = {}) {
    this.#limit = Number.isFinite(options.limit) && options.limit > 0 ? Math.floor(options.limit) : DEFAULT_LIMIT;
    this.#onReplace = typeof options.onReplace === 'function' ? options.onReplace : null;
  }

  create(name, options = {}) {
    if (this.#registries.has(name)) {
      if (options.replace === true) this.#registries.delete(name);
      else {
        throw new ModapiError(ERROR_CODES.CONFLICT, `registry "${name}" already exists`, {
          domain: 'registry',
          method: 'create',
          hint: 'Use registry.get() to reach it, or pass { replace: true }.',
        });
      }
    }
    const registry = new Registry(name, {
      limit: Number.isFinite(options.limit) ? options.limit : this.#limit,
      onReplace: options.onReplace ?? this.#onReplace ?? undefined,
    });
    this.#registries.set(name, registry);
    return registry;
  }

  get(name) {
    return this.#registries.get(name);
  }

  has(name) {
    return this.#registries.has(name);
  }

  names() {
    return [...this.#registries.keys()];
  }

  /** Returns the registry, creating it on first use. */
  use(name, options = {}) {
    return this.#registries.get(name) ?? this.create(name, options);
  }

  remove(name) {
    return this.#registries.delete(name);
  }

  clear() {
    this.#registries.clear();
  }

  describe() {
    return [...this.#registries.values()].map((registry) => registry.describe());
  }
}
