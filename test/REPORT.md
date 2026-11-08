# dsh-modapi 测试报告（缺陷与偏差）

运行入口：`node test/all.js`（本沙箱内 `node --test test/` 会 `spawn EPERM`，因此使用单进程入口）。
当前结果：`tests 221 / pass 221 / fail 0`。

本文件只记录**产品代码**的问题；`lib/`、`index.js`、`package.json` 均未被我修改（本次会话只有 `test/` 下的写入）。
所有复现命令都在仓库根目录 `D:\dsh\dsh-modapi` 执行。

---

## D1 · 超限请求体：客户端收到连接重置，而不是 400 错误信封

- 位置：`lib/bridge.js:35-36`（`readJsonBody`）
- 现象：请求体超过 `MAX_BODY_BYTES`（32768）时，代码先 `reject(new ModapiError(BAD_ARGUMENT, 'request body exceeds ... bytes'))`，紧接着 `request.destroy()`。但 `createBridgeHandler` 的 catch 分支（`lib/bridge.js:131-135`）还要往同一个响应写 400 JSON，而 socket 已被销毁，响应写不出去，客户端只看到 `ECONNRESET`（`socket hang up`）。
- 实测：向挂载了 handler 的真实 `node:http` 服务 POST 38899 字节的 ack 体，客户端得到 `request error: ECONNRESET socket hang up`，没有状态码，也没有 `{ok:false, error:{code:'BAD_ARGUMENT'}}` 信封。
- 期望：超限时返回 400 + BAD_ARGUMENT 信封；若要断开连接，应先写出响应并 `response.end()`，再销毁请求（或至少不要销毁还在写的响应所依赖的连接）。
- 复现命令：

```bash
cd D:\dsh\dsh-modapi
node --input-type=module -e "
import http from 'node:http';
import { createBridgeHandler } from './lib/bridge.js';
const h = createBridgeHandler({ info: () => ({}), notices: () => [], ack: () => 0 }, { log: { warn() {} } });
const s = http.createServer((q, r) => h(q, r));
await new Promise((r) => s.listen(0, '127.0.0.1', r));
const { port } = s.address();
const body = JSON.stringify({ ids: Array.from({ length: 5000 }, (_, i) => 'n' + i) });
await new Promise((done) => {
  const req = http.request({ host: '127.0.0.1', port, path: '/modapi/api/notices/ack', method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), host: '127.0.0.1:' + port } },
    (res) => { console.log('status', res.statusCode); done(); });
  req.on('error', (e) => { console.log('request error:', e.code); done(); });
  req.end(body);
});
s.closeAllConnections(); s.close();
"
# 实际输出：request error: ECONNRESET
```

现有测试 `test/bridge.test.js` 用假的 `EventEmitter` 请求直接测 `readJsonBody`，所以能断言“抛 BAD_ARGUMENT 且 destroy 被调用”，但覆盖不到“响应写不出去”这一真实套接字行为；`POST` 超限体的端到端路径未覆盖（见“未覆盖”）。

---

## D2 · `toISO()` 对超范围毫秒数抛出 `RangeError`

- 位置：`lib/json.js:37`
  ```js
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString();
  ```
- 现象：`Number.isFinite` 只保证是有限数，不保证在 `Date` 可表示范围（±8.64e15 ms）内。传入 `1e20` 时 `new Date(1e20)` 是 Invalid Date，`.toISOString()` 抛 `RangeError: Invalid time value`。
- 影响面：`lib/domains/session.js:36`、`lib/domains/work.js:17`、`lib/domains/work.js:18` 都把宿主返回的 `createdAt/updatedAt/created/updated` 直接交给 `toISO`。宿主若给出一个异常但“有限”的时间戳（例如上游计算溢出），`session.list()` / `work.list()` 会整体抛出 RangeError，而不是降级为 `''`。同文件 `toJSONValue`（`lib/json.js:63`）对 Date 做了 `Number.isFinite(getTime())` 防御，数字分支没有对应防御，行为不一致。
- 期望：超范围的有限数返回 `''`（与 Invalid Date 的处理一致），或至少不抛出。
- 复现命令：

```bash
cd D:\dsh\dsh-modapi
node --input-type=module -e "import('./lib/json.js').then((m) => { try { console.log(m.toISO(1e20)); } catch (e) { console.log(e.name + ': ' + e.message); } })"
# 实际输出：RangeError: Invalid time value
```

---

## D3 · 脚本运行失败时，未带 `source` 的 hook 订阅泄漏

- 位置：`lib/scripts.js:134`（`loadFile` 的运行期失败清理）；对照 `lib/scripts.js:121`（编译前清理）、`lib/scripts.js:160/169`（reload/unload 清理）
- 现象：失败清理只调用 `hooks.removeBySource(tag)`，`tag` 形如 `script:<绝对路径>`。脚本里若用 `modapi.hook('x', fn)`（第二个参数之后不传 `{source}`），注册的 source 是默认值 `plugin`，`removeBySource('script:...')` 匹配不到，订阅留在注册表里：脚本已经失败并从 `files()` 消失，但 hook 仍会在每次 `fire('x')` 时执行。同一脚本里通过沙箱预置的 `checkstart`/`checkstop` 等函数注册的订阅带正确 tag，会被清掉；只有显式 `modapi.hook(name, fn)` 这种写法泄漏。
- 期望：脚本失败后，该脚本注册的所有订阅都消失（例如沙箱里的 `modapi.hook` 缺省 `source` 时补成当前脚本的 tag，或失败时按 handler 来源追踪并全部移除）。
- 复现命令：

