# dsh-modapi API 参考

`dsh-modapi` 把 DeepSeek Harness 的内部服务收成一张函数表。本文按域逐个列签名、参数、返回、错误与示例，内容以仓库当前源码为准（`index.js`、`lib/*.js`、`lib/domains/*.js`）。末尾「已知偏差与未验证项」列出代码实际行为与直觉不一致的地方。

```js
export const inject = ['modapi'];
export function apply(ctx) {
  const api = ctx.modapi;
  const rows = await api.work.list();
}
```

脚本沙箱里不用 `ctx`，直接 `work.list()`、`公告(...)`。

---

## 0. 约定

### 0.1 谁返回 Promise

四个域（`work` / `session` / `tool` / `fs`）的方法返回 Promise，失败以 rejected Promise 抛出，不用回调、不返回 `{ok:false}`。`toRecord()` 是例外——纯映射，同步返回。

同步返回的部分（本机实测 `typeof`）：`hook()` 返回取消函数、`unhook()` 返回 boolean、`hooks()` / `hookNames` / `wiredHooks`、`health()` / `info()` / `services()` / `require()`、`notice.push/show/since/snapshot/clear`（返回 record / 数组 / boolean）、`notice.store.ack()`（number）、`selfcheck.snapshot()` / `resetFailures()` / `statePath`、`scripts.files()`。

返回 Promise 的辅助方法：`fire()`、`sleep()`、`selfcheck.run()`、`scripts.load/reload/unload`、`notice.store.wait()`。

`fs.contains()` 是 async 函数，但内部的宿主调用是同步比较——见 4.9。

### 0.2 返回值是纯 JSON

宿主对象是带 getter 的类实例，不能直接跨边界。每个域都用 `lib/json.js` 把宿主实体转成普通对象：

| 规则 | 值 |
| --- | --- |
| 最大深度 | 12 层，超过转成字符串 `'[depth]'` |
| 最大数组/对象成员 | 5000，超出截断 |
| 循环引用 | `'[circular]'` |
| `bigint` | 十进制字符串 |
| `function` / `symbol` | `null` |
| `Date` | ISO 8601 字符串 |
| `Error` | `{name, message, code}` |
| `Map` | 普通对象 |
| `Set` | 数组 |
| 抛错的 getter | 当作字段不存在 |

所以拿到的记录可以安全 `JSON.stringify`、丢进公告、传回浏览器。

### 0.3 错误统一是 `ModapiError`

```js
import { ModapiError, ERROR_CODES } from 'dsh-modapi/errors';
```

```ts
class ModapiError extends Error {
  name: 'ModapiError';
  code: 'UNSUPPORTED' | 'BAD_ARGUMENT' | 'NOT_FOUND' | 'CONFLICT' | 'DENIED' | 'TIMEOUT' | 'INTERNAL';
  message: string;
  domain?: string;   // 'work' | 'session' | 'tool' | 'fs' | 'hook' | 'notice' | 'bridge' | 'modapi'
  method?: string;   // 出错的调用
  hint?: string;     // 下一步该做什么
  detail?: unknown;  // 宿主原始错误码等附加信息
  toJSON(): { name, code, message, domain, method, hint };
}
```

`toJSON()` 不含 `detail`，日志里打 `error.detail` 才能看到宿主原始码。

| code | 触发条件 |
| --- | --- |
| `UNSUPPORTED` | 宿主没有这个服务（`host service A \| B is not available on this DSH build`）；服务在但没有这个方法（`host method A \| B is missing`）；`modapi.require()` 要的服务不存在；工作区注册表既没有 `list()` 也没有 `get()` |
| `BAD_ARGUMENT` | 参数类型/长度不对；公告既无标题也无正文；`fs.write` 的 content 不是字符串；`fs.edit` 缺 `oldString`/`newString`；`tool.call` 既没 `signal` 也没正的 `timeoutMs`；桥的请求体不是合法 JSON 或超过 32 KB；桥的已知路径用了错的方法 |
| `NOT_FOUND` | `work.rename()` 的 id 不存在；`session.messages()` 的会话不存在；桥的路径不存在 |
| `CONFLICT` | 某个钩子的订阅者超过 `hookLimitPerName`；宿主报 `EEXIST` / `EBUSY` / `FS_STALE_VERSION` / `FS_NOT_OBSERVED` / `FS_NOT_REGULAR_FILE` / `FS_AMBIGUOUS_EDIT` |
| `DENIED` | 宿主权限或沙箱拒绝（`EACCES` / `EPERM` / `FS_PERMISSION_DENIED` / `FS_SANDBOX_DENIED`）；跨源请求；桥的宿主鉴权返回 403 |
| `TIMEOUT` | 宿主报 `ETIMEDOUT` / `EABORT` / `FS_ABORTED` |
| `INTERNAL` | 宿主返回的形状不对（该给数组没给数组、该给 target 没给 target）；未分类的异常；`FS_IO_ERROR`；桥的请求流错误 |

宿主错误码不会丢：落进 `detail`，同时按上表映射成上面的 code。`ENOENT` / `ENOTDIR` / `FS_NOT_FOUND` / `FS_EDIT_NOT_FOUND` 映射成 `NOT_FOUND`，`FS_NOT_TEXT` / `FS_NOT_DIRECTORY` / `FS_TOO_LARGE` 映射成 `BAD_ARGUMENT`。

### 0.4 `hint`

每条错误尽量带 `hint`。两种常见形态：

- 服务缺失：`Check ctx.modapi.services(); the host renamed or removed that service.`
- 方法缺失：`The host changed this method; update the matching file in lib/domains/.`

`hint` 是给人看的，不要拿去 `switch`。

### 0.5 版本字段的语义（三处不一样）

| 字段 | 值 | 含义 |
| --- | --- | --- |
| `api.version` | `'0.2.0'` | 包版本 |
| `api.apiVersion` | `'1'` | 接口契约版本：**跨版本升级只看这个** |
| `api.pluginVersion` | `'0.2.0'` | 包版本（`version` 的同义字段） |
| `api.info().version` / `api.info().apiVersion` | `'0.2.0'` / `'1'` | 与上面两个一致 |
| `selfcheck` 基线里的 `apiVersion` | `'1'` | 接口契约版本 |

判断「接口层是不是同一代」看 `apiVersion`；判断「装的哪个包」看 `version` / `pluginVersion`。

---

## 1. `modapi.work` — 工作区

宿主服务：`workspaceRegistry`（`work.services` 就是这个数组）。

### 1.1 记录结构

```ts
interface WorkspaceRecord {
  id: string;
  title: string;
  path: string;          // 原样，不归一化
  createdAt: string;     // ISO，缺失为 ''
  updatedAt: string;     // ISO，缺失为 ''
  sessionIds: string[];
}
```

字段来源有别名回退：`id | workspaceId | key`、`title | name | label`、`path | dir | directory | root | cwd`、`createdAt | created`、`updatedAt | updated`、`sessionIds | sessions`。取第一个非 `null` 的。

### 1.2 `work.list()` / `getlist()` / `getAll()`

```ts
list(): Promise<WorkspaceRecord[]>
```

宿主 `workspaceRegistry.list()` 必须返回数组，否则 `INTERNAL: workspaceRegistry.list() did not return an array`。

```js
await api.work.getlist();
// [{ id: 'w1', title: 'demo', path: 'D:/proj/a', createdAt: '…', updatedAt: '', sessionIds: ['s1'] }]
```

