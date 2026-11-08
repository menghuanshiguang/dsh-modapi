/**
 * The notice channel: an in-memory queue plus long-poll wakeups.
 *
 * Presentation is deliberately someone else's job. `show()` records a notice;
 * the web client pulls it over HTTP and decides how it looks. That keeps this
 * file free of React, strings and styling.
 */
import { ModapiError, ERROR_CODES } from './errors.js';

export const NOTICE_LEVELS = Object.freeze(['info', 'success', 'warn', 'error']);

const MAX_WAIT_MS = 60000;

export class NoticeStore {
  #items = [];
  #seq = 0;
  #waiters = [];
  #closed = false;
  #limit;
  #ttlMs;
  #now;
  #idPrefix;
  #counter = 0;

  constructor(options = {}) {
    this.#limit = Number.isFinite(options.limit) && options.limit > 0 ? Math.floor(options.limit) : 64;
    this.#ttlMs = Number.isFinite(options.ttlMs) && options.ttlMs > 0 ? Math.floor(options.ttlMs) : 600000;
    this.#now = typeof options.now === 'function' ? options.now : () => Date.now();
    this.#idPrefix = typeof options.idPrefix === 'string' ? options.idPrefix : 'notice';
  }

  get seq() {
    return this.#seq;
  }

  get size() {
    return this.#items.length;
  }

  get closed() {
    return this.#closed;
  }

  normalize(input) {
    let title = '';
    let body = '';
    let level = 'info';
    let duration = 0;
    let kind = 'modapi.notice';
    if (typeof input === 'string') {
      body = input;
    } else if (input !== null && typeof input === 'object') {
      title = typeof input.title === 'string' ? input.title : '';
      body = typeof input.body === 'string' ? input.body : typeof input.text === 'string' ? input.text : typeof input.message === 'string' ? input.message : '';
      level = NOTICE_LEVELS.includes(input.level) ? input.level : level;
      duration = Number.isFinite(input.duration) && input.duration > 0 ? Math.floor(input.duration) : 0;
      kind = typeof input.kind === 'string' && input.kind.length > 0 ? input.kind : kind;
    }
    if (title.trim() === '' && body.trim() === '') {
      throw new ModapiError(ERROR_CODES.BAD_ARGUMENT, 'a notice needs a title or a body', { domain: 'notice', method: 'show' });
    }
    return { title, body, level, duration, kind };
  }

