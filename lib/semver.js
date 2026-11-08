/**
 * The slice of semver the plugin needs.
 *
 * Fabric API versions its modules (`^1.2.0`) and mods declare ranges against
 * them; nothing else here needs a full semver implementation, and a dependency
 * on `semver` would mean shipping node_modules into a bundled profile.
 * Supported: exact, `*`/`x` wildcards, partial versions, `^`, `~`, `>`, `>=`,
 * `<`, `<=`, and `||` alternatives. Build metadata is ignored; prereleases sort
 * before their release and are compared identifier by identifier.
 */

const VERSION = /^[v=]?(\d+)(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

function toNumber(part) {
  if (part === undefined || part === 'x' || part === 'X' || part === '*') return null;
  return Number.parseInt(part, 10);
}

/** Parses `1`, `1.2`, `1.2.3-rc.1`, `v1.2.3`; returns null when it is not a version. */
export function parse(text) {
  if (typeof text !== 'string') return null;
  const match = VERSION.exec(text.trim());
  if (match === null) return null;
  const prerelease = match[4] === undefined ? [] : match[4].split('.');
  return {
    text: text.trim().replace(/^[v=]/, ''),
    major: Number.parseInt(match[1], 10),
    minor: toNumber(match[2]),
    patch: toNumber(match[3]),
    prerelease,
  };
}

export function format(version) {
  if (version === null || version === undefined) return '';
  const base = [version.major, version.minor ?? 0, version.patch ?? 0].join('.');
  const prerelease = version.prerelease ?? [];
  return prerelease.length === 0 ? base : `${base}-${prerelease.join('.')}`;
}

function compareIdentifier(left, right) {
  const leftNumeric = /^\d+$/.test(left);
  const rightNumeric = /^\d+$/.test(right);
  if (leftNumeric && rightNumeric) return Number.parseInt(left, 10) - Number.parseInt(right, 10);
  if (leftNumeric) return -1;
  if (rightNumeric) return 1;
  return left < right ? -1 : left > right ? 1 : 0;
}

/** -1, 0, 1; prereleases sort before the release they belong to. Null when either side is not a version. */
export function compare(left, right) {
  const a = typeof left === 'string' ? parse(left) : left;
  const b = typeof right === 'string' ? parse(right) : right;
  if (a === null || a === undefined || b === null || b === undefined) return null;
  for (const key of ['major', 'minor', 'patch']) {
    const diff = (a[key] ?? 0) - (b[key] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return 1;
  if (b.prerelease.length === 0) return -1;
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    if (a.prerelease[index] === undefined) return -1;
    if (b.prerelease[index] === undefined) return 1;
    const diff = compareIdentifier(a.prerelease[index], b.prerelease[index]);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

/** `^1.2.3` → `<2.0.0`; `^0.2.1` → `<0.3.0`; `^0.0.3` → `<0.0.4`. */
function caretBound(version) {
  if (version.major > 0) return { major: version.major + 1, minor: 0, patch: 0 };
  if ((version.minor ?? 0) > 0) return { major: 0, minor: version.minor + 1, patch: 0 };
  return { major: 0, minor: 0, patch: (version.patch ?? 0) + 1 };
}

/** `~1.2.3` → `<1.3.0`; `~1` → `<2.0.0`. */
function tildeBound(version) {
  if (version.minor === null) return { major: version.major + 1, minor: 0, patch: 0 };
  return { major: version.major, minor: version.minor + 1, patch: 0 };
}

function bare(version) {
  return { text: format(version), major: version.major, minor: version.minor ?? 0, patch: version.patch ?? 0, prerelease: version.prerelease ?? [] };
}

function testComparator(version, token) {
  const match = /^(>=|<=|>|<|=|\^|~)?\s*(.+)$/.exec(token);
  if (match === null) return false;
  const operator = match[1] ?? '=';
  const target = parse(match[2]);
  if (target === null) return false;
  const result = compare(version, bare(target));
  switch (operator) {
    case '>=':
      return result >= 0;
    case '<=':
      return result <= 0;
    case '>':
      return result > 0;
    case '<':
      return result < 0;
    case '^':
      return result >= 0 && compare(version, bare(caretBound(target))) < 0;
    case '~':
      return result >= 0 && compare(version, bare(tildeBound(target))) < 0;
    default:
      // Partial versions with `=` behave like a wildcard: `1.2` means `>=1.2.0 <1.3.0`.
      if (target.minor === null) {
        return version.major === target.major;
      }
      if (target.patch === null) {
        return version.major === target.major && (version.minor ?? 0) === target.minor;
      }
      return result === 0;
  }
}

/** True when `version` satisfies `range`. A `'*'`/`''` range accepts anything parseable. */
export function satisfies(version, range) {
  const parsed = typeof version === 'string' ? parse(version) : version;
  if (parsed === null) return false;
  if (typeof range !== 'string' || range.trim() === '' || range.trim() === '*' || range.trim() === 'x') return true;
  return range.split('||').some((alternative) => {
    const tokens = alternative.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return true;
    return tokens.every((token) => testComparator(parsed, token));
  });
}

/** Throws a readable TypeError for a malformed range, returns the range otherwise. */
export function validateRange(range) {
  if (typeof range !== 'string' || range.trim() === '') throw new TypeError('semver: range must be a non-empty string');
  for (const alternative of range.split('||')) {
    for (const token of alternative.trim().split(/\s+/).filter(Boolean)) {
      const match = /^(>=|<=|>|<|=|\^|~)?\s*(.+)$/.exec(token);
      const wildcard = match !== null && ['x', 'X', '*'].includes(match[2]);
      if (match === null || (parse(match[2]) === null && !wildcard)) throw new TypeError(`semver: bad range token "${token}" in "${range}"`);
    }
  }
  return range;
}