ModPE 风格别名 `getlist()` 是刻意留的：这套接口最早的调用方按 ModPE 的函数表写。

### 1.3 `work.get(id)` / `byId(id)`

```ts
get(id: string): Promise<WorkspaceRecord | null>
```

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 非空 |

- `id` 不是非空字符串 → `BAD_ARGUMENT: work.get(id) needs a workspace id`
- 宿主有 `get()` 就调它；没有就退化成 `list().find(item => item.id === id)`
- 找不到返回 `null`，不抛 `NOT_FOUND`

### 1.4 `work.find(path)` / `findByPath(path)`

```ts
findByPath(path: string): Promise<WorkspaceRecord | null>
```

比较前两边都归一化：反斜杠转 `/`、去掉尾部所有 `/`、转小写。所以 `'D:\\PROJ\\B\\'` 能命中 `path: 'D:/proj/b/'`。

空串或非字符串 → `BAD_ARGUMENT: work.findByPath(path) needs a path`。找不到返回 `null`。

### 1.5 `work.create(path, title)`

```ts
create(path: string, title?: string): Promise<WorkspaceRecord>
```

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `path` | string | 非空 |
| `title` | string? | 空串按 `undefined` 传给宿主，由宿主取默认标题 |

- `path` 不合法 → `BAD_ARGUMENT: work.create(path, title) needs a path`
- 宿主没有 `create()` → `UNSUPPORTED: host method create is missing`

### 1.6 `work.rename(id, title)`

```ts
rename(id: string, title: string): Promise<WorkspaceRecord>
```

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 要改的工作区 |
| `title` | string | 必须是字符串（空串允许） |

- `title` 不是字符串 → `BAD_ARGUMENT: work.rename(id, title) needs a title string`
- `id` 查不到 → `NOT_FOUND: no workspace with id "x"`
- 依赖宿主实体的 `setTitle()`，没有就 `UNSUPPORTED: host method setTitle is missing`
- 宿主 `setTitle()` 返回 `undefined` 时回落到改之前的实体快照

### 1.7 `work.remove(id)` / `delete(id)`

```ts
remove(id: string): Promise<boolean>
```

调宿主的 `delete()` 或 `remove()`，**只有宿主返回 `true` 才算成功**。返回 `false` 表示宿主没确认删除，不是「本来就没了」。

### 1.8 `work.move(id, beforeId)`

```ts
move(id: string, beforeId?: string): Promise<string[]>
```

调宿主的 `insertBefore()` 或 `move()`，第二个参数是 `beforeId`（非字符串时传 `undefined`，表示挪到末尾）。返回重排后的 id 数组；宿主没返回数组时返回 `[]`。

### 1.9 `work.forSession(sessionId)`

```ts
forSession(sessionId: string): Promise<WorkspaceRecord[]>
```

在 `list()` 里按 `sessionIds.includes(sessionId)` 过滤。非法参数 → `BAD_ARGUMENT: work.forSession(sessionId) needs a session id`。

### 1.10 `work.paths()` / `work.count()`

```ts
paths(): Promise<string[]>
count(): Promise<number>
```

都是 `list()` 的投影。

### 1.11 其它导出

| 名称 | 说明 |
| --- | --- |
| `work.toRecord(entity)` | 把宿主实体转成 `WorkspaceRecord`，不经过 `list()` |
| `work.services` | `['workspaceRegistry']` |

规范化函数在 `dsh-modapi` 内部（`normalizePath`），没有从入口导出。

---

## 2. `modapi.session` — 会话

宿主服务：`sessions` 或 `sessionStore`。

### 2.1 记录结构

```ts
interface SessionRecord {
  id: string;
  title: string;          // 最后一条 session/title 事件，其次 header.title
  cwd: string;
  createdAt: string;      // ISO
  parentSession: unknown; // 原样，通常 string | null
  agentPreset: unknown;
  isSeeded: boolean;
  origin: unknown;
  delegationDepth: number; // 非有限数时为 0
  events: number;          // 事件条数，不返回事件内容
}
```

`title` 的取值顺序：从 `log` / `events` 数组**从后往前**找第一条 `type === 'session/title'` 且 `title` 非空的事件；找不到才用 `session.title`，再不行用 `header.title`。所以会话被改过两次名，拿到的是最后一次。

### 2.2 `session.list()` / `all()`

```ts
list(): Promise<SessionRecord[]>
```

宿主方法可以是 `list()` 或 `all()`。非数组 → `INTERNAL: sessions.list() did not return an array`。

### 2.3 `session.get(id)` / `byId(id)`

```ts
get(id: string): Promise<SessionRecord | null>
```

- 非法参数 → `BAD_ARGUMENT: session.get(id) needs a session id`
- 宿主有 `get()` 用它；没有就 `list()` 里按 id 找
- 找不到返回 `null`

### 2.4 `session.current()`

```ts
current(): Promise<SessionRecord | null>
```

取插件加载时的 `DSH_SESSION_ID`，再去 `get()`。没有这个环境变量（比如跑在桌面主进程而不是某个会话里）返回 `null`。

### 2.5 `session.exists(id)`

```ts
exists(id: string): Promise<boolean>
```

`(await get(id)) !== null`。

### 2.6 `session.ids()`

```ts
ids(): Promise<string[]>
```

### 2.7 `session.messages(id, {limit})` / `deriveMessages()`

```ts
messages(id: string, options?: { limit?: number }): Promise<unknown[]>
```

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `id` | — | 会话 id |
| `limit` | `200` | `<= 0` 取全量；上限 `2000`；取**尾部** | 

- 会话不存在 → `NOT_FOUND: no session with id "x"`
- 依赖宿主实体的 `deriveMessages()`，没有就 `UNSUPPORTED: host method deriveMessages is missing`
- 返回非数组 → `INTERNAL: deriveMessages() did not return an array`
- 每条消息都过 `toJSONValue`

`slice(-limit)` 意味着拿到的是最近 N 条，不是最早 N 条。

### 2.8 `session.count(id)`

```ts
count(id: string): Promise<number>
```

等价 `messages(id, { limit: 0 }).length`——全量取来再数，大会话上不便宜。

### 2.9 `session.flush(id)`

```ts
flush(id: string): Promise<true>
```

把会话刷到磁盘。需要宿主 store 上有 `flush()`；能找到会话实体就传实体，否则传 id。

### 2.10 其它导出

| 名称 | 说明 |
| --- | --- |
| `session.toRecord(entity)` | 实体 → `SessionRecord` |
| `session.currentSessionId` | 插件加载时的 `DSH_SESSION_ID`，没有则为 `undefined` |
| `session.services` | `['sessions', 'sessionStore']` |

另有 `DEFAULT_MESSAGE_LIMIT = 200`、`MAX_MESSAGE_LIMIT = 2000`，未从入口导出。

---

## 3. `modapi.tool` — 工具

宿主服务：`tools`。

### 3.1 记录结构

```ts
interface ToolRecord {
  name: string;
  description: string;
  parameters: unknown;   // JSON Schema，已净化；缺失为 null
  deferred: boolean;     // schema.deferLoading === true
}
```

宿主没有 `list()`，只有每个 scope 一个 view 和 `schemas()`。两个来源都归一化成上面的形状。

### 3.2 `tool.list(scope)`

```ts
list(scope?: unknown): Promise<ToolRecord[]>
```

