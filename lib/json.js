/**
 * Reading host objects without trusting them.
 *
 * Host entities expose getters, sometimes aliases, sometimes throwing getters.
 * Nothing host-shaped may escape the API, so every field goes through here.
 */

/** Read the first alias that yields a value; a throwing getter counts as absent. */
export function readField(source, names) {
  if (source === null || source === undefined) return undefined;
  for (const name of names) {
    try {
      const value = source[name];
      if (value !== undefined && value !== null) return value;
    } catch {
      // A getter that throws is indistinguishable from a missing field here.
    }
  }
  return undefined;
}

export function toId(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

export function toText(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

export function toISO(value) {
  if (typeof value === 'string') return value;
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
  if (typeof value === 'number' && Number.isFinite(value)) {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toISOString() : '';
  }
  return '';
}

export function toStringArray(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    const text = toId(item);
    if (text !== '') out.push(text);
  }
  return out;
}

/** Plain-JSON copy: cycles become '[circular]', class instances become own data. */
export function toJSONValue(value, options = {}) {
  const maxDepth = Number.isFinite(options.maxDepth) ? options.maxDepth : 12;
  const maxItems = Number.isFinite(options.maxItems) ? options.maxItems : 5000;
  const seen = new WeakSet();

  function walk(input, depth) {
    if (input === null || input === undefined) return null;
    const type = typeof input;
    if (type === 'string' || type === 'number' || type === 'boolean') return input;
    if (type === 'bigint') return String(input);
    if (type === 'function' || type === 'symbol') return null;
    if (input instanceof Date) return Number.isFinite(input.getTime()) ? input.toISOString() : '';
    if (input instanceof Error) return { name: input.name, message: input.message, code: input.code ?? null };
    if (depth >= maxDepth) return '[depth]';
    if (typeof input === 'object' && seen.has(input)) return '[circular]';
    if (typeof input === 'object') seen.add(input);
    if (Array.isArray(input)) {
      const items = input.slice(0, maxItems).map((item) => walk(item, depth + 1));
      return items;
    }
    if (input instanceof Map) {
      const out = {};
      let count = 0;
      for (const [key, item] of input) {
        if (count >= maxItems) break;
        out[toText(key)] = walk(item, depth + 1);
        count += 1;
      }
      return out;
    }
    if (input instanceof Set) {
      return [...input].slice(0, maxItems).map((item) => walk(item, depth + 1));
    }
    const out = {};
    for (const key of Object.keys(input)) {
      try {
        out[key] = walk(input[key], depth + 1);
      } catch {
        out[key] = null;
      }
    }
    return out;
  }

  return walk(value, 0);
}

/** Copy the named fields from `source` through `map`. */
export function pick(source, fields, map = {}) {
  const out = {};
  for (const field of fields) {
    const reader = map[field] ?? ((value) => value);
    out[field] = reader(readField(source, [field]));
  }
  return out;
}
