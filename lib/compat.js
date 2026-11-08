/**
 * Resolving host services defensively.
 *
 * `inject` is all-or-nothing in cordis: declaring `['sessions']` wedges the
 * whole plugin when a build drops that service. So modapi declares nothing and
 * probes with `ctx.get(name, false)` on every call instead.
 */
import { ModapiError, ERROR_CODES, messageOf, isModapiError, classify } from './errors.js';

function safeGet(ctx, name) {
  try {
    const service = ctx.get(name, false);
    return service === undefined ? undefined : service;
  } catch {
    return undefined;
  }
}

export function createCompat(ctx, logger, options = {}) {
  const onUnsupported = typeof options.onUnsupported === 'function' ? options.onUnsupported : undefined;

  function getService(name) {
    return safeGet(ctx, name);
  }

  function getFirstService(names) {
    const list = Array.isArray(names) ? names : [names];
    for (const name of list) {
      const service = getService(name);
      if (service !== undefined) return { name, service };
    }
    return undefined;
  }

  function requireService(names, domain, method, hint) {
    const found = getFirstService(names);
    if (found !== undefined) return found.service;
    const list = Array.isArray(names) ? names : [names];
    throw new ModapiError(
      ERROR_CODES.UNSUPPORTED,
      `host service ${list.join(' | ')} is not available on this DSH build`,
      { domain, method, hint: hint ?? 'Check ctx.modapi.services(); the host renamed or removed that service.' },
    );
  }

  /** First callable among alias names, bound to its owner. */
  function methodOf(target, names) {
    if (target === null || target === undefined) return undefined;
    for (const name of names) {
      const candidate = target[name];
      if (typeof candidate === 'function') return candidate.bind(target);
    }
    return undefined;
  }

  function requireMethod(target, names, domain, method) {
    const fn = methodOf(target, names);
    if (fn !== undefined) return fn;
    throw new ModapiError(
      ERROR_CODES.UNSUPPORTED,
      `host method ${names.join(' | ')} is missing`,
      { domain, method, hint: 'The host changed this method; update the matching file in lib/domains/.' },
    );
  }

  /** Run a domain body, normalising every throw to ModapiError. */
  async function run(context, body) {
    try {
      return await body();
    } catch (caught) {
      let error = caught;
      if (!isModapiError(error)) {
        const hostCode = error !== null && typeof error === 'object' && typeof error.code === 'string' ? error.code : '';
        error = hostCode === ''
          ? new ModapiError(ERROR_CODES.INTERNAL, messageOf(caught), { ...context, cause: caught })
          : classify(caught, context);
      }
      if (error.code === ERROR_CODES.UNSUPPORTED && onUnsupported !== undefined) {
        try {
          onUnsupported({
            code: error.code,
            domain: error.domain ?? context.domain,
            method: error.method ?? context.method,
            message: error.message,
          });
        } catch {
          // Reporting a failure must never replace the failure.
        }
      }
      throw error;
    }
  }

  /** Which host services exist right now. */
  function probe(map) {
    const out = {};
    for (const [key, names] of Object.entries(map ?? {})) {
      out[key] = getFirstService(names) !== undefined;
    }
    return out;
  }

  function asOptions(value) {
    return value !== null && typeof value === 'object' ? value : {};
  }

  return { ctx, logger, getService, getFirstService, requireService, methodOf, requireMethod, run, probe, asOptions };
}