- 有 `view(scope)` 就调它，从返回里取 `visible`（`Map` 或数组都认）
- 没有 `view()` 就要求 `schemas(scope)` 返回数组，否则 `INTERNAL: tools.schemas() did not return an array`
- 名称为空串的条目被丢掉

`scope` 原样透传给宿主，接口层不解释它的含义。

### 3.3 `tool.schemas(scope)`

`list(scope)` 的别名。

### 3.4 `tool.names(scope)` / `tool.count(scope)`

```ts
names(scope?): Promise<string[]>
count(scope?): Promise<number>
```

### 3.5 `tool.get(name, scope)` / `has(name, scope)`

```ts
get(name: string, scope?): Promise<ToolRecord | null>
has(name: string, scope?): Promise<boolean>
```

- 非法参数 → `BAD_ARGUMENT: tool.get(name) needs a tool name`
- 宿主有 `get()` 先问它，拿不到再在 `list()` 里找
- 找不到返回 `null` / `false`

### 3.6 `tool.call(name, args, {agent, signal, timeoutMs, callId})` / `run()`

```ts
call(name: string, args?: object, options?: {
  agent?: unknown;
  signal?: AbortSignal;
  timeoutMs?: number;
  callId?: string;
}): Promise<{ name: string; ok: boolean; scoped: boolean; content: unknown; result: unknown }>
```

| 选项 | 说明 |
| --- | --- |
| `agent` | **省了会绕过 agent 级 guard / approval**。给了就原样透传给宿主 `execute()` |
| `signal` | 取消信号 |
| `timeoutMs` | 没给 `signal` 时自建 `AbortController`，到点 abort；调用结束（成功或失败）都会 abort 掉控制器 |
| `callId` | 不给就 `randomUUID()` |

错误：

- 名称不合法 → `BAD_ARGUMENT: tool.call(name, args) needs a tool name`
- 既没 `signal` 也没正的 `timeoutMs` → `BAD_ARGUMENT: tool.call() needs a signal or a positive timeoutMs`（接口层不替你决定超时，避免跑到一半没人管）
- 宿主没有 `execute()` → `UNSUPPORTED: host method execute is missing`

返回值：

| 字段 | 含义 |
| --- | --- |
| `name` | 工具名 |
| `ok` | 宿主结果里 `ok` 或 `success` 为 `true`；宿主没给这两个字段时，返回了非 `undefined` 就算成功 |
| `scoped` | **是否带了 `agent`**。`false` 表示这次调用发生在 agent 作用域之外，guard/approval 被宿主跳过 |
| `content` | 宿主结果的 `content` / `output` / `value`，落空为 `null` |
| `result` | 宿主原始返回值净化后的副本 |

```js
const r = await api.tool.call('read', { path: 'README.md' }, { signal, agent });
if (!r.scoped) ctx.logger.warn('tool ran outside the agent scope');
```

订阅 `toolcall` / `toolresult` 钩子能看到宿主层的同一个 `exec` 对象，但那是事件流，不是 `call()` 的返回值。

### 3.7 其它导出

| 名称 | 说明 |
| --- | --- |
| `tool.toRecord(entry)` | 同步。把宿主工具条目映射成 `{name, description, parameters, deferred}` |
| `tool.services` | `['tools']` |

---

## 4. `modapi.fs` — 文件

宿主服务：`fs` 或 `filesystem`。

路径参数统一接受两种形态：

- 字符串路径
- 宿主 target 对象 `{ targetKey: string }`（从 `fs.resolve()` 或 `fs.list()` 的 `path` 之外拿到的对象）

两种都不满足 → `BAD_ARGUMENT: a path string or a host target is required`。

### 4.1 `fs.resolve(path, {cwd})` / `targetOf()`

```ts
resolve(path: string | target, options?: { cwd?: string }): Promise<{ targetKey: string; displayPath: string }>
```

- 宿主 `resolve()` 没返回对象 → `INTERNAL: fs.resolve() did not return a target`
- 字段缺失时是空串，不是 `undefined`

### 4.2 `fs.stat(path, {signal})`

```ts
stat(path, options?: { signal?, cwd? }): Promise<{ type: string; size: number; version: string } | null>
```

- 路径不存在返回 **`null`**，不抛 `NOT_FOUND`
- `size` 非有限数时为 `0`，`version` 非字符串时为 `''`
- `type` 原样透传宿主的字符串（`file` / `directory` / …）

### 4.3 `fs.exists(path, {signal})`

```ts
exists(path, options?): Promise<boolean>
```

`stat()` 非 `null` 即 `true`。`DENIED` 和 `NOT_FOUND` 都吞成 `false`——**没有权限和不存在在这里不可区分**；其它错误照抛。

### 4.4 `fs.read(path, {signal})` / `readText()`

```ts
read(path, options?): Promise<string>
```

宿主 `readText()` 返回非字符串时得到 `''`。

### 4.5 `fs.readBytes(path, {maxBytes, signal})`

```ts
readBytes(path, options?: { maxBytes?: number; signal?: AbortSignal }): Promise<{ base64: string; size: number }>
```

| 参数 | 默认 | 范围 |
| --- | --- | --- |
| `maxBytes` | 4 MiB | 钳在 1 B – 16 MiB |

返回 **base64**，不是 Buffer；`size` 是解码后的字节数。文本文件用 `read()`，二进制才用这个。

```js
const { base64, size } = await api.fs.readBytes('logo.png');
```

### 4.6 `fs.list(path, {signal})` / `listDir()`

```ts
list(path, options?): Promise<Array<{ name: string; type: string; path: string; size?: number; version?: string }>>
```

- 按 `name` 的 `localeCompare` 升序
- `path` 优先取宿主条目的 `target.displayPath`，其次 `entry.path`
- 非数组 → `INTERNAL: listDir() did not return an array`

### 4.7 `fs.write(path, content, {create, version, expected, signal})` / `writeText()`

```ts
write(path, content: string, options?: {
  create?: boolean;
  version?: string;
  expected?: unknown;
  signal?: AbortSignal;
  cwd?: string;
}): Promise<{ path: string; operation: string; version?: string; before?: string; after?: string }>
```

`content` 不是字符串 → `BAD_ARGUMENT: fs.write(path, content) needs a string`。

版本守卫按这个优先级组装（只取第一个命中的）：

| 优先级 | 传入 | 传给宿主 |
| --- | --- | --- |
| 1 | `expected`（非 `undefined`/`null`） | 原样 |
| 2 | `create: true` | `{ kind: 'createIfAbsent' }` |
| 3 | `version`（非空字符串） | `{ kind: 'replaceIfVersion', version }` |
| 4 | 都没给 | `undefined`——不设守卫，直接覆盖 |

于是：

```js
await api.fs.write('a.txt', 'hi', { create: true });          // 不存在才建，已存在 → CONFLICT
await api.fs.write('a.txt', 'hi', { version: 'v1' });          // 版本没变才写，变了 → CONFLICT
const { version } = await api.fs.stat('a.txt');                // 想读-改-写就连起来用
```

`operation` 由宿主决定（常见是 `create` / `update`），接口层原样透传，没在真实宿主上验证过取值集合。

`before` / `after` 是宿主返回的旧/新内容，宿主不给就没有这两个字段。

### 4.8 `fs.edit(path, {oldString, newString, replaceAll}, options)`

```ts
edit(path, change: { oldString: string; newString: string; replaceAll?: boolean }, options?): Promise<WriteResult>
```

