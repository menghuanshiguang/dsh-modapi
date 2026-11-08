/**
 * Single-process test entry.
 *
 * `node --test test/` spawns a child per file, which this sandbox refuses
 * (spawn EPERM), so the suite is imported into one process instead. Each file
 * registers its own `test()` calls; node:test reports the aggregate result.
 */
import { test } from 'node:test';

import './errors.test.js';
import './semver.test.js';
import './json.test.js';
import './compat.test.js';
import './hooks.test.js';
import './notices.test.js';
import './bridge.test.js';
import './work.test.js';
import './session.test.js';
import './tool.test.js';
import './fs.test.js';
import './scripts.test.js';
import './selfcheck.test.js';
import './index.test.js';
import './modapi.test.js';
import './mods.test.js';
import './manifest.test.js';
import './modules.test.js';
import './registry.test.js';
import './events.test.js';
import './patcher.test.js';
import './ui.test.js';

test('the suite entry itself is wired', () => {
  // Placeholder so a broken import chain fails loudly instead of reporting zero.
});
