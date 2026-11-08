/**
 * `modapi.fs` — file system.
 *
 * Paths are accepted as strings or host targets. Sandbox policy belongs to the
 * host: a refused write arrives here as `DENIED` and is passed through, not
 * softened into a silent success.
 */
import { toText } from '../json.js';
import { ModapiError, ERROR_CODES } from '../errors.js';

export const FS_SERVICES = Object.freeze(['fs', 'filesystem']);
const DEFAULT_READ_BYTES = 4 * 1024 * 1024;
const MAX_READ_BYTES = 16 * 1024 * 1024;

export function createFsDomain(compat) {
  const domain = 'fs';

  function service(method) {
    return compat.requireService(FS_SERVICES, domain, method);
  }

  async function resolveTarget(fs, path, options, method) {
    if (path !== null && typeof path === 'object' && typeof path.targetKey === 'string') return path;
    if (typeof path !== 'string' || path.length === 0) {
      throw new ModapiError(ERROR_CODES.BAD_ARGUMENT, 'a path string or a host target is required', { domain, method });
    }
    const resolve = compat.requireMethod(fs, ['resolve'], domain, method);
    const target = await resolve(path, options.cwd === undefined ? undefined : { cwd: options.cwd });
    if (target === undefined || target === null || typeof target !== 'object') {
      throw new ModapiError(ERROR_CODES.INTERNAL, 'fs.resolve() did not return a target', { domain, method });
    }
    return target;
  }

  async function resolve(path, options = {}) {
    return compat.run({ domain, method: 'resolve' }, async () => {
      const fs = service('resolve');
      const target = await resolveTarget(fs, path, options, 'resolve');
      return { targetKey: toText(target.targetKey), displayPath: toText(target.displayPath) };
    });
  }

  async function stat(path, options = {}) {
    return compat.run({ domain, method: 'stat' }, async () => {
      const fs = service('stat');
      const target = await resolveTarget(fs, path, options, 'stat');
      const read = compat.requireMethod(fs, ['stat'], domain, 'stat');
      const result = await read(target, options.signal);
      if (result === undefined || result === null) return null;
      return {
        type: toText(result.type),
        size: Number.isFinite(result.size) ? result.size : 0,
        version: typeof result.version === 'string' ? result.version : '',
      };
    });
  }

  async function exists(path, options = {}) {
    try {
      return (await stat(path, options)) !== null;
    } catch (error) {
      if (error?.code === ERROR_CODES.DENIED || error?.code === ERROR_CODES.NOT_FOUND) return false;
      throw error;
    }
  }

  async function read(path, options = {}) {
    return compat.run({ domain, method: 'read' }, async () => {
      const fs = service('read');
      const target = await resolveTarget(fs, path, options, 'read');
      const readText = compat.requireMethod(fs, ['readText'], domain, 'read');
      const text = await readText(target, options.signal);
      return typeof text === 'string' ? text : '';
    });
  }

  async function readBytes(path, options = {}) {
    return compat.run({ domain, method: 'readBytes' }, async () => {
      const fs = service('readBytes');
      const target = await resolveTarget(fs, path, options, 'readBytes');
      const readBytesFn = compat.requireMethod(fs, ['readBytes'], domain, 'readBytes');
      const requested = Number.isFinite(options.maxBytes) ? Math.floor(options.maxBytes) : DEFAULT_READ_BYTES;
      const maxBytes = Math.min(Math.max(1, requested), MAX_READ_BYTES);
      const buffer = await readBytesFn(target, options.signal, maxBytes);
      const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? []);
      return { base64: bytes.toString('base64'), size: bytes.length };
    });
  }

  async function list(path, options = {}) {
    return compat.run({ domain, method: 'list' }, async () => {
      const fs = service('list');
      const target = await resolveTarget(fs, path, options, 'list');
      const listDir = compat.requireMethod(fs, ['listDir'], domain, 'list');
      const entries = await listDir(target, options.signal);
      if (!Array.isArray(entries)) {
        throw new ModapiError(ERROR_CODES.INTERNAL, 'listDir() did not return an array', { domain, method: 'list' });
      }
      return entries
        .map((entry) => ({
          name: toText(entry?.name),
          type: toText(entry?.type),
          path: toText(entry?.target?.displayPath ?? entry?.path),
          size: Number.isFinite(entry?.size) ? entry.size : undefined,
          version: typeof entry?.version === 'string' ? entry.version : undefined,
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
    });
  }

  /** Build the host's expected-version guard from caller options. */
  function expectedOf(options) {
    if (options.expected !== undefined && options.expected !== null) return options.expected;
    if (options.create === true) return { kind: 'createIfAbsent' };
    if (typeof options.version === 'string' && options.version.length > 0) return { kind: 'replaceIfVersion', version: options.version };
    return undefined;
  }

  function writeResult(target, result) {
    return {
      path: toText(target.displayPath),
      operation: toText(result?.operation),
      version: typeof result?.version === 'string' ? result.version : undefined,
      before: typeof result?.before === 'string' ? result.before : undefined,
      after: typeof result?.after === 'string' ? result.after : undefined,
    };
  }

  async function write(path, content, options = {}) {
    return compat.run({ domain, method: 'write' }, async () => {
      if (typeof content !== 'string') {
        throw new ModapiError(ERROR_CODES.BAD_ARGUMENT, 'fs.write(path, content) needs a string', { domain, method: 'write' });
      }
      const fs = service('write');
      const target = await resolveTarget(fs, path, options, 'write');
      const writeText = compat.requireMethod(fs, ['writeText'], domain, 'write');
      return writeResult(target, await writeText(target, content, expectedOf(options), options.signal));
    });
  }

  async function edit(path, change, options = {}) {
    return compat.run({ domain, method: 'edit' }, async () => {
      const input = change !== null && typeof change === 'object' ? change : {};
      if (typeof input.oldString !== 'string' || typeof input.newString !== 'string') {
        throw new ModapiError(ERROR_CODES.BAD_ARGUMENT, 'fs.edit(path, { oldString, newString }) needs both strings', { domain, method: 'edit' });
      }
      const fs = service('edit');
      const target = await resolveTarget(fs, path, options, 'edit');
      const editText = compat.requireMethod(fs, ['editText'], domain, 'edit');
      const patch = { oldString: input.oldString, newString: input.newString, replaceAll: input.replaceAll === true };
      return writeResult(target, await editText(target, patch, expectedOf(options), options.signal));
    });
  }

  async function fileUrl(path, options = {}) {
    return compat.run({ domain, method: 'fileUrl' }, async () => {
      const fs = service('fileUrl');
      const target = await resolveTarget(fs, path, options, 'fileUrl');
      const toUrl = compat.requireMethod(fs, ['fileUrl'], domain, 'fileUrl');
      return toText(await toUrl(target));
    });
  }

  async function contains(parent, child, options = {}) {
    return compat.run({ domain, method: 'contains' }, async () => {
      const fs = service('contains');
      const from = await resolveTarget(fs, parent, options, 'contains');
      const to = await resolveTarget(fs, child, options, 'contains');
      const check = compat.requireMethod(fs, ['contains'], domain, 'contains');
      const result = await check(from, to);
      return result === true;
    });
  }

  return {
    resolve,
    targetOf: resolve,
    stat,
    exists,
    read,
    readText: read,
    readBytes,
    list,
    listDir: list,
    write,
    writeText: write,
    edit,
    fileUrl,
    contains,
    services: FS_SERVICES,
  };
}
