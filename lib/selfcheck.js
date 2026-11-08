/**
 * Contract self-check.
 *
 * Boot-time: verify every capability this API promises, compare with the last
 * known-good baseline, and shout when an upgrade removed something. Call-time:
 * count `UNSUPPORTED` outcomes so a dead method is reported once, not on every
 * call.
 */
import fs from 'node:fs';
import path from 'node:path';
import { messageOf } from './errors.js';

export const STATE_SCHEMA = 1;

export const CAPABILITIES = Object.freeze([
  { id: 'work.list', domain: 'work', services: ['workspaceRegistry'], methods: ['list'], label: '工作区列表' },
  { id: 'work.create', domain: 'work', services: ['workspaceRegistry'], methods: ['create'], label: '新建工作区' },
  { id: 'session.list', domain: 'session', services: ['sessions', 'sessionStore'], methods: ['list'], label: '会话列表' },
  { id: 'session.get', domain: 'session', services: ['sessions', 'sessionStore'], methods: ['get'], label: '读取会话' },
  { id: 'tool.list', domain: 'tool', services: ['tools'], methods: ['view', 'schemas'], label: '工具清单' },
  { id: 'fs.resolve', domain: 'fs', services: ['fs', 'filesystem'], methods: ['resolve'], label: '路径解析' },
  { id: 'fs.read', domain: 'fs', services: ['fs', 'filesystem'], methods: ['readText'], label: '读取文件' },
  { id: 'fs.write', domain: 'fs', services: ['fs', 'filesystem'], methods: ['writeText'], label: '写入文件' },
  { id: 'fs.list', domain: 'fs', services: ['fs', 'filesystem'], methods: ['listDir'], label: '目录列表' },
  { id: 'notice.bridge', domain: 'notice', services: ['webServer'], methods: ['register'], label: '公告 HTTP 桥' },
]);

const LABELS = new Map(CAPABILITIES.map((cap) => [cap.id, cap.label]));

export function createSelfCheck(options = {}) {
  const compat = options.compat;
  const notices = options.notices;
  const logger = options.logger ?? null;
  const hostVersion = typeof options.hostVersion === 'string' ? options.hostVersion : '';
  const file = typeof options.statePath === 'string' && options.statePath.length > 0
    ? options.statePath
    : path.join(options.dshHome ?? process.cwd(), 'modapi', 'state', 'contract.json');
  const probeBridge = typeof options.probeBridge === 'function' ? options.probeBridge : undefined;
  const failures = new Map();
  let lastReport;

  function readState() {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (parsed === null || typeof parsed !== 'object') return undefined;
      if (parsed.schemaVersion !== STATE_SCHEMA) return undefined;
      return parsed;
    } catch {
      return undefined;
    }
  }

  async function writeState(state) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
      fs.renameSync(tmp, file);
      return true;
    } catch (error) {
      logger?.warn?.(`[dsh-modapi] cannot write contract baseline: ${messageOf(error)}`);
      return false;
    }
  }

  function checkOne(capability, deep) {
    if (capability.id === 'notice.bridge') {
      const status = probeBridge === undefined ? 'pending' : probeBridge();
      if (status === true) return { id: capability.id, ok: true, service: 'webServer' };
      if (status === 'pending') return { id: capability.id, ok: true, service: 'webServer', pending: true };
      return { id: capability.id, ok: false, reason: `bridge not mounted: ${String(status)}` };
    }
    const found = compat.getFirstService(capability.services);
    if (found === undefined) return { id: capability.id, ok: false, reason: `service missing: ${capability.services.join(' | ')}` };
    if (deep === true) {
      const method = compat.methodOf(found.service, capability.methods);
      if (method === undefined) return { id: capability.id, ok: false, reason: `method missing: ${capability.methods.join(' | ')}` };
    }
    return { id: capability.id, ok: true, service: found.name };
  }

  function labelOf(id) {
    return LABELS.get(id) ?? id;
  }

  async function run(options = {}) {
    const deep = options.deep !== false;
    const checked = CAPABILITIES.map((capability) => checkOne(capability, deep));
    const missing = checked.filter((item) => !item.ok);
    const previous = readState();
    const previouslyOk = new Set(
      previous !== undefined && previous.capabilities !== undefined
        ? Object.entries(previous.capabilities).filter(([, value]) => value === 'ok').map(([id]) => id)
        : [],
    );
    const regressed = missing
      .filter((item) => previouslyOk.has(item.id))
      .map((item) => ({ id: item.id, label: labelOf(item.id), reason: item.reason }));

    if (regressed.length > 0 && options.notify !== false) announceRegression(regressed, previous);
    else if (missing.length > 0) logger?.warn?.(`[dsh-modapi] self-check: ${missing.map((item) => `${item.id} (${item.reason})`).join('; ')}`);

    if (missing.length === 0 && options.updateBaseline !== false) {
      await writeState({
        schemaVersion: STATE_SCHEMA,
        apiVersion: '1',
        host: hostVersion,
        at: new Date().toISOString(),
        capabilities: Object.fromEntries(checked.map((item) => [item.id, 'ok'])),
      });
    }

    lastReport = {
      ok: missing.length === 0,
      checked: checked.length,
      missing: missing.map((item) => ({ id: item.id, label: labelOf(item.id), reason: item.reason })),
      regressed,
      statePath: file,
      at: new Date().toISOString(),
    };
    return lastReport;
  }

  function announceRegression(regressed, previous) {
    if (notices === undefined) return;
    const from = previous?.host !== undefined && previous.host !== '' ? previous.host : '旧版本';
    const to = hostVersion !== '' ? hostVersion : '当前版本';
    const detail = regressed.map((item) => `${item.label}（${item.id}）：${item.reason}`).join('\n');
    try {
      const record = notices({
        level: 'error',
        title: 'modapi：接口失效（DSH 升级后）',
        body: `DSH ${from} → ${to}\n${detail}`,
        kind: 'modapi.selfcheck',
        duration: 0,
      });
      record.show();
    } catch (error) {
      logger?.warn?.(`[dsh-modapi] cannot announce self-check regression: ${messageOf(error)}`);
    }
  }

  /** Count one UNSUPPORTED outcome; the first one for a method raises a notice. */
  function noteUnsupported(info = {}) {
    const key = `${info.domain ?? '?'}.${info.method ?? '?'}`;
    const entry = failures.get(key);
    if (entry === undefined) {
      failures.set(key, { key, count: 1, firstAt: new Date().toISOString(), lastAt: new Date().toISOString(), message: info.message ?? '' });
      if (notices !== undefined) {
        try {
          notices({
            level: 'error',
            title: 'modapi：接口不可用',
            body: `${key} 在当前 DSH 版本上不可用\n${info.message ?? ''}`.trim(),
            kind: 'modapi.failure',
            duration: 0,
          }).show();
        } catch (error) {
          logger?.warn?.(`[dsh-modapi] cannot announce unsupported method: ${messageOf(error)}`);
        }
      }
    } else {
      entry.count += 1;
      entry.lastAt = new Date().toISOString();
      if (info.message !== undefined && info.message !== '') entry.message = info.message;
    }
    return failures.get(key).count;
  }

  return {
    run,
    noteUnsupported,
    labelOf,
    statePath: file,
    snapshot() {
      return {
        last: lastReport ?? null,
        failures: [...failures.values()].map((entry) => ({ ...entry })),
        baseline: readState() ?? null,
      };
    },
    resetFailures() {
      failures.clear();
    },
    get failureCount() {
      return failures.size;
    },
  };
}