- 两个字符串缺任一 → `BAD_ARGUMENT: fs.edit(path, { oldString, newString }) needs both strings`
- `replaceAll` 只认 `=== true`，其它值一律当 `false`
- `change` 不是对象时按 `{}` 处理，于是必然触发上面那条错误
- 第三参 `options` 和 `write()` 一样（`create` / `version` / `expected` / `signal` / `cwd`）
- 依赖宿主 `editText()`

匹配失败、匹配到多处但没开 `replaceAll` 之类的情况由宿主抛，接口层映射成 `CONFLICT`（`FS_AMBIGUOUS_EDIT` / `FS_EDIT_NOT_FOUND`）。

### 4.9 `fs.fileUrl(path)`

```ts
fileUrl(path): Promise<string>
```

宿主 `fileUrl()` 的结果转字符串，缺失为 `''`。给 `<img src>` 用。

### 4.10 `fs.contains(parent, child, {cwd})`

```ts
contains(parent, child, options?): Promise<boolean>
```

判断 `child` 是否在 `parent` 之下。要求宿主的 `fs`/`filesystem` 服务自己带 `contains` 方法，没有就是 `UNSUPPORTED`。

实现是 `check(from, to) === true`——**同步**比较宿主返回值。宿主若返回 Promise，这个表达式恒为 `false`，不会 await。见 11.2。

### 4.11 其它导出

| 名称 | 说明 |
| --- | --- |
| `fs.services` | `['fs', 'filesystem']` |

`DEFAULT_READ_BYTES = 4 MiB`、`MAX_READ_BYTES = 16 MiB` 未从入口导出。

---

## 5. 钩子

11 个保留名，8 个接在宿主真实事件上。

```js
api.hookNames;   // 11 个名字，顺序固定
api.wiredHooks;  // 其中 8 个已接线的
```

### 5.1 名字表

| 名字 | 已接线 | 触发点 | payload |
| --- | --- | --- | --- |
| `checkstart` | ✅ | 启动完成：脚本加载、等宿主就绪、自检之后 | `{ api, info, selfcheck, ready }` |
| `checkstop` | ✅ | 卸载/停用，清理之前 | `{ api, info }` |
| `onerror` | ✅ | 任一钩子订阅者抛错 | `{ error, hook, source }` |
| `sessioncreate` | ✅ | 宿主 `session/created` | `{ session }` |
| `sessiondelete` | ✅ | 宿主 `session/disposed` | `{ session }` |
| `sessionarchive` | ⬜ | 保留名，只能 `fire()` | — |
| `messagereceive` | ✅ | 宿主 `session/event` | `{ session, event }` |
| `toolcall` | ✅ | 宿主 `tools/pre-execute`；钩子跑完才放行 | `{ exec }` |
| `toolresult` | ✅ | 宿主 `tools/result` | `{ exec, result }` |
| `pluginload` | ⬜ | 保留名，只能 `fire()` | — |
| `pluginunload` | ⬜ | 保留名，只能 `fire()` | — |

`wiredHooks` 里的 8 个：`checkstart`、`checkstop`、`onerror`、`sessioncreate`、`sessiondelete`、`messagereceive`、`toolcall`、`toolresult`。

三个保留名是给别的插件预留的约定点：`dsh-modapi` 不接宿主事件，但接受 `hook()` 订阅、接受 `fire()` 手动触发，`hooks()` 里也列得出来。

### 5.2 `hook(name, handler, {source, order})`

```ts
hook(name: string, handler: (payload) => unknown, options?: {
  source?: string;   // 默认 'plugin'
  order?: number;    // 默认 0，小的先跑
}): () => boolean
```

返回取消函数（调用即 `unhook`）。

- `name` 非非空字符串 → `BAD_ARGUMENT: hook(name, handler) needs a hook name`
- `handler` 不是函数 → `BAD_ARGUMENT: hook "x" needs a function`
- 该名字订阅者已达 `hookLimitPerName` → `CONFLICT: hook "x" already has N subscribers (limit L)`，`hint: Raise hookLimitPerName in the plugin config.`
- 同一名字内按 `(order, 注册序号)` 排序，**先注册的先跑**（同 order 时）

`source` 只是标签，用于 `removeBySource()`（脚本卸载时按它清订阅）。不传就是 `'plugin'`。

### 5.3 `unhook(name, handler)`

```ts
unhook(name: string, handler: Function): boolean
```

按函数引用移除，移除成功返回 `true`。找不到或名字没注册过返回 `false`。

### 5.4 `fire(name, payload)`

```ts
fire(name: string, payload?: unknown): Promise<{
  hook: string;
  fired: number;      // 实际调用的订阅者数
  failed: number;     // 抛错的个数
  results: unknown[]; // 每个订阅者的返回值；抛错的那位是 undefined
}>
```

单个订阅者抛错**不阻断**其他人：错误转给 `onerror`，`failed` 加一，继续跑下一个。`onerror` 自己抛错只记 warn，不会递归。

未接线的名字也能 `fire()`，这是三个保留名的唯一用法。

```js
const r = await api.fire('sessionarchive', { sessionId: 's1' });
// { hook: 'sessionarchive', fired: 0, failed: 0, results: [] }
```

### 5.5 `hooks()`

```ts
hooks(): Array<{ name: string; count: number; wired: boolean; sources: string[] }>
```

覆盖 11 个保留名 + 任何额外注册过的名字（额外名 `wired: false`）。`sources` 去重。

### 5.6 脚本里自动注册

脚本文件顶层函数名等于钩子名，就自动注册，不用写 `modapi.hook()`：

```js
function checkstart() { 公告('已启动').show() }
function toolcall({ exec }) { log('before', exec?.name) }
```

加载器在每个脚本末尾追加：

```js
if (typeof checkstart === 'function') modapi.hook('checkstart', checkstart, { source: 'script:<绝对路径>' });
// …11 个名字每个都来一遍
```

所以：

- 只认**顶层**函数；`const fn = () => {}` 不注册
- 脚本重载时先按 `source` 清掉旧订阅，不会叠两遍
- 想给同一个钩子挂多个函数，还是手写 `modapi.hook()`（自动注册只按名字来一次）

---

## 6. 公告

公告是「入队 + 浏览器拉取」：`show()` 只写内存队列，Web 客户端轮询 HTTP 桥取走再渲染。

### 6.1 三个入口名

```js
api.notice;    // 同一个工厂
api.公告;       // 同一个工厂
api.toast;     // 同一个工厂
api.Toast;     // 工厂上的 Toast 类
api.noticeLevels; // ['info', 'success', 'warn', 'error']
```

`notice` / `公告` / `toast` 三者 `===`，只是给不同的书写习惯留的入口。

### 6.2 记录结构

```ts
interface NoticeRecord {
  id: string;        // 'notice-1'，单调递增，不是 seq
  seq: number;       // 从 1 开始的序号，轮询游标用它
  level: 'info' | 'success' | 'warn' | 'error';
  title: string;     // 可为 ''
  body: string;      // 可为 ''
  kind: string;      // 默认 'modapi.notice'
  duration: number;  // 毫秒；0 = 不自动消失
  at: number;        // 毫秒时间戳（不是 ISO 字符串）
}
```

### 6.3 `Toast` 的三种构造形态

```js
公告('正文')                                       // title '', body '正文'
公告('标题', '正文')                                // 两个都给
公告('标题', '正文', { level: 'success', duration: 3000 })
公告({ title: '标题', body: '正文', level: 'warn' }) // 对象形态
```

