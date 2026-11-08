import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ERROR_CODES,
  ModapiError,
  isModapiError,
  messageOf,
  classify,
  wrapError,
  assert as assertModapi,
  requireString,
} from '../lib/errors.js';

test('ERROR_CODES: seven frozen codes whose keys equal their values', () => {
  const expected = ['BAD_ARGUMENT', 'CONFLICT', 'DENIED', 'INTERNAL', 'NOT_FOUND', 'TIMEOUT', 'UNSUPPORTED'];
  assert.deepEqual(Object.keys(ERROR_CODES).sort(), expected);
  assert.equal(Object.isFrozen(ERROR_CODES), true);
  for (const [key, value] of Object.entries(ERROR_CODES)) assert.equal(key, value);
});

test('ModapiError: carries code, message and null defaults', () => {
  const error = new ModapiError('BAD_ARGUMENT', 'nope');
  assert.ok(error instanceof Error);
  assert.ok(error instanceof ModapiError);
  assert.equal(error.name, 'ModapiError');
  assert.equal(error.code, 'BAD_ARGUMENT');
  assert.equal(error.message, 'nope');
  assert.equal(error.domain, null);
  assert.equal(error.method, null);
  assert.equal(error.hint, null);
  assert.equal(error.detail, null);
  assert.equal(error.cause, undefined);
});

test('ModapiError: falls back to the code when the message is unusable', () => {
  assert.equal(new ModapiError('INTERNAL', '').message, 'INTERNAL');
  assert.equal(new ModapiError('INTERNAL', 42).message, 'INTERNAL');
  assert.equal(new ModapiError('INTERNAL').message, 'INTERNAL');
  assert.equal(new ModapiError('INTERNAL', 'ok', { cause: 'why' }).message, 'ok');
});

test('ModapiError: keeps the cause and every context field', () => {
  const cause = new Error('root');
  const error = new ModapiError('TIMEOUT', 'slow', { cause, domain: 'work', method: 'list', hint: 'retry', detail: 'EABORT' });
  assert.equal(error.cause, cause);
  assert.equal(error.domain, 'work');
  assert.equal(error.method, 'list');
  assert.equal(error.hint, 'retry');
  assert.equal(error.detail, 'EABORT');
});

test('ModapiError.toJSON: public fields only, no detail or cause', () => {
  const error = new ModapiError('CONFLICT', 'taken', { domain: 'fs', method: 'write', hint: 'h', detail: 'FS_STALE_VERSION' });
  assert.deepEqual(error.toJSON(), {
    name: 'ModapiError',
    code: 'CONFLICT',
    message: 'taken',
    domain: 'fs',
    method: 'write',
    hint: 'h',
  });
  assert.equal('detail' in error.toJSON(), false);
  assert.equal('cause' in error.toJSON(), false);
});

test('isModapiError: instances and duck-typed copies only', () => {
  assert.equal(isModapiError(new ModapiError('INTERNAL', 'x')), true);
  assert.equal(isModapiError({ name: 'ModapiError', code: 'NOT_FOUND' }), true);
  assert.equal(isModapiError(new Error('x')), false);
  assert.equal(isModapiError({ name: 'ModapiError' }), false);
  assert.equal(isModapiError({ name: 'ModapiError', code: 7 }), false);
  assert.equal(isModapiError(null), false);
  assert.equal(isModapiError(undefined), false);
  assert.equal(isModapiError('ModapiError'), false);
});

test('messageOf: text for every shape it is given', () => {
  assert.equal(messageOf(null), 'unknown error');
  assert.equal(messageOf(undefined), 'unknown error');
  assert.equal(messageOf('plain'), 'plain');
  assert.equal(messageOf(new Error('boom')), 'boom');
  assert.equal(messageOf({ message: '' }), '[object Object]');
  assert.equal(messageOf({ code: 'X' }), '[object Object]');
  assert.equal(messageOf(7), '7');
});

