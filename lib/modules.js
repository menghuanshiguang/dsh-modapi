/**
 * Versioned API modules.
 *
 * Fabric API ships as a set of independent modules (`fabric-lifecycle-events-v1`,
 * `fabric-networking-api-v1`, …), each with its own version, so a mod can depend
 * on exactly what it uses and the loader can refuse an incompatible one. This
 * plugin does the same with a small fixed set: every domain, plus the events,
 * registry, hooks, scripts and self-check surfaces, reports a module version.
 *
 * `api.requires({ work: '^1.0.0' })` is the consumer-facing check. A mismatch
 * throws UNSUPPORTED instead of letting the caller fail halfway through.
 */
import { ModapiError, ERROR_CODES } from './errors.js';
import { satisfies, parse, validateRange, format } from './semver.js';

export const MODULE_VERSION = '1.0.0';

/** Built-in modules. Adding one here is the only place a new module is declared. */
export const API_MODULES = Object.freeze({
  work: MODULE_VERSION,
  session: MODULE_VERSION,
  tool: MODULE_VERSION,
  fs: MODULE_VERSION,
  notice: MODULE_VERSION,
  events: MODULE_VERSION,
  registry: MODULE_VERSION,
  hooks: MODULE_VERSION,
  scripts: MODULE_VERSION,
  selfcheck: MODULE_VERSION,
});

export class ModuleRegistry {
  #modules = new Map();
  #apiVersion;
  #logger;

  constructor(options = {}) {
    this.#apiVersion = typeof options.apiVersion === 'string' ? options.apiVersion : '1';
    this.#logger = options.logger ?? null;
    const provided = options.modules ?? API_MODULES;
    for (const [name, version] of Object.entries(provided)) {
      this.provide(name, version, { source: 'builtin' });
    }
  }

  get apiVersion() {
    return this.#apiVersion;
  }

  has(name) {
    return this.#modules.has(name);
  }

  get(name) {
    return this.#modules.get(name);
  }

  names() {
    return [...this.#modules.keys()];
  }

  /** Records without the API face: `list()`/`describe()` go into `/modapi/api/info`. */
  list() {
    return [...this.#modules.values()].map(({ value, ...record }) => ({ ...record, hasValue: value !== undefined }));
  }

  /** Adds a module (plugins may publish their own); an existing name is replaced. */
  provide(name, version, options = {}) {
    if (typeof name !== 'string' || name.trim() === '') {
      throw new ModapiError(ERROR_CODES.BAD_ARGUMENT, 'module name must be a non-empty string', { domain: 'module', method: 'provide' });
    }
    if (parse(version) === null) {
      throw new ModapiError(ERROR_CODES.BAD_ARGUMENT, `module "${name}" has an invalid version "${String(version)}"`, {
        domain: 'module',
        method: 'provide',
      });
    }
    const record = {
      name: name.trim(),
      version: format(parse(version)),
      deprecated: options.deprecated === true,
      note: typeof options.note === 'string' ? options.note : '',
      source: typeof options.source === 'string' ? options.source : 'plugin',
    };
    if (options.value !== undefined) record.value = options.value;
    this.#modules.set(record.name, record);
    return record;
  }

  /**
   * Checks `{ moduleName: range }`. Returns the matched modules; throws one
   * UNSUPPORTED listing every failure when any range is unmet.
   */
  require(spec, options = {}) {
    const context = typeof options.context === 'string' ? options.context : 'plugin';
    if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
      throw new ModapiError(ERROR_CODES.BAD_ARGUMENT, 'requires() needs an object like { work: "^1.0.0" }', {
        domain: 'module',
        method: 'require',
      });
    }
    const matched = [];
    const failures = [];
    for (const [name, range] of Object.entries(spec)) {
      try {
        validateRange(range);
      } catch (error) {
        throw new ModapiError(ERROR_CODES.BAD_ARGUMENT, `requires() got a bad range for "${name}": ${error.message}`, {
          domain: 'module',
          method: 'require',
          detail: { module: name, range },
        });
      }
      const module = this.#modules.get(name);
      if (module === undefined) {
        failures.push({ module: name, required: range, actual: null, reason: 'module missing' });
        continue;
      }
      if (!satisfies(module.version, range)) {
        failures.push({ module: name, required: range, actual: module.version, reason: 'version mismatch' });
        continue;
      }
      matched.push({ name, version: module.version });
    }
    if (failures.length > 0) {
      const summary = failures
        .map((failure) => `${failure.module}${failure.actual === null ? ' (missing)' : ` ${failure.actual}`} does not satisfy ${failure.required}`)
        .join('; ');
      throw new ModapiError(ERROR_CODES.UNSUPPORTED, `${context} needs API modules it cannot get: ${summary}`, {
        domain: 'module',
        method: 'require',
        hint: 'Update dsh-modapi, or relax the range the consumer declared.',
        detail: { apiVersion: this.#apiVersion, failures, matched },
      });
    }
    return matched;
  }

  /** True/false instead of throwing; useful in `health()` output. */
  supports(spec) {
    try {
      this.require(spec, { context: 'supports' });
      return true;
    } catch {
      return false;
    }
  }

  describe() {
    return { apiVersion: this.#apiVersion, modules: this.list() };
  }
}
