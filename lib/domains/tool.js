/**
 * `modapi.tool` — tool runtime.
 *
 * The host has no `list()`: it exposes a view per scope and `schemas()`. Both
 * are read here and normalised to the same record shape.
 */
import { randomUUID } from 'node:crypto';
import { readField, toText, toJSONValue } from '../json.js';
import { ModapiError, ERROR_CODES } from '../errors.js';

export const TOOL_SERVICES = Object.freeze(['tools']);

export function toToolRecord(schema) {
  return {
    name: toText(readField(schema, ['name'])),
    description: toText(readField(schema, ['description'])),
    parameters: toJSONValue(readField(schema, ['parameters', 'inputSchema', 'schema']) ?? null),
    deferred: readField(schema, ['deferLoading']) === true,
  };
}

function entriesOf(view) {
  if (view === null || view === undefined) return [];
  const visible = readField(view, ['visible']);
  if (visible instanceof Map) return [...visible.values()];
  if (Array.isArray(visible)) return visible;
  if (Array.isArray(view)) return view;
  return [];
}

export function createToolDomain(compat) {
  const domain = 'tool';

  function runtime(method) {
    return compat.requireService(TOOL_SERVICES, domain, method);
  }

  async function list(scope) {
    return compat.run({ domain, method: 'list' }, async () => {
      const service = runtime('list');
      const view = compat.methodOf(service, ['view']);
      if (view !== undefined) {
        const result = await view(scope);
        return entriesOf(result).map(toToolRecord).filter((item) => item.name !== '');
      }
      const schemas = compat.requireMethod(service, ['schemas'], domain, 'list');
      const all = await schemas(scope);
      if (!Array.isArray(all)) {
        throw new ModapiError(ERROR_CODES.INTERNAL, 'tools.schemas() did not return an array', { domain, method: 'list' });
      }
      return all.map(toToolRecord).filter((item) => item.name !== '');
    });
  }

  async function schemas(scope) {
    return list(scope);
  }

  async function get(name, scope) {
    if (typeof name !== 'string' || name.length === 0) {
      throw new ModapiError(ERROR_CODES.BAD_ARGUMENT, 'tool.get(name) needs a tool name', { domain, method: 'get' });
    }
    return compat.run({ domain, method: 'get' }, async () => {
      const service = runtime('get');
      const read = compat.methodOf(service, ['get']);
      if (read !== undefined) {
        const found = await read(name, scope);
        if (found !== undefined && found !== null) return toToolRecord(found);
      }
      return (await list(scope)).find((item) => item.name === name) ?? null;
    });
  }

  /**
   * Execute one tool. `agent` is optional in the host API, which means the host
   * silently skips agent-level guards when it is absent -- `scoped` reports that.
   */
  async function call(name, args, settings = {}) {
    if (typeof name !== 'string' || name.length === 0) {
      throw new ModapiError(ERROR_CODES.BAD_ARGUMENT, 'tool.call(name, args) needs a tool name', { domain, method: 'call' });
    }
    return compat.run({ domain, method: 'call' }, async () => {
      const service = runtime('call');
      const execute = compat.requireMethod(service, ['execute'], domain, 'call');
      const agent = settings.agent;
      const scoped = agent !== undefined && agent !== null;
      let controller;
      let signal = settings.signal;
      if (signal === undefined && Number.isFinite(settings.timeoutMs) && settings.timeoutMs > 0) {
        controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), Math.floor(settings.timeoutMs));
        if (typeof timer.unref === 'function') timer.unref();
        signal = controller.signal;
      }
      if (signal === undefined) {
        throw new ModapiError(ERROR_CODES.BAD_ARGUMENT, 'tool.call() needs a signal or a positive timeoutMs', { domain, method: 'call' });
      }
      const callId = typeof settings.callId === 'string' && settings.callId.length > 0 ? settings.callId : randomUUID();
      try {
        const result = await execute({ callId, name, arguments: args ?? {}, signal, ...(scoped ? { agent } : {}) });
        const ok = readField(result, ['ok', 'success']);
        return {
          name,
          ok: ok === undefined ? result !== undefined : ok === true,
          scoped,
          content: toJSONValue(readField(result, ['content', 'output', 'value']) ?? null),
          result: toJSONValue(result ?? null),
        };
      } finally {
        controller?.abort();
      }
    });
  }

  return {
    list,
    schemas,
    names: async (scope) => (await list(scope)).map((item) => item.name),
    get,
    has: async (name, scope) => (await get(name, scope)) !== null,
    count: async (scope) => (await list(scope)).length,
    call,
    run: call,
    toRecord: toToolRecord,
    services: TOOL_SERVICES,
  };
}