const HOST_TO_API = {
  ENOENT: 'NOT_FOUND',
  ENOTDIR: 'NOT_FOUND',
  FS_NOT_FOUND: 'NOT_FOUND',
  FS_EDIT_NOT_FOUND: 'NOT_FOUND',
  EACCES: 'DENIED',
  EPERM: 'DENIED',
  FS_PERMISSION_DENIED: 'DENIED',
  FS_SANDBOX_DENIED: 'DENIED',
  EEXIST: 'CONFLICT',
  EBUSY: 'CONFLICT',
  FS_STALE_VERSION: 'CONFLICT',
  FS_NOT_OBSERVED: 'CONFLICT',
  FS_NOT_REGULAR_FILE: 'CONFLICT',
  FS_AMBIGUOUS_EDIT: 'CONFLICT',
  ETIMEDOUT: 'TIMEOUT',
  EABORT: 'TIMEOUT',
  FS_ABORTED: 'TIMEOUT',
  FS_NOT_TEXT: 'BAD_ARGUMENT',
  FS_NOT_DIRECTORY: 'BAD_ARGUMENT',
  FS_TOO_LARGE: 'BAD_ARGUMENT',
  FS_IO_ERROR: 'INTERNAL',
};

test('classify: every mapped host code lands on its documented API code', () => {
  assert.equal(Object.keys(HOST_TO_API).length, 21);
  assert.equal(Object.keys(HOST_TO_API).filter((code) => code.startsWith('FS_')).length, 13);
  for (const [hostCode, apiCode] of Object.entries(HOST_TO_API)) {
    const cause = { code: hostCode, message: `${hostCode} failed` };
    const error = classify(cause);
    assert.equal(error.code, apiCode, hostCode);
    assert.equal(error.detail, hostCode, hostCode);
    assert.equal(error.message, `${hostCode} failed`, hostCode);
    assert.equal(error.cause, cause, hostCode);
  }
});

test('classify: unknown, absent and primitive inputs become INTERNAL', () => {
  const unknown = classify({ code: 'EZZZ', message: 'weird' });
  assert.equal(unknown.code, 'INTERNAL');
  assert.equal(unknown.detail, 'EZZZ');
  const bare = classify(new Error('bare'));
  assert.equal(bare.code, 'INTERNAL');
  assert.equal(bare.detail, null);
  assert.equal(bare.cause.message, 'bare');
  const primitive = classify('text');
  assert.equal(primitive.code, 'INTERNAL');
  assert.equal(primitive.message, 'text');
  assert.equal(primitive.detail, null);
});

test('classify/wrapError: an existing ModapiError passes through unchanged', () => {
  const original = new ModapiError('DENIED', 'nope');
  assert.equal(classify(original), original);
  assert.equal(wrapError(original), original);
});

test('wrapError: same translation as classify for host failures', () => {
  const host = Object.assign(new Error('gone'), { code: 'FS_STALE_VERSION' });
  const wrapped = wrapError(host, { domain: 'fs', method: 'write' });
  assert.equal(wrapped.code, 'CONFLICT');
  assert.equal(wrapped.detail, 'FS_STALE_VERSION');
  assert.equal(wrapped.cause, host);
  assert.equal(wrapped.domain, 'fs');
  const classified = classify(host, { domain: 'fs', method: 'write' });
  assert.deepEqual(wrapped.toJSON(), classified.toJSON());
});

test('classify: context is merged without overriding the mapped code', () => {
  const error = classify({ code: 'ENOENT', message: 'gone' }, { domain: 'fs', method: 'read' });
  assert.equal(error.code, 'NOT_FOUND');
  assert.equal(error.domain, 'fs');
  assert.equal(error.method, 'read');
});

test('assert: silent when true, BAD_ARGUMENT with context when false', () => {
  assert.equal(assertModapi(true, 'BAD_ARGUMENT', 'x'), undefined);
  assert.throws(
    () => assertModapi(false, 'BAD_ARGUMENT', 'missing', { domain: 'fs', method: 'write' }),
    (error) => error.code === 'BAD_ARGUMENT' && error.message === 'missing' && error.domain === 'fs' && error.method === 'write',
  );
});

test('requireString: returns the string, rejects everything else', () => {
  assert.equal(requireString('a', 'name'), 'a');
  for (const value of ['', 1, null, undefined, {}, []]) {
    assert.throws(
      () => requireString(value, 'name'),
      (error) => error.code === 'BAD_ARGUMENT' && /name must be a non-empty string/.test(error.message),
    );
  }
  assert.throws(
    () => requireString('', 'title', { domain: 'notice', method: 'push' }),
    (error) => error.domain === 'notice' && error.method === 'push',
  );
});