| 形态 | title | body | 其余选项 |
| --- | --- | --- | --- |
| `('正文')` | `''` | `'正文'` | 第二参给对象时当选项 |
| `('标题', '正文', opts)` | 第一参 | 第二参 | `opts` |
| `({title, body, …})` | 对象里的 `title` | 对象里的 `body` | 对象本身 |

选项里的 `level` 不合法回落 `'info'`；`duration` 非正数或非有限数按 `0`；`kind` 空串按 `'modapi.notice'`。

`title` 与 `body` 都为空（trim 后）→ `BAD_ARGUMENT: a notice needs a title or a body`，在 `show()` / `push()` 时抛出。

### 6.4 Toast 实例

```js
const t = 公告('标题', '正文', { level: 'success' });
t.show();          // 入队，返回记录副本
t.show({ body });  // 已入队 → 原地更新同一条（id、seq 不变）
t.set({ level });  // 只改本地选项；已入队时同步更新队列里的那条
t.title();         // 读
t.title('新');      // 写，返回 this
t.body('新');
t.close();         // 从队列移除，返回是否真的移除了
t.id;              // 未 show 时为 null
t.toJSON();        // {...options, id}
```

`show()` 的第二次及以后不产生新公告，只更新——所以同一个 Toast 反复 `show()` 不会刷屏，是「改写同一行」。

### 6.5 `notice.show(a, b, c)`

```ts
show(a?, b?, c?): NoticeRecord
```

一步到位：内部 `new Toast(...).show(...)`，返回记录。参数同上三形态。

### 6.6 `notice.push(input)`

```ts
push(input: string | { title?, body?, text?, message?, level?, duration?, kind? }): NoticeRecord
```

`text` / `message` 当 `body` 的别名。这是「不构造 Toast、直接入队」的入口，仍然要过标题/正文非空校验。

### 6.7 `notice.since(seq)` / `notice.snapshot()`

```ts
since(after?: number): NoticeRecord[]           // seq > after 的副本
snapshot(): { seq: number; size: number; items: NoticeRecord[] }
```

`after` 非有限数按 `0`（≡ 全量）。

### 6.8 `notice.store.wait(seq, waitMs)` — 长轮询

```ts
notice.store.wait(after: number, waitMs: number): Promise<NoticeRecord[]>
```

注意它在 `store` 上，不在工厂上（工厂只挂了 `show/push/since/clear/snapshot/store/levels/Toast/toast`）。

- 已有 `seq > after` 的公告 → 立刻返回
- 否则挂起到有新公告、超时、或 store 关闭
- `waitMs` 钳在 `0..60000`；`0` 或不给 → 立刻返回 `[]`
- 有新公告时通过 `wake()` 唤醒所有等待者，各自只拿自己游标之后的部分

浏览器那半边就是用 `wait` 做长轮询（客户端固定 25000 ms）。

### 6.9 `notice.store.ack(ids)`

```ts
notice.store.ack(ids: string[]): number   // 实际移除了几条，同步返回
```

非数组或空数组返回 `0`。非字符串元素被忽略。

### 6.10 `notice.clear()`

清空队列，返回 `true`。

### 6.11 队列上限与过期

| 配置 | 默认 | 行为 |
| --- | --- | --- |
| `noticeTtlMs` | 600000 | 入队时就丢弃比 `now - ttl` 更早的条目 |
| `noticeLimit` | 64 | 超过上限时丢最旧的，保留最后 N 条 |

两个都只在**入队时**裁剪，不额外起定时器。

---

## 7. 自检与健康

### 7.1 基线文件

`selfcheck.statePath` 是**字符串属性**（不是方法），默认：

```
<DSH_HOME>/modapi/state/contract.json
```

`DSH_HOME` 取环境变量，否则 `~/.dsh`；都没有时退回 `process.cwd()`。

内容：

```json
{
  "schemaVersion": 1,
  "apiVersion": "1",
  "host": "0.6.3",
  "at": "2026-11-08T11:20:00.000Z",
  "capabilities": {
    "work.list": "ok",
    "work.create": "ok",
    "session.list": "ok",
    "session.get": "ok",
    "tool.list": "ok",
    "fs.resolve": "ok",
    "fs.read": "ok",
    "fs.write": "ok",
    "fs.list": "ok",
    "notice.bridge": "ok"
  }
}
```

写入是原子的：先写 `.tmp` 再 rename。`schemaVersion` 不是 `1` 的文件直接当不存在。

### 7.2 `selfcheck.run({deep, notify, updateBaseline})`

```ts
run(options?: { deep?: boolean; notify?: boolean; updateBaseline?: boolean }): Promise<{
  ok: boolean;
  checked: number;
  missing: Array<{ id: string; label: string; reason: string }>;
  regressed: Array<{ id: string; label: string; reason: string }>;
  statePath: string;
  at: string;
}>
```

| 选项 | 默认 | 说明 |
| --- | --- | --- |
| `deep` | `true` | 除服务外还检查方法是否存在 |
| `notify` | `true` | 有回归时弹 `error` 公告；`false` 只记日志 |
| `updateBaseline` | `true` | 全部通过时写基线 |

- **只有 `missing` 为空才写基线**。缺一个就不写，免得把残缺状态固化成基线。
- `regressed` = 这次缺失 ∩ 上次基线里标 `ok` 的项——只有「曾经好过、现在坏了」才叫回归。
- 有回归且 `notify` 不是 `false`：弹一条 `kind: 'modapi.selfcheck'`、`duration: 0`、标题「modapi：接口失效（DSH 升级后）」的 error 公告，正文是 `DSH <旧> → <新>\n<逐项详情>`。
- 没有回归但有缺失：只 warn 一行。

10 项能力与对应宿主服务：

| id | 标签 | 检查的服务 | 检查的方法 |
| --- | --- | --- | --- |
| `work.list` | 工作区列表 | `workspaceRegistry` | `list` |
| `work.create` | 新建工作区 | `workspaceRegistry` | `create` |
| `session.list` | 会话列表 | `sessions \| sessionStore` | `list` |
| `session.get` | 读取会话 | `sessions \| sessionStore` | `get` |
| `tool.list` | 工具清单 | `tools` | `view \| schemas` |
| `fs.resolve` | 路径解析 | `fs \| filesystem` | `resolve` |
| `fs.read` | 读取文件 | `fs \| filesystem` | `readText` |
| `fs.write` | 写入文件 | `fs \| filesystem` | `writeText` |
| `fs.list` | 目录列表 | `fs \| filesystem` | `listDir` |
| `notice.bridge` | 公告 HTTP 桥 | `webServer` | `register` |

`notice.bridge` 走的是桥自己的探针，不是服务表：挂上了算 ok，还在等 webServer 算 ok（带 `pending: true`），失败或已销毁算缺。

### 7.3 `selfcheck.snapshot()`

```ts
snapshot(): {
  last: Report | null;                     // 最近一次 run()
  failures: Array<{ key, count, firstAt, lastAt, message }>;
  baseline: Baseline | null;               // 磁盘上的基线
}
```

`failures` 是 `UNSUPPORTED` 的调用计数，按 `domain.method` 聚合。第一次命中会弹 `kind: 'modapi.failure'` 的 error 公告「modapi：接口不可用」，之后只累加计数、更新 `lastAt`。

### 7.4 `selfcheck.resetFailures()`

清空 `failures` 表（不动基线、不动 `last`）。

### 7.5 `health()`