  push(input) {
    const fields = this.normalize(input);
    this.#counter += 1;
    const record = {
      id: `${this.#idPrefix}-${this.#counter}`,
      seq: ++this.#seq,
      level: fields.level,
      title: fields.title,
      body: fields.body,
      kind: fields.kind,
      duration: fields.duration,
      at: this.#now(),
    };
    if (this.#closed) return record;
    this.#items.push(record);
    this.prune();
    this.wake();
    return record;
  }

  /** Drop expired notices, then the oldest beyond the limit. */
  prune(now = this.#now()) {
    if (this.#ttlMs > 0) {
      const cutoff = now - this.#ttlMs;
      this.#items = this.#items.filter((item) => item.at >= cutoff);
    }
    if (this.#items.length > this.#limit) {
      this.#items = this.#items.slice(this.#items.length - this.#limit);
    }
    return this.#items.length;
  }

  since(after) {
    const cursor = Number.isFinite(after) ? after : 0;
    return this.#items.filter((item) => item.seq > cursor).map((item) => ({ ...item }));
  }

  update(id, patch) {
    const index = this.#items.findIndex((item) => item.id === id);
    if (index < 0) return false;
    const fields = this.normalize({ ...this.#items[index], ...patch });
    this.#items[index] = { ...this.#items[index], ...fields };
    this.wake();
    return true;
  }

  ack(ids) {
    if (!Array.isArray(ids) || ids.length === 0) return 0;
    const wanted = new Set(ids.filter((id) => typeof id === 'string'));
    const before = this.#items.length;
    this.#items = this.#items.filter((item) => !wanted.has(item.id));
    return before - this.#items.length;
  }

  /** Long-poll: resolve now if the cursor is behind, else hold up to waitMs. */
  wait(after, waitMs) {
    const ready = this.since(after);
    if (ready.length > 0) return Promise.resolve(ready);
    const budget = Number.isFinite(waitMs) ? Math.min(Math.max(0, waitMs), MAX_WAIT_MS) : 0;
    const cursor = Number.isFinite(after) ? after : 0;
    if (budget === 0 || this.#closed) return Promise.resolve([]);
    return new Promise((resolve) => {
      const waiter = { cursor, resolve, timer: null };
      waiter.timer = setTimeout(() => {
        this.#waiters = this.#waiters.filter((item) => item !== waiter);
        resolve([]);
      }, budget);
      if (typeof waiter.timer.unref === 'function') waiter.timer.unref();
      this.#waiters.push(waiter);
    });
  }

  /** Wake every parked poll with what it is now missing. */
  wake() {
    if (this.#waiters.length === 0) return 0;
    const parked = this.#waiters;
    this.#waiters = [];
    let woken = 0;
    for (const waiter of parked) {
      clearTimeout(waiter.timer);
      const items = this.since(waiter.cursor);
      if (items.length > 0) {
        woken += 1;
        waiter.resolve(items);
      }
    }
    return woken;
  }

  clear() {
    this.#items = [];
    return true;
  }

  close() {
    this.#closed = true;
    const parked = this.#waiters;
    this.#waiters = [];
    for (const waiter of parked) {
      clearTimeout(waiter.timer);
      waiter.resolve([]);
    }
    this.#items = [];
  }

  snapshot() {
    return { seq: this.#seq, size: this.#items.length, items: this.since(0) };
  }
}

/** A notice under construction. `show()` is the only side effect. */
export class Toast {
  #store;
  #options;
  #record = null;

  constructor(store, a, b, c) {
    this.#store = store;
    this.#options = Toast.parse(a, b, c);
    Object.defineProperty(this, '__store', { value: store, enumerable: false });
  }

  static parse(a, b, c) {
    let title = '';
    let body = '';
    let extra = {};
    if (typeof b === 'string') {
      title = typeof a === 'string' ? a : '';
      body = b;
      if (c !== null && typeof c === 'object') extra = c;
    } else if (a !== null && typeof a === 'object') {
      extra = a;
      if (b !== null && typeof b === 'object') extra = { ...a, ...b };
    } else if (typeof a === 'string') {
      body = a;
      if (b !== null && typeof b === 'object') extra = b;
    } else if (b !== null && typeof b === 'object') {
      extra = b;
    }
    if (typeof extra.title === 'string' && title === '') title = extra.title;
    if (typeof extra.body === 'string' && body === '') body = extra.body;
    return {
      title,
      body,
      level: NOTICE_LEVELS.includes(extra.level) ? extra.level : 'info',
      duration: Number.isFinite(extra.duration) && extra.duration > 0 ? Math.floor(extra.duration) : 0,
      kind: typeof extra.kind === 'string' && extra.kind.length > 0 ? extra.kind : 'modapi.notice',
    };
  }

  /** `new Toast('正文')` (string) or `new Toast('标题', '正文', options)`. */
  static options(value) {
    return Toast.parse(value, undefined, undefined);
  }

  set(patch) {
    if (patch !== null && typeof patch === 'object') {
      this.#options = { ...this.#options, ...patch };
      if (this.#record !== null) {
        this.#store.update(this.#record.id, this.#options);
        this.#record = { ...this.#record, ...this.#options };
      }
    }
    return this;
  }

  title(value) {
    return value === undefined ? this.#options.title : this.set({ title: String(value) });
  }

  body(value) {
    return value === undefined ? this.#options.body : this.set({ body: String(value) });
  }

  /** Push to the queue (or update the record already pushed) and return it. */
  show(patch) {
    if (patch !== null && typeof patch === 'object') this.#options = { ...this.#options, ...patch };
    if (this.#record !== null) {
      this.#store.update(this.#record.id, this.#options);
      this.#record = { ...this.#record, ...this.#options };
      return { ...this.#record };
    }
    this.#record = this.#store.push(this.#options);
    return { ...this.#record };
  }

  close() {
    if (this.#record === null) return false;
    const removed = this.#store.ack([this.#record.id]) > 0;
    this.#record = null;
    return removed;
  }

  get id() {
    return this.#record === null ? null : this.#record.id;
  }

  toJSON() {
    return { ...this.#options, id: this.id };
  }
}

/** `公告('正文')` / `公告('标题', '正文', options)` / `公告({...})`. */
export function createNoticeFactory(store) {
  const factory = (a, b, c) => new Toast(store, a, b, c);
  factory.show = (a, b, c) => new Toast(store, a, b, c).show();
  factory.push = (input) => store.push(input);
  factory.since = (after) => store.since(after);
  factory.clear = () => store.clear();
  factory.snapshot = () => store.snapshot();
  factory.store = store;
  factory.levels = NOTICE_LEVELS;
  factory.Toast = Toast;
  factory.toast = factory;
  return factory;
}
