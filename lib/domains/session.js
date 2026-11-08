/**
 * `modapi.session` — session store.
 *
 * The host keeps sessions as classes carrying an event log; this file exposes
 * records and message snapshots, and never invents a delete API the host
 * lacks: a session dies with the fiber that created it.
 */
import { readField, toId, toText, toISO, toJSONValue } from '../json.js';
import { ModapiError, ERROR_CODES } from '../errors.js';

export const SESSION_SERVICES = Object.freeze(['sessions', 'sessionStore']);
const DEFAULT_MESSAGE_LIMIT = 200;
const MAX_MESSAGE_LIMIT = 2000;

/** Title as last set by a `session/title` event, else empty. */
export function lastTitle(session) {
  const log = readField(session, ['log', 'events']);
  if (!Array.isArray(log)) return '';
  for (let index = log.length - 1; index >= 0; index -= 1) {
    const event = log[index];
    if (readField(event, ['type', 'kind']) !== 'session/title') continue;
    const title = readField(event, ['title', 'value', 'text']);
    if (typeof title === 'string' && title.length > 0) return title;
  }
  return '';
}

export function toSessionRecord(session) {
  const header = readField(session, ['header']) ?? {};
  const log = readField(session, ['log', 'events']);
  const depth = readField(header, ['delegationDepth']);
  return {
    id: toId(readField(session, ['id'])) || toId(readField(header, ['id'])),
    title: lastTitle(session) || toText(readField(session, ['title'])) || toText(readField(header, ['title'])),
    cwd: toText(readField(header, ['cwd'])) || toText(readField(session, ['cwd'])),
    createdAt: toISO(readField(header, ['createdAt'])) || toISO(readField(session, ['createdAt'])),
    parentSession: readField(header, ['parentSession']) ?? null,
    agentPreset: readField(header, ['agentPreset']) ?? null,
    isSeeded: readField(header, ['isSeeded']) === true,
    origin: readField(header, ['origin']) ?? null,
    delegationDepth: Number.isFinite(depth) ? depth : 0,
    events: Array.isArray(log) ? log.length : 0,
  };
}

export function createSessionDomain(compat, options = {}) {
  const domain = 'session';
  const currentSessionId = typeof options.currentSessionId === 'string' ? options.currentSessionId : undefined;

  function store(method) {
    return compat.requireService(SESSION_SERVICES, domain, method);
  }

  async function list() {
    return compat.run({ domain, method: 'list' }, async () => {
      const service = store('list');
      const read = compat.requireMethod(service, ['list', 'all'], domain, 'list');
      const sessions = await read();
      if (!Array.isArray(sessions)) {
        throw new ModapiError(ERROR_CODES.INTERNAL, 'sessions.list() did not return an array', { domain, method: 'list' });
      }
      return sessions.map(toSessionRecord);
    });
  }

  /** The host object (not a record) for one session, or null. */
  async function entity(id) {
    const service = store('get');
    const read = compat.methodOf(service, ['get']);
    if (read !== undefined) {
      const found = await read(id);
      if (found !== undefined && found !== null) return found;
      return null;
    }
    const sessions = compat.methodOf(service, ['list', 'all']);
    if (sessions === undefined) return null;
    const all = await sessions();
    if (!Array.isArray(all)) return null;
    return all.find((item) => toId(readField(item, ['id'])) === id) ?? null;
  }

  async function get(id) {
    if (typeof id !== 'string' || id.length === 0) {
      throw new ModapiError(ERROR_CODES.BAD_ARGUMENT, 'session.get(id) needs a session id', { domain, method: 'get' });
    }
    return compat.run({ domain, method: 'get' }, async () => {
      const found = await entity(id);
      return found === null ? null : toSessionRecord(found);
    });
  }

  async function current() {
    if (currentSessionId === undefined) return null;
    return get(currentSessionId);
  }

  async function messages(id, settings = {}) {
    return compat.run({ domain, method: 'messages' }, async () => {
      const found = await entity(id);
      if (found === null) throw new ModapiError(ERROR_CODES.NOT_FOUND, `no session with id "${id}"`, { domain, method: 'messages' });
      const derive = compat.requireMethod(found, ['deriveMessages'], domain, 'messages');
      const all = await derive();
      if (!Array.isArray(all)) {
        throw new ModapiError(ERROR_CODES.INTERNAL, 'deriveMessages() did not return an array', { domain, method: 'messages' });
      }
      const requested = Number.isFinite(settings.limit) ? Math.floor(settings.limit) : DEFAULT_MESSAGE_LIMIT;
      const limit = requested <= 0 ? 0 : Math.min(requested, MAX_MESSAGE_LIMIT);
      const slice = limit > 0 ? all.slice(-limit) : all;
      return slice.map((message) => toJSONValue(message));
    });
  }

  async function count(id) {
    return (await messages(id, { limit: 0 })).length;
  }

  async function exists(id) {
    return (await get(id)) !== null;
  }

  async function flush(id) {
    return compat.run({ domain, method: 'flush' }, async () => {
      const service = store('flush');
      const flushFn = compat.requireMethod(service, ['flush'], domain, 'flush');
      const found = await entity(id);
      await flushFn(found ?? id);
      return true;
    });
  }

  return {
    list,
    all: list,
    get,
    byId: get,
    current,
    exists,
    ids: async () => (await list()).map((item) => item.id),
    messages,
    deriveMessages: messages,
    count,
    flush,
    toRecord: toSessionRecord,
    currentSessionId,
    services: SESSION_SERVICES,
  };
}
