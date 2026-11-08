/**
 * `modapi.work` — workspace registry.
 *
 * `list()` (alias `getlist()`) is the whole point: host entities are classes
 * with getters, and nothing host-shaped is allowed to escape this file.
 */
import { readField, toId, toText, toISO, toStringArray } from '../json.js';
import { ModapiError, ERROR_CODES } from '../errors.js';

export const WORK_SERVICES = Object.freeze(['workspaceRegistry']);

export function toWorkspaceRecord(entity) {
  return {
    id: toId(readField(entity, ['id', 'workspaceId', 'key'])),
    title: toText(readField(entity, ['title', 'name', 'label'])),
    path: toText(readField(entity, ['path', 'dir', 'directory', 'root', 'cwd'])),
    createdAt: toISO(readField(entity, ['createdAt', 'created'])),
    updatedAt: toISO(readField(entity, ['updatedAt', 'updated'])),
    sessionIds: toStringArray(readField(entity, ['sessionIds', 'sessions'])),
  };
}

/** Compare paths the way the user types them: slashes normalised, case folded. */
export function normalizePath(value) {
  if (typeof value !== 'string') return '';
  let text = value.split(String.fromCharCode(92)).join('/');
  while (text.endsWith('/')) text = text.slice(0, -1);
  return text.toLowerCase();
}

export function createWorkDomain(compat) {
  const domain = 'work';

  function registry(method) {
    const service = compat.requireService(WORK_SERVICES, domain, method);
    if (typeof service.list !== 'function' && typeof service.get !== 'function') {
      throw new ModapiError(ERROR_CODES.UNSUPPORTED, 'workspace registry exposes neither list() nor get()', {
        domain,
        method,
        hint: 'The host workspace service was renamed; update dsh-modapi.',
      });
    }
    return service;
  }

  async function list() {
    return compat.run({ domain, method: 'list' }, async () => {
      const service = registry('list');
      const read = compat.requireMethod(service, ['list'], domain, 'list');
      const entities = await read();
      if (!Array.isArray(entities)) {
        throw new ModapiError(ERROR_CODES.INTERNAL, 'workspaceRegistry.list() did not return an array', { domain, method: 'list' });
      }
      return entities.map(toWorkspaceRecord);
    });
  }

  async function get(id) {
    return compat.run({ domain, method: 'get' }, async () => {
      if (typeof id !== 'string' || id.length === 0) {
        throw new ModapiError(ERROR_CODES.BAD_ARGUMENT, 'work.get(id) needs a workspace id', { domain, method: 'get' });
      }
      const service = registry('get');
      const read = compat.methodOf(service, ['get']);
      if (read === undefined) return (await list()).find((item) => item.id === id) ?? null;
      const entity = await read(id);
      return entity === undefined || entity === null ? null : toWorkspaceRecord(entity);
    });
  }

  async function findByPath(path) {
    const wanted = normalizePath(path);
    if (wanted === '') {
      throw new ModapiError(ERROR_CODES.BAD_ARGUMENT, 'work.findByPath(path) needs a path', { domain, method: 'findByPath' });
    }
    return (await list()).find((item) => normalizePath(item.path) === wanted) ?? null;
  }

  async function create(path, title) {
    return compat.run({ domain, method: 'create' }, async () => {
      if (typeof path !== 'string' || path.length === 0) {
        throw new ModapiError(ERROR_CODES.BAD_ARGUMENT, 'work.create(path, title) needs a path', { domain, method: 'create' });
      }
      const service = registry('create');
      const make = compat.requireMethod(service, ['create'], domain, 'create');
      const label = typeof title === 'string' && title.length > 0 ? title : undefined;
      return toWorkspaceRecord(await make(path, label));
    });
  }

  async function rename(id, title) {
    return compat.run({ domain, method: 'rename' }, async () => {
      if (typeof title !== 'string') {
        throw new ModapiError(ERROR_CODES.BAD_ARGUMENT, 'work.rename(id, title) needs a title string', { domain, method: 'rename' });
      }
      const service = registry('rename');
      const read = compat.requireMethod(service, ['get'], domain, 'rename');
      const entity = await read(id);
      if (entity === undefined || entity === null) {
        throw new ModapiError(ERROR_CODES.NOT_FOUND, `no workspace with id "${id}"`, { domain, method: 'rename' });
      }
      const setTitle = compat.requireMethod(entity, ['setTitle'], domain, 'rename');
      const updated = await setTitle(title);
      return toWorkspaceRecord(updated ?? entity);
    });
  }

  async function remove(id) {
    return compat.run({ domain, method: 'remove' }, async () => {
      const service = registry('remove');
      const drop = compat.requireMethod(service, ['delete', 'remove'], domain, 'remove');
      return (await drop(id)) === true;
    });
  }

  async function move(id, beforeId) {
    return compat.run({ domain, method: 'move' }, async () => {
      const service = registry('move');
      const insert = compat.requireMethod(service, ['insertBefore', 'move'], domain, 'move');
      const order = await insert(id, typeof beforeId === 'string' ? beforeId : undefined);
      return Array.isArray(order) ? order.map(toId).filter((item) => item !== '') : [];
    });
  }

  async function forSession(sessionId) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new ModapiError(ERROR_CODES.BAD_ARGUMENT, 'work.forSession(sessionId) needs a session id', { domain, method: 'forSession' });
    }
    return (await list()).filter((item) => item.sessionIds.includes(sessionId));
  }

  return {
    list,
    /** ModPE-style alias: `work.getlist()` returns the workspace list. */
    getlist: list,
    getAll: list,
    get,
    byId: get,
    find: findByPath,
    findByPath,
    create,
    rename,
    remove,
    delete: remove,
    move,
    forSession,
    paths: async () => (await list()).map((item) => item.path),
    count: async () => (await list()).length,
    toRecord: toWorkspaceRecord,
    services: WORK_SERVICES,
  };
}
