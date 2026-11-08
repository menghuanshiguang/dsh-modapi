import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compare, format, parse, satisfies, validateRange } from '../lib/semver.js';

test('parse: full, partial and prerelease versions', () => {
  assert.deepEqual(parse('1.2.3'), { text: '1.2.3', major: 1, minor: 2, patch: 3, prerelease: [] });
  assert.deepEqual(parse('v1.2'), { text: '1.2', major: 1, minor: 2, patch: null, prerelease: [] });
  assert.deepEqual(parse('2'), { text: '2', major: 2, minor: null, patch: null, prerelease: [] });
  assert.deepEqual(parse('1.2.3-rc.1'), { text: '1.2.3-rc.1', major: 1, minor: 2, patch: 3, prerelease: ['rc', '1'] });
});

test('parse: rejects text that is not a version', () => {
  assert.equal(parse('nope'), null);
  assert.equal(parse(''), null);
  assert.equal(parse(undefined), null);
  assert.equal(parse('1.2.3.4'), null);
});

test('format: fills the missing parts, keeps the prerelease', () => {
  assert.equal(format(parse('1.2.3-rc.1')), '1.2.3-rc.1');
  assert.equal(format(parse('v1.2')), '1.2.0');
  assert.equal(format(parse('2')), '2.0.0');
  assert.equal(format(null), '');
});

test('compare: numeric and prerelease ordering', () => {
  assert.equal(compare('1.0.0', '1.0.1'), -1);
  assert.equal(compare('1.1.0', '1.0.9'), 1);
  assert.equal(compare('1.0.0', '1.0.0'), 0);
  assert.equal(compare('1.0.0-rc.1', '1.0.0'), -1);
  assert.equal(compare('1.0.0-rc.1', '1.0.0-rc.2'), -1);
  assert.equal(compare('1.0.0-alpha', '1.0.0-beta'), -1);
});

test('compare: an unparseable side yields null instead of throwing', () => {
  assert.equal(compare('bad', '1.0.0'), null);
  assert.equal(compare('1.0.0', undefined), null);
});

test('satisfies: caret and tilde ranges', () => {
  assert.equal(satisfies('1.2.5', '^1.2.1'), true);
  assert.equal(satisfies('2.0.0', '^1.2.1'), false);
  assert.equal(satisfies('0.2.5', '^0.2.1'), true);
  assert.equal(satisfies('0.3.0', '^0.2.1'), false);
  assert.equal(satisfies('1.2.9', '~1.2.1'), true);
  assert.equal(satisfies('1.3.0', '~1.2.1'), false);
});

test('satisfies: comparators, wildcards and unions', () => {
  assert.equal(satisfies('1.5.0', '>=1.0.0 <2.0.0'), true);
  assert.equal(satisfies('2.0.0', '>=1.0.0 <2.0.0'), false);
  assert.equal(satisfies('3.1.0', '*'), true);
  assert.equal(satisfies('1.9.9', '1.x'), true);
  assert.equal(satisfies('2.9.9', '1.x'), false);
  assert.equal(satisfies('1.0.0', '1.0.0 || 2.0.0'), true);
  assert.equal(satisfies('2.0.0', '1.0.0 || 2.0.0'), true);
  assert.equal(satisfies('2.5.0', '1.0.0 || 2.0.0'), false);
});

test('satisfies: a partial equality range acts as a wildcard', () => {
  assert.equal(satisfies('1.9.0', '1'), true);
  assert.equal(satisfies('1.9.0', '1.2'), false);
  assert.equal(satisfies('1.2.9', '1.2'), true);
});

test('satisfies: prereleases need an explicit prerelease comparator', () => {
  assert.equal(satisfies('0.2.1-rc.5', '>=0.2.0'), true);
  assert.equal(satisfies('0.2.1-rc.5', '0.2.1'), false);
  assert.equal(satisfies('0.2.0', '>=0.2.0-rc.1'), true);
});

test('satisfies: malformed input is false, not a throw', () => {
  assert.equal(satisfies('nope', '^1.0.0'), false);
  assert.equal(satisfies('1.0.0', 'not a range'), false);
  // No range means no constraint; validateRange is what rejects a missing range.
  assert.equal(satisfies('1.0.0', undefined), true);
});

test('validateRange: returns the range or throws with the offending token', () => {
  for (const range of ['*', '1', '1.2', '^1.2.3', '~0.2', '>=1.0.0 <2', '1.0.0 || ^2.0.0', '1.x']) {
    assert.equal(validateRange(range), range);
  }
  assert.throws(() => validateRange(''), /non-empty string/);
  assert.throws(() => validateRange('^'), /bad range token/);
  assert.throws(() => validateRange('not a range'), /bad range token/);
});