```ts
health(): {
  ok: boolean | null;      // 最近一次自检；还没跑过是 null
  started: boolean;
  apiVersion: '1';
  hostVersion: string;
  services: { work, session, tool, fs, webServer, appReady, connection }; // 7 个布尔
  hooks: number;           // 已注册钩子名的个数
  notices: number;         // 队列里的公告数
  scripts: number;         // 已加载脚本数
  missing: string[];       // 最近一次自检缺失的能力 id
}
```

`services` 里 `true` 只代表服务对象拿到了，不代表方法齐全——方法要 `selfcheck.run({deep:true})` 才知道。

### 7.6 `info()`

```ts
info(): {
  name: 'dsh-modapi';
  version: string;          // 包版本
  apiVersion: '1';
  hostVersion: string;
  dshHome: string | null;
  startedAt: string | null; // ISO
  uptimeMs: number;
  hooks: Array<{ name, count, wired, sources }>;
  notices: number;
  scripts: ScriptRecord[];
  selfcheck: { last, failures, baseline };
}
```

### 7.7 `services()` / `require(name)`

```ts
services(): { work, session, tool, fs, webServer, appReady, connection }  // 同 health().services
require(name: string): unknown   // 宿主服务本体，同步
```

`require()` 拿不到就是 `UNSUPPORTED: host service <name> is not available on this DSH build`，`hint: pass a host service name such as "workspaceRegistry"`。它只适合插件启动时**明确知道自己依赖什么**的场景；不确定就用 `services()` 探。

注意它返回的是宿主服务原对象——过了这道门就没有类型净化和错误映射了。

### 7.8 `log` / `sleep`

```js
api.log.debug(...args);
api.log.info(...args);
api.log.warn(...args);
api.log.error(...args);

await api.sleep(ms);        // 等价 api.utils.sleep(ms)
```

`log` 转发到插件的 logger（即 `[dsh-modapi]` 前缀那条通道）；没有 logger 时退化到 `console`，`debug` 直接丢弃。日志自身抛错被吞掉，不会变成 API 失败。

`sleep(ms)` 对负数按 0 处理。

---

## 8. 脚本

`$DSH_HOME/modapi/scripts/` 里的所有 `*.js` 在启动时按路径排序加载，再追加配置里的 `scriptDirs` 和 `scripts`。

### 8.1 目录与优先级

1. `<DSH_HOME>/modapi/scripts/*.js`（默认目录，路径排序）
2. 配置 `scriptDirs` 里每个目录的 `*.js`（相对路径按 `process.cwd()` 解析）
3. 配置 `scripts` 里列出的单个文件

重复路径只算一次。`$DSH_HOME` 取 `DSH_HOME` 环境变量，否则 `~/.dsh`。

### 8.2 沙箱全局变量

| 名字 | 类型 | 说明 |
| --- | --- | --- |
| `modapi` | object | 完整 API |
| `work` `session` `tool` `fs` | object | 四个域，等同 `modapi.work` 等 |
| `notice` `toast` `公告` | function | 公告工厂 |
| `log` | function | 等同 `modapi.log.info` |
| `sleep` | function | `Promise` 版延时 |
| `setTimeout` `clearTimeout` `setInterval` `clearInterval` | function | 来自宿主 |
| `__filename` `__dirname` | string | 该脚本的绝对路径 |
| `__source` | string | 钩子 `source` 标签，`script:<绝对路径>` |
| `console` | object | `log`/`info`/`warn`/`error`/`debug` 都转发到 logger |

**没有** `require`、`module`、`exports`、`process`。要用别的模块，从 `modapi` 上拿，或让主插件提供。

沙箱是 `node:vm` 的上下文，**不是安全边界**：脚本以宿主进程的权限运行，能拿到 `modapi.require()` 返回的真服务对象。只加载你信任的脚本。

### 8.3 包装方式与超时

每个文件被包成：

```js
(async () => {
  /* 你的代码 */
  ;
  /* 11 个 if (typeof NAME === 'function') modapi.hook(...) */
})()
```

`runInContext({ timeout: 15000 })`。**15 秒只约束同步执行段**：脚本顶层 `await` 之后的代码不受这个 timeout 管，死循环写在 `async` 里不会被打断。要限时自己套 `Promise.race`。

### 8.4 失败隔离

单个脚本：

- 读不出来 → warn `cannot read script <path>: …`，跳过
- 编译失败 → warn `cannot compile script <path>: …`，跳过
- 运行时抛错 → 先按 `source` 清掉它已注册的钩子，warn `script <path> failed: …`，跳过

其它脚本照常加载，一个坏文件不会带崩整批。

### 8.5 加载记录

```ts
interface ScriptRecord {
  file: string;     // 绝对路径
  name: string;     // 文件名
  source: string;   // 'script:<绝对路径>'
  hooks: string[];  // 这个文件实际注册上的钩子名
  size: number;     // 源文件字节数
  at: string;       // ISO 加载时间
}
```

`modapi.scripts.files()` 返回这份列表（副本）。

### 8.6 热重载

| 配置 | 行为 |
| --- | --- |
| `watchScripts: true` | 对每个脚本目录起 `fs.watch`，`*.js` 变化后 200ms 去抖，自动 `reload` |

`watch()` 可以手动调，返回当前 watcher 数；重复调用不会叠 watcher。

`reload(file)` 先按 `source` 清掉旧订阅再重新加载，返回新的 `ScriptRecord`（失败为 `null`）。`unload(file)` 清订阅并移出记录，返回是否真的移除过。

### 8.7 `scripts.load()` 的现状

`modapi.scripts.load()` 在当前实现里**会抛** `TypeError: files is not a function`：`lib/scripts.js` 里 `const files = discoverScripts(...)` 遮蔽了同名的 `function files()`，最后一行的 `return files()` 实际是在调数组。

插件启动路径用 try/catch 包住了它，所以：

- 脚本**已经加载**、钩子**已经注册**、watch 已经开
- 插件只 log 一行 warn `script load failed: files is not a function`
- 拿不到返回的 `ScriptRecord[]`；要列表就调 `modapi.scripts.files()`

直接 `await modapi.scripts.load()` 会 reject。见 11.1。

---

## 9. HTTP 桥

浏览器那半边（`dsh-modapi/client`）靠它拿公告。挂在 `webServer` 上，前缀 `/modapi/api`。

### 9.1 端点

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| `GET` | `/modapi/api/info` | 返回 `modapi.info()` |
| `GET` | `/modapi/api/notices?after=<seq>&wait=<ms>` | 长轮询取公告 |
| `POST` | `/modapi/api/notices/ack` | `{ ids: string[] }` 确认已展示 |
| `POST` | `/modapi/api/selfcheck` | 跑一次自检（`deep: true, notify: false`） |

`/selfcheck` 是第四个端点，不在最初的接口约定里，但代码里挂着。

`after` 缺省或非数字按 `0`；`wait` 缺省按 `0`（不等待）。`wait` 上限 60000。

### 9.2 信封

成功：

```json
{ "ok": true, "value": { … } }
```

失败：

```json
{ "ok": false, "error": { "code": "NOT_FOUND", "message": "no route for /x" } }
```

`/notices` 的 `value` 是 `{ notices: NoticeRecord[], seq: number }`，`seq` 是本批里最大的序号（空批时等于请求的 `after`），拿它当下一次游标。

### 9.3 状态码

