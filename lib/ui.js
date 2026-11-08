/**
 * UI hook rules — the part that lets a script intercept clicks in the web UI.
 *
 * The host cannot touch the browser DOM, so a rule is only a description: the
 * client half polls `/modapi/api/ui`, compiles each `handler` source, and runs
 * it in a capture-phase listener. That is why a handler must be self-contained
 * (function source is serialised with `toString()`, so closures are gone) and
 * why the host syntax-checks it up front instead of letting the browser fail
 * silently at click time.
 */
import { ModapiError, ERROR_CODES } from './errors.js';

export const UI_EVENTS = Object.freeze([
  'click',
  'dblclick',
  'mousedown',
  'mouseup',
  'pointerdown',
  'pointerup',
  'keydown',
  'keyup',
  'input',
  'change',
  'submit',
  'focusin',
  'focusout',
  'contextmenu',
  'wheel',
]);

export const UI_MODES = Object.freeze(['before', 'after', 'replace', 'block']);
export const UI_RULE_LIMIT = 64;
export const MAX_SELECTOR_LENGTH = 512;

function bad(method, message, hint) {
  return new ModapiError(ERROR_CODES.BAD_ARGUMENT, message, { domain: 'ui', method, hint });
}

function handlerSource(input, method) {
  if (typeof input === 'function') {
    const source = Function.prototype.toString.call(input).trim();
    if (source === '') throw bad(method, 'handler function has no source');
    return source;
  }
  if (typeof input === 'string') {
    const source = input.trim();
    if (source === '') throw bad(method, 'handler source must not be empty');
    return source;
  }
  throw bad(method, 'handler must be a function or a string of code');
}

/**
 * Compiles a handler the way the client will. Function source ("function (ctx) {}"
 * or an arrow) is an expression; plain statements are a body. The kind travels
 * with the rule to the client, which compiles it the same way.
 */
export function compileHandler(source, method = 'hook') {
  try {
    // eslint-disable-next-line no-new-func
    const produced = new Function('ctx', 'event', 'return (' + source + ')')();
    if (typeof produced !== 'function') throw new TypeError('handler source did not evaluate to a function');
    return { kind: 'expression', fn: produced };
  } catch (expressionError) {
    try {
      // eslint-disable-next-line no-new-func
      return { kind: 'body', fn: new Function('ctx', 'event', source) };
    } catch (bodyError) {
      throw bad(method, 'handler does not compile: ' + expressionError.message, 'handlers are serialised function source; keep them self-contained');
    }
  }
}

export class UiRegistry {
  #rules = new Map();
  #limit;
  #version = 0;
  #nextId = 1;

  constructor(options = {}) {
    this.#limit = Number.isFinite(options.limit) && options.limit > 0 ? options.limit : UI_RULE_LIMIT;
  }

  get version() {
    return this.#version;
  }

  get size() {
    return this.#rules.size;
  }

  add(spec = {}) {
    const selector = typeof spec.selector === 'string' ? spec.selector.trim() : '';
    if (selector === '') throw bad('hook', 'selector must be a non-empty string');
    if (selector.length > MAX_SELECTOR_LENGTH) throw bad('hook', `selector is longer than ${MAX_SELECTOR_LENGTH} characters`);

    const event = spec.event === undefined ? 'click' : String(spec.event);
    if (!UI_EVENTS.includes(event)) throw bad('hook', `unsupported event "${event}"`, `use one of: ${UI_EVENTS.join(', ')}`);

    const mode = spec.mode === undefined ? 'before' : String(spec.mode);
    if (!UI_MODES.includes(mode)) throw bad('hook', `unsupported mode "${mode}"`, `use one of: ${UI_MODES.join(', ')}`);

    const handler = handlerSource(spec.handler, 'hook');
    const compiled = compileHandler(handler, 'hook');

    if (this.#rules.size >= this.#limit) {
      throw new ModapiError(ERROR_CODES.CONFLICT, `ui rule limit (${this.#limit}) reached`, {
        domain: 'ui',
        method: 'hook',
        hint: 'call ui.unhook(id) for rules you no longer need',
      });
    }

    const rule = {
      id: `ui-${this.#nextId++}`,
      selector,
      event,
      mode,
      handler,
      handlerKind: compiled.kind,
      once: spec.once === true,
      enabled: spec.enabled !== false,
      name: typeof spec.name === 'string' ? spec.name : '',
      source: typeof spec.source === 'string' ? spec.source : 'plugin',
      hits: 0,
      createdAt: Date.now(),
    };
    this.#rules.set(rule.id, rule);
    this.#version += 1;
    return this.#public(rule);
  }

  get(id) {
    const rule = this.#rules.get(id);
    return rule === undefined ? undefined : this.#public(rule);
  }

  has(id) {
    return this.#rules.has(id);
  }

  remove(id) {
    const removed = this.#rules.delete(id);
    if (removed) this.#version += 1;
    return removed;
  }

  removeBySource(source) {
    let removed = 0;
    for (const [id, rule] of [...this.#rules.entries()]) {
      if (rule.source === source) {
        this.#rules.delete(id);
        removed += 1;
      }
    }
    if (removed > 0) this.#version += 1;
    return removed;
  }

  clear() {
    const count = this.#rules.size;
    if (count > 0) {
      this.#rules.clear();
      this.#version += 1;
    }
    return count;
  }

  list() {
    return [...this.#rules.values()].map((rule) => this.#public(rule));
  }

  hit(id) {
    const rule = this.#rules.get(id);
    if (rule === undefined) return false;
    rule.hits += 1;
    if (rule.once) {
      this.#rules.delete(id);
      this.#version += 1;
    }
    return true;
  }

  /** Payload for the client half: enabled rules only, with handler source. */
  serialize() {
    const rules = [...this.#rules.values()]
      .filter((rule) => rule.enabled)
      .map((rule) => ({
        id: rule.id,
        selector: rule.selector,
        event: rule.event,
        mode: rule.mode,
        handler: rule.handler,
        handlerKind: rule.handlerKind,
        once: rule.once,
      }));
    return { version: this.#version, rules };
  }

  describe() {
    return {
      version: this.#version,
      size: this.#rules.size,
      events: [...new Set([...this.#rules.values()].map((rule) => rule.event))],
      rules: this.list(),
    };
  }

  #public(rule) {
    return {
      id: rule.id,
      selector: rule.selector,
      event: rule.event,
      mode: rule.mode,
      handlerKind: rule.handlerKind,
      once: rule.once,
      enabled: rule.enabled,
      name: rule.name,
      source: rule.source,
      hits: rule.hits,
      createdAt: rule.createdAt,
    };
  }
}

export function createUiDomain(options = {}) {
  return new UiRegistry(options);
}
