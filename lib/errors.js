/**
 * One error type for the whole API.
 *
 * Every failure carries a machine-readable `code`, the domain/method that
 * produced it, and a hint that tells the caller what to do instead of leaving
 * them with a stack trace from a host service that was renamed.
 */

export const ERROR_CODES = Object.freeze({
  UNSUPPORTED: 'UNSUPPORTED',
  BAD_ARGUMENT: 'BAD_ARGUMENT',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  DENIED: 'DENIED',
  TIMEOUT: 'TIMEOUT',
  INTERNAL: 'INTERNAL',
});

export class ModapiError extends Error {
  constructor(code, message, context = {}) {
    const text = typeof message === 'string' && message.length > 0 ? message : String(code);
    super(text, context.cause === undefined ? undefined : { cause: context.cause });
    this.name = 'ModapiError';
    this.code = code;
    this.domain = context.domain ?? null;
    this.method = context.method ?? null;
    this.hint = context.hint ?? null;
    this.detail = context.detail ?? null;
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      domain: this.domain,
      method: this.method,
      hint: this.hint,
    };
  }
}

export function isModapiError(error) {
  return error instanceof ModapiError || (error !== null && typeof error === 'object' && error.name === 'ModapiError' && typeof error.code === 'string');
}

export function messageOf(error) {
  if (error === null || error === undefined) return 'unknown error';
  if (typeof error === 'string') return error;
  if (typeof error.message === 'string' && error.message.length > 0) return error.message;
  return String(error);
}

/** Host error codes mapped onto this API's vocabulary. */
const HOST_CODES = new Map([
  ['ENOENT', ERROR_CODES.NOT_FOUND],
  ['ENOTDIR', ERROR_CODES.NOT_FOUND],
  ['FS_NOT_FOUND', ERROR_CODES.NOT_FOUND],
  ['FS_EDIT_NOT_FOUND', ERROR_CODES.NOT_FOUND],
  ['EACCES', ERROR_CODES.DENIED],
  ['EPERM', ERROR_CODES.DENIED],
  ['FS_PERMISSION_DENIED', ERROR_CODES.DENIED],
  ['FS_SANDBOX_DENIED', ERROR_CODES.DENIED],
  ['EEXIST', ERROR_CODES.CONFLICT],
  ['EBUSY', ERROR_CODES.CONFLICT],
  ['FS_STALE_VERSION', ERROR_CODES.CONFLICT],
  ['FS_NOT_OBSERVED', ERROR_CODES.CONFLICT],
  ['FS_NOT_REGULAR_FILE', ERROR_CODES.CONFLICT],
  ['FS_AMBIGUOUS_EDIT', ERROR_CODES.CONFLICT],
  ['ETIMEDOUT', ERROR_CODES.TIMEOUT],
  ['EABORT', ERROR_CODES.TIMEOUT],
  ['FS_ABORTED', ERROR_CODES.TIMEOUT],
  ['FS_NOT_TEXT', ERROR_CODES.BAD_ARGUMENT],
  ['FS_NOT_DIRECTORY', ERROR_CODES.BAD_ARGUMENT],
  ['FS_TOO_LARGE', ERROR_CODES.BAD_ARGUMENT],
  ['FS_IO_ERROR', ERROR_CODES.INTERNAL],
]);

/** Translate a host error into a ModapiError without losing the original. */
export function classify(error, context = {}) {
  if (isModapiError(error)) return error;
  const raw = error !== null && typeof error === 'object' ? error : {};
  const hostCode = typeof raw.code === 'string' ? raw.code : '';
  const code = HOST_CODES.get(hostCode) ?? ERROR_CODES.INTERNAL;
  return new ModapiError(code, messageOf(error), {
    ...context,
    cause: error,
    detail: hostCode === '' ? null : hostCode,
  });
}

export function wrapError(error, context = {}) {
  return classify(error, context);
}

export function assert(condition, code, message, context = {}) {
  if (!condition) throw new ModapiError(code, message, context);
}

export function requireString(value, name, context = {}) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ModapiError(ERROR_CODES.BAD_ARGUMENT, `${name} must be a non-empty string`, context);
  }
  return value;
}