| 状态 | 场景 |
| --- | --- |
| 200 | 正常 |
| 400 | `BAD_ARGUMENT`：请求体不是合法 JSON、超过 32 KB |
| 401 | 宿主鉴权要求登录（`UNAUTHORIZED`） |
| 403 | 宿主拒绝（`DENIED`）或跨源 |
| 404 | 路由不存在（`NOT_FOUND`） |
| 405 | 已知路径用了错的方法，`BAD_ARGUMENT: POST is not allowed on /info` |
| 500 | 其它 |

响应头固定 `content-type: application/json; charset=utf-8`、`cache-control: no-store`、`content-length`。

### 9.4 鉴权与同源

两条独立的门，按顺序：

1. **宿主鉴权**：宿主 `connection` 服务上有 `requestRejection(request)` 就调用它，返回 `401` 或 `403` 时直接拒绝。宿主没这个方法就不设防（本地桌面环境常见）。
2. **同源检查**：请求带 `Origin` 头时，要求 `new URL(origin).host === request.headers.host`。没带 `Origin`（curl、同进程调用）放行；带了但没 `Host`、或 `Origin` 解析不出来，一律 `403 DENIED: cross-origin request refused`。

跨源请求在读 body 之前就被拒。

### 9.5 请求体上限

`MAX_BODY_BYTES = 32768`。超了立刻 reject 并销毁请求，回 `BAD_ARGUMENT: request body exceeds 32768 bytes`。

### 9.6 挂载状态

```js
// registerBridge 的返回（内部用，不在公开 API 上）
{ prefix, handler, installed(), failure(), dispose() }
```

- `installed()`：`webServer.register({ kind: 'prefix', path, handler })` 成功过
- `failure()`：还在等 webServer 或已挂上时是 `null`；失败是 `failed: <原因>`；已经 dispose 是 `disposed`
- 这个状态喂给自检的 `notice.bridge` 项，所以 `health().missing` 里出现 `notice.bridge` 就是桥没挂上

---

## 10. 版本兼容策略

`API_VERSION = '1'`。接口版本只在**破坏性变更**时加：删方法、改参数含义、改返回形状。

DSH 升级后的处置顺序：

1. 重启，看 `await modapi.health()`：
   - `ok: true` → 基线已更新，接口全在
   - `ok: false` → 看 `missing`
2. `missing` 里有条目 → 读 `selfcheck.snapshot().last.missing[].reason`：
   - `service missing: X` → 宿主把服务改名或删了。改 `PROBE_SERVICES`（`lib/modapi.js`）与对应域里的 `*_SERVICES` 常量。
   - `method missing: X` → 服务在、方法变了。改 `lib/domains/` 里对应文件的 `requireMethod(..., ['旧名','新名'], ...)` 别名列表。
   - `bridge not mounted: …` → `webServer.register` 的签名变了，看 `lib/bridge.js`。
3. 改完再跑 `selfcheck.run()`，`missing` 空了基线自动重写。
4. 确认新基线里 `host` 已经是新版本号，提交。

只看 `missing` 不看 `reason`，等于知道坏了不知道坏在哪。

`api.apiVersion` 没变就不要动调用方代码；变了才需要迁移，且 `dsh-modapi` 应当同时提供一个兼容层，而不是让所有插件一起改。

---

## 11. 已知偏差与未验证项

以下按「代码现状」记，不是建议。带 ✅ 的是本机实测复现过的。核对时间 2026-11-08 19:33（Windows / Node 24），对应 `lib/` 最后修改 19:27 的源码。

### 11.1 `scripts.load()` 必抛 `TypeError` ✅

见 8.7。`lib/scripts.js` 的 `load()` 里 `const files` 遮蔽了 `function files()`。启动路径吞掉了它，直接调用会 reject。

### 11.2 `fs.contains()` 恒为 `false`（宿主返回 Promise 时）✅

```js
return check(from, to) === true;   // 没有 await
```

宿主若把这个方法实现成 async，表达式永远是 `false`。实测已复现。要判断包含关系，现阶段用 `fs.resolve()` 拿 `displayPath` 自己比。

### 11.3 `package.json` 的 `test` 脚本指向不存在的文件 ✅

`"test": "node test/all.js"`，仓库里没有 `test/all.js`，所以 `npm test` 报 `Error: Cannot find module '…\test\all.js'`；`node --test test/` 也一样起不来（`Cannot find module '…\test'`）。按文件跑没问题：`node --test test/*.test.js`，本机 19:31 跑出 167 个用例全过（`test/` 下有 work / session / tool / fs / hooks / notices / bridge / compat / errors / json 十个 `*.test.js`）。

### 11.4 `operation` 的取值集合未验证

`fs.write()` / `fs.edit()` 返回的 `operation` 是宿主原样透传的字符串。源码注释里没列可能值，桩宿主上测不出来，真实宿主上通常是 `create` / `update` 之类——**未验证**。

### 11.5 五个宿主事件的 payload 未在真实宿主上验证

`sessioncreate` / `sessiondelete` / `messagereceive` / `toolcall` / `toolresult` 的 payload 字段名来自 `lib/modapi.js` 里的事件转发代码（`{session}`、`{session, event}`、`{exec}`、`{exec, result}`），桩测试只验证了转发发生、payload 原样传递。真实宿主的 `session` / `exec` / `event` 对象上到底有哪些字段，**未验证**——写处理函数时先 `log(JSON.stringify(Object.keys(payload)))` 看一眼。

`tools/pre-execute` 的处理函数会等所有 `toolcall` 订阅者跑完才调用 `next()`，所以钩子是**串行**的：慢钩子会拖慢每一次工具调用。

### 11.6 浏览器半边未在真实 GUI 里验证

`lib/client.js` 的槽位注册（`shell.overlay`，注册名 `modapi-notices`，order 200）、右下角渲染、`duration` 到点自动消失、ack 回传，都是读源码得出的行为，**未在运行中的 Web GUI 里肉眼验证**。

### 11.7 桥的宿主鉴权路径未在真实宿主上验证

`connection.requestRejection` 返回 `401`/`403` 的分支用桩对象测过，真实 DSH 的 `connection` 服务上这个方法是否存在、入参形态、返回码约定，**未验证**。

### 11.8 `work.rename()` 的回落

宿主 `setTitle()` 返回 `undefined` 时，接口层返回改之前的实体快照——此时返回的 `title` 是**旧值**。宿主正常返回新实体时才是新值。这一点在桩宿主上按代码路径可推，**未在真实宿主上验证**。

## 12. mod 装载与调用架构（对齐 Fabric API）

> 本章接口自 `0.2.0` 起提供，`apiVersion` 仍为 `1`（纯增量，不破坏既有调用）。对应源码：`lib/events.js`、`lib/registry.js`、`lib/modules.js`、`lib/manifest.js`、`lib/semver.js`。

### 12.1 `modapi.events` — 事件

| 方法 | 返回 | 说明 |
| --- | --- | --- |
| `create(name, { combiner, replace, limit })` | `Event` | 建事件；重名抛 `CONFLICT`，`replace: true` 可替换 |
| `get(name)` | `Event \| undefined` | |
| `has(name)` | `boolean` | |
| `names()` | `string[]` | |
| `remove(name)` | `boolean` | 删除事件并丢弃其全部监听器 |
| `on(name, listener, { order, source })` | `disposer` | 事件不存在时自动创建 |
| `fire(name, ...args)` | `Promise<unknown>` | 未知名返回 `undefined`，不抛 |
| `describe()` | `{ name, size }[]` | |

`Event` 对象：

