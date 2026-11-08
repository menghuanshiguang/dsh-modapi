/**
 * `modapi.mod.json` — the per-mod manifest, in the spirit of `fabric.mod.json`.
 *
 * A script directory with this file becomes a mod: it has an id, a version,
 * declared entrypoints, and the API modules it needs. Directories without a
 * manifest stay plain script folders, so existing `scripts/*.js` files keep
 * working exactly as before.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ModapiError, ERROR_CODES } from './errors.js';
import { parse, format } from './semver.js';

export const MANIFEST_NAME = 'modapi.mod.json';
const ID = /^[a-z0-9_.-]+$/;
const ENTRYPOINTS = new Set(['start', 'stop']);

function bad(message, detail) {
  return new ModapiError(ERROR_CODES.BAD_ARGUMENT, message, { domain: 'manifest', method: 'validate', detail });
}

function normalizeList(value, field) {
  if (value === undefined) return [];
  const list = Array.isArray(value) ? value : [value];
  const out = [];
  for (const item of list) {
    if (typeof item !== 'string' || item.trim() === '') {
      throw bad(`entrypoints.${field} must contain non-empty strings`);
    }
    out.push(item.trim());
  }
  return out;
}

function normalizeSpec(value, field) {
  if (value === undefined) return {};
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw bad(`${field} must be an object of name → range`);
  }
  const out = {};
  for (const [name, range] of Object.entries(value)) {
    if (typeof range !== 'string' || range.trim() === '') {
      throw bad(`${field}.${name} must be a range string`);
    }
    out[name] = range.trim();
  }
  return out;
}

/** Validates raw manifest JSON; returns a normalized copy with absolute entrypoint paths. */
export function validateManifest(raw, options = {}) {
  const file = typeof options.file === 'string' ? options.file : MANIFEST_NAME;
  const dir = path.dirname(file);
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw bad(`${MANIFEST_NAME} must contain a JSON object`, { file });
  }
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  if (!ID.test(id)) {
    throw bad(`manifest id "${id}" must match ${ID}`, { file, field: 'id' });
  }
  const version = parse(typeof raw.version === 'string' ? raw.version : '');
  if (version === null) {
    throw bad(`manifest version "${String(raw.version)}" is not a version`, { file, field: 'version' });
  }
  const entrypointsInput = raw.entrypoints ?? {};
  if (entrypointsInput === null || typeof entrypointsInput !== 'object' || Array.isArray(entrypointsInput)) {
    throw bad('entrypoints must be an object', { file, field: 'entrypoints' });
  }
  const entrypoints = {};
  for (const [kind, value] of Object.entries(entrypointsInput)) {
    if (!ENTRYPOINTS.has(kind)) {
      throw bad(`entrypoints.${kind} is not a known entrypoint`, { file, field: 'entrypoints', known: [...ENTRYPOINTS] });
    }
    entrypoints[kind] = normalizeList(value, kind).map((item) => path.resolve(dir, item));
  }
  if ((entrypoints.start ?? []).length === 0) {
    throw bad('entrypoints.start must list at least one file', { file, field: 'entrypoints.start' });
  }
  const normalized = {
    id,
    version: format(version),
    name: typeof raw.name === 'string' && raw.name.trim() !== '' ? raw.name.trim() : id,
    entrypoints,
    requires: normalizeSpec(raw.requires, 'requires'),
    depends: normalizeSpec(raw.depends, 'depends'),
    dir,
    file,
  };
  return normalized;
}

export function readManifest(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    throw new ModapiError(ERROR_CODES.NOT_FOUND, `cannot read ${file}`, { domain: 'manifest', cause: error, detail: { file } });
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw bad(`${MANIFEST_NAME} is not valid JSON`, { file, reason: error.message });
  }
  return validateManifest(raw, { file });
}

/** Reads every manifest directly under `root` (one directory per mod). */
export function scanModRoot(root) {
  const found = [];
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const file = path.join(root, entry.name, MANIFEST_NAME);
    if (!fs.existsSync(file)) continue;
    found.push(file);
  }
  return found.sort((left, right) => left.localeCompare(right));
}

/**
 * Loads every manifest from the default mods directory plus extra roots.
 * Invalid manifests are reported through `onError` and skipped: one broken
 * mod must not prevent the others from loading.
 */
export function discoverMods(options = {}) {
  const cwd = typeof options.cwd === 'string' && options.cwd !== '' ? options.cwd : process.cwd();
  const roots = [];
  if (typeof options.dshHome === 'string' && options.dshHome !== '') {
    roots.push(path.join(options.dshHome, 'modapi', 'mods'));
  }
  for (const dir of Array.isArray(options.modDirs) ? options.modDirs : []) {
    if (typeof dir === 'string' && dir !== '') roots.push(path.resolve(cwd, dir));
  }
  const onError = typeof options.onError === 'function' ? options.onError : null;
  const mods = [];
  const seen = new Set();
  for (const root of roots) {
    for (const file of scanModRoot(root)) {
      try {
        const manifest = readManifest(file);
        if (seen.has(manifest.id)) {
          throw bad(`duplicate mod id "${manifest.id}"`, { file, first: [...seen] });
        }
        seen.add(manifest.id);
        mods.push(manifest);
      } catch (error) {
        onError?.(error, { file });
      }
    }
  }
  return mods;
}