```bash
cd D:\dsh\dsh-modapi
node --input-type=module -e "
import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os';
import { HookRegistry } from './lib/hooks.js';
import { createScriptHost } from './lib/scripts.js';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modapi-leak-'));
fs.mkdirSync(path.join(dir, 'modapi', 'scripts'), { recursive: true });
fs.writeFileSync(path.join(dir, 'modapi', 'scripts', 'bad.js'), \"modapi.hook('leaky', () => {});\nthrow new Error('boom');\n\");
const hooks = new HookRegistry();
const api = { work: {}, session: {}, tool: {}, fs: {}, notice: {}, toast: {}, 公告: {}, sleep: () => {},
  hook: (n, h, o) => hooks.on(n, h, o) };
const host = createScriptHost({ api, hooks, logger: { info() {}, warn() {}, error() {}, debug() {} }, dshHome: dir, cwd: dir, config: { scriptDirs: [], scripts: [] } });
await host.load();
console.log('files:', host.files().length, 'leaky subscriptions:', hooks.count('leaky'));
host.dispose(); fs.rmSync(dir, { recursive: true, force: true });
"
# 实际输出：files: 0 leaky subscriptions: 1
```

---

## D4 · `work.move()` 把空 id 保留在顺序里（与同文件的 `toStringArray` 不一致）

- 位置：`lib/domains/work.js:121`
  ```js
  return Array.isArray(order) ? order.map(toId) : [];
  ```
- 现象：`move()` 对服务返回的顺序数组逐项 `toId`，`toId('')` 得到 `''`，空串被原样保留；而同一模块里 `sessionIds` 走 `toStringArray`，空串会被丢弃。宿主若返回 `['w1', 7, '']`，领域层返回 `['w1', '7', '']`，调用方拿到一个不存在的空 id。
- 期望：过滤掉 `''`，与 `toStringArray` 的归一化一致（至少保证返回的 id 都是非空字符串）。
- 复现命令：

```bash
cd D:\dsh\dsh-modapi
node --input-type=module -e "
import { createWorkDomain } from './lib/domains/work.js';
import { createCompat } from './lib/compat.js';
const registry = { list: async () => [], insertBefore: async () => ['w1', 7, ''] };
const compat = createCompat({ get: (n) => (n === 'workspaceRegistry' ? registry : undefined) }, console);
const work = createWorkDomain(compat);
console.log(await work.move('w2', ['w1', 7, '']));
"
# 实际输出：[ 'w1', '7', '' ]
```

严重度：低（仅影响返回值形状；没有宿主会真的返回空 id 时不会触发）。

---

## 与任务简报不一致的点（不算缺陷，记录以免误判）

1. **空 body 的 `POST /notices/ack`**：简报描述为 400；实现（`lib/bridge.js:114` 附近 + `readJsonBody` 的空 body 分支）返回 `200 {ok:true, value:{acked:0}}`。测试按实现断言，未按简报断言。
2. **`readHostVersion()` 的缺失返回值**：简报写 “`null`/`undefined`”；实现（`index.js:58-79`）返回 `''`（空字符串），且按模块缓存。测试按实现断言。
3. **`registerBridge` 的失败状态**：简报只说 `reject` 返回 401/403 被拒；实现里还有 `failed: ...` / `'disposed'` 两种字符串状态，`failure()` 在未安装但未失败时返回 `null`，dispose 后返回 `'disposed'`。

## 会话期间的产品文件变动（非我修改）

我只写 `test/`；`lib/`、`index.js`、`package.json` 没有任何来自本会话的写入。但若干产品文件的 mtime 落在会话时间窗内（19:16–19:35），最后一次全绿运行发生在这些 mtime 之后，因此测试断言的是当前工作树的实际行为：

| 文件 | mtime |
| --- | --- |
| index.js | 19:24:14 |
| lib/bridge.js | 19:24:09 |
| lib/notices.js | 19:26:06 |
| lib/modapi.js | 19:32:36 |
| lib/domains/fs.js | 19:34:55 |
| lib/scripts.js | 19:35:02 |

其中 `lib/scripts.js` 的改动有明确证据：改动前 `load()` 里 `const files = discoverScripts(...)` 遮蔽了同名的 `files()` 函数，`host.load()` 会抛 `TypeError: files is not a function`（19:32 实测，旧文件第 155 行）；改写后该局部变量名为 `targets`，行为正常。其余文件的改动内容我未比对（未保留改写前的副本），只确认当前版本下 221 条用例全绿。

## 已确认不是缺陷的行为（探测过，避免后续误报）

- 同一 handler 注册两次后调用其中一个 disposer：订阅数 2 → 1，触发一次只调用一次（disposer 按条目移除，不会误删另一条）。
- `store.ack([id, id])`：返回 1，实际移除 1 条。
- `hook` 名称/处理器校验先于数量上限检查：非法参数抛 BAD_ARGUMENT，而不是 CONFLICT。