| 成员 | 说明 |
| --- | --- |
| `name` / `combiner` / `size` | 只读信息 |
| `register(listener, { order, source })` | 返回 disposer（也带 `.dispose()`，重复调用安全）；超过上限抛 `CONFLICT` |
| `unregister(listener)` / `removeBySource(source)` / `clear()` | |
| `listeners()` / `has(listener)` | 当前监听器（按执行顺序） |
| `invoker()` / `fire(...args)` | `invoker()` 返回可直接调用的分发函数 |
| `describe()` | `{ name, combiner, size }` |

合并方式：

- `all`（默认）：依次 `await` 全部监听器，返回最后几个的返回值数组；单个抛错只转 `onerror`。
- `first`：按顺序调用，第一个返回值非 `undefined` 的即停止并返回它。
- `waterfall`：**后注册的监听器在外层**，签名 `(value, next)`；不调用 `next` 即中断，`next(v)` 继续。
  实测：`(v, next) => next(v + 1)` 与 `(v, next) => next(v * 2)` 对 `3` 得 `7`。

### 12.2 `modapi.registry` — 命名空间注册表

| 方法 | 返回 | 说明 |
| --- | --- | --- |
| `create(name, { limit, replace })` | `Registry` | 注册表**名**必须是 `^[a-z0-9_.-]+$`（不含冒号）；重名抛 `CONFLICT` |
| `use(name)` | `Registry` | 不存在则创建 |
| `get(name)` / `has(name)` / `names()` / `remove(name)` / `describe()` | | `describe()` → `{ name, size, keys }[]` |

`Registry` 对象：`name`、`size`、`keys()`、`values()`、`list()` → `[{ id, value }]`、`has(id)`、`get(id, fallback)`、`register(id, value, { replace })`、`remove(id)`、`clear()`、`describe()`。

- 条目 id 规则：`^[a-z0-9_.-]+:[a-z0-9/._-]+$`；省略命名空间时补 `modapi:`（`parseId('help')` → `'modapi:help'`）。
- 大写的注册表名/条目 id 抛 `BAD_ARGUMENT`（带 `hint`）。
- 重复 id 抛 `CONFLICT`；超出 `limit`（默认 4096）也抛 `CONFLICT`。

### 12.3 `modapi.modules` 与 `modapi.requires` — 模块版本

| 方法 | 返回 | 说明 |
| --- | --- | --- |
| `get(name)` / `has(name)` / `names()` / `list()` / `describe()` | | 内置 10 个模块，均为 `1.0.0`；`list()`/`describe()` 不含 `value`，只带 `hasValue` |
| `supports(spec)` | `boolean` | `spec` 是 `{ 模块名: 版本范围 }`，不抛 |
| `provide(name, version, { deprecated, note, source })` | `disposer` | 第三方插件发布自己的模块 |
| `modapi.requires(spec)` | `true` | 任一不满足抛 `UNSUPPORTED`，`detail.failures` 一次列全 |
| `modapi.api(name)` | 对象 | 取模块对应的 API 面（`work`/`session`/…），相当于 `modules.get(name).value` |

内置模块名：`work` `session` `tool` `fs` `notice` `events` `registry` `hooks` `scripts` `selfcheck`。`modapi.modules.apiVersion` 是契约版本（当前 `"1"`），插件清单里 `requires: { modapi: "^1.0.0" }` 比的是它。

失败文案实测：

```
demo needs API modules it cannot get: work 1.0.0 does not satisfy ^2.0.0; nope (missing) does not satisfy ^1.0.0
```

### 12.4 版本范围语法（`lib/semver.js`）

支持：`1.2.3`、部分版本 `1` / `1.2`、`*` / `x`、`^1.2.3`、`~1.2.3`、`>` `>=` `<` `<=` `=`、空格表示 AND、`||` 表示 OR。预发布版本参与比较且 `0.2.1-rc.5 < 0.2.1`。

实测语义：`^0.2.1` 匹配 `0.2.5`、不匹配 `0.3.0`；`>=0.2.0` 匹配 `0.2.1-rc.5`；裸 `0.2.1` 不匹配 `0.2.1-rc.5`；`1.0.0 || 2.0.0` 两者都匹配。

### 12.5 mod 清单 `modapi.mod.json`

路径：`$DSH_HOME/modapi/mods/<目录>/modapi.mod.json`，外加 `config.modDirs` 里的每个根目录（只扫一级子目录）。文件名常量 `MANIFEST_NAME = 'modapi.mod.json'`。

| 字段 | 必填 | 规则 |
| --- | --- | --- |
| `id` | ✅ | `^[a-z0-9_.-]+$`；同根目录下重复 id 视为错误 |
| `version` | ✅ | 必须能被 `semver.parse` 解析 |
| `name` / `description` | | 字符串，默认取 `id` |
| `entrypoints.start` | ✅ | 至少一个文件，相对清单所在目录 |
| `entrypoints.stop` | | 卸载时执行 |
| `requires` | | `{ 模块名: 版本范围 }`，加载前校验 |
| `depends` | | `{ modId: 版本范围 }`，决定加载顺序 |

加载语义：

- 按 `depends` 多轮推进；被依赖的 mod 未 loaded 则本轮跳过，轮末仍 pending 的记 `failed`。
- `requires` 不满足 → 不执行入口，`info().mods[]` 里 `status: 'failed'` 且 `reason` 给出具体模块与范围。
- 入口抛错 → 回滚该 mod 用脚本内 `modapi.hook/events.on` 注册的一切，然后记 `failed`。
- 清单非法（JSON 坏、字段非法）→ 该 mod 跳过并 warn，不影响其他 mod。

查询：`modapi.info().mods` → `[{ id, version, name, status, reason, requires, depends, files, hooks }]`；`modapi.scripts.mods()` 同源；`await modapi.scripts.unloadMod(id)` 跑 `stop`、清钩子/事件、删掉它 `events.create` 过的事件。

实测（probe 真机）：`fabric-demo` → `status: 'loaded'`、`hooks: ['checkstart']`；`needs-future`（`work: '^2.0.0'`）→ `status: 'failed'`、`reason: 'work 1.0.0 does not satisfy ^2.0.0'`。

### 12.6 与既有钩子的关系

宿主事件到钩子是**一对多广播**（`fanOut`）：同一个宿主事件既触发保留钩子，也触发同名事件，事件名沿用宿主自己的写法。

| 宿主事件 | 钩子 | 事件 |
| --- | --- | --- |
| `session/created` | `sessioncreate` | `session/created` |
| `session/disposed` | `sessiondelete` | `session/disposed` |
| `session/event` | `messagereceive` | `session/event` |
| `tools/pre-execute` | `toolcall`（须交回 `next()`） | `tools/pre-execute`（可改 `{ exec }`） |
| `tools/result` | `toolresult` | `tools/result` |

生命周期另有两个事件：`modapi:startup`（`start()` 末尾，在 `checkstart` 之前触发）与 `modapi:shutdown`（`dispose()` 开头，先于 `checkstop`）。两者 payload 与对应钩子相同。

`modules.provide(name, version, { value })` 的 `value` 就是该模块的 API 面，`modapi.api('work')` 取到的正是 `modapi.work`；不传 `value` 时 `api(name)` 返回模块记录本身（`{ name, version, deprecated, note, source }`）。`provide()` 返回记录（含 `value`），不返回 disposer；`list()`/`describe()` 会剔掉 `value` 只留 `hasValue`，避免 `/modapi/api/info` 被整棵 API 面撑爆。
