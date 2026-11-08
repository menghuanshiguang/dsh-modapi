# dsh-modapi

给 DeepSeek Harness 插件用的**稳定接口层**：把宿主内部的服务名、方法名、事件名收进一张 ModPE 风格的函数表，插件只认这张表。DSH 升级改了内部接口时，只改 `lib/domains/` 里的适配代码，调用方的插件代码不动。

- 包名 `dsh-modapi`，版本 `0.2.0`，API 版本 `1`
- 工作区 / 会话 / 工具 / 文件四个域 + 11 个钩子 + HTTP 公告通道
- 完整参考：[docs/API.md](docs/API.md)

## 安装

插件是 bundle（`cordis.patch.yml` 往宿主配置里插一条 `modapi`），装进 profile 的两种方式。**两种都用之前先完全退出应用**：Windows 上 profile 目录里的 `node_modules` 会被运行中的应用锁住。

### 方式①：桌面 profile

目标 profile 目录（示例）`C:\Users\fantasytat\.dsh\profiles\desktop`。

1. 在 profile 的 `package.json` 里加依赖，并把它列进 bundles：

```json
{
  "dependencies": {
    "dsh-modapi": "link:D:/dsh/dsh-modapi"
  },
  "dsh": {
    "profile": {
      "bundles": ["dsh-modapi"]
    }
  }
}
```

`bundles` 里保留原有条目，把 `"dsh-modapi"` 追加进同一个数组。

2. 建 junction，让 profile 能按包名解析到这个目录（`link:` 依赖在 Windows 上不会自动建链接）：

```bat
cmd /c mklink /J "C:\Users\fantasytat\.dsh\profiles\desktop\node_modules\dsh-modapi" "D:\dsh\dsh-modapi"
```

目录已存在时先删掉旧的 junction（只删链接，别删源目录）。

3. 完全退出应用再启动。`modapi.health().started` 应为 `true`；自检全部通过后 `$DSH_HOME/modapi/state/contract.json` 会被写下（有缺失时不会写，见「自检」）。

### 方式②：CLI

应用必须已退出：

```bat
D:\DSHPC\resources\runtime\cli\bin\dsh.cmd plugin --profile <profile> add "link:D:/dsh/dsh-modapi"
```

`<profile>` 换成 profile 名。CLI 会自己写依赖并建链接。profile 的 store 不要放在工作区里——工作区会被文件工具与索引扫到，profile 应该待在自己的 `~/.dsh/profiles/` 下。

## 30 秒上手

写一个脚本文件：

```js
// $DSH_HOME/modapi/scripts/hello.js
function checkstart() {
  公告('已启动').show()
}
```

重启应用。右下角会弹出「已启动」公告；`GET /modapi/api/info` 的 `hooks` 里 `checkstart` 的 `count` 会变成 1、`sources` 里出现脚本的绝对路径，说明脚本已加载并自动注册。

脚本目录里所有 `*.js` 都会被加载；**顶层函数名等于钩子名**就自动注册，不用手写 `modapi.hook(...)`。

## 在别的插件里用

```js
export const inject = ['modapi'];

export function apply(ctx) {
  const api = ctx.modapi;
  void api.work.list().then((rows) => {
    ctx.logger.info(`workspaces: ${rows.length}`);
  });
}
```

`inject` 里写 `'modapi'` 保证装配顺序；`ctx.modapi` 就是下表那套接口。装不上的时候 `inject` 会挡住 `apply`，不会拿到 `undefined`。

脚本沙箱里这套接口直接以全局变量出现：`modapi`、`work`、`session`、`tool`、`fs`、`notice` / `toast` / `公告`、`log`、`sleep`。

## API 一览

方法名后面的别名等价于同一个函数。

| 域 | 方法 |
| --- | --- |
| `work` | `list()` `getlist()` `getAll()`、`get(id)` `byId()`、`find(path)` `findByPath()`、`create(path, title)`、`rename(id, title)`、`remove(id)` `delete()`、`move(id, beforeId)`、`forSession(sessionId)`、`paths()`、`count()`、`toRecord()`、`services` |
| `session` | `list()` `all()`、`get(id)` `byId()`、`current()`、`exists(id)`、`ids()`、`messages(id, {limit})` `deriveMessages()`、`count(id)`、`flush(id)`、`toRecord()`、`currentSessionId`、`services` |
| `tool` | `list(scope)`、`schemas(scope)`、`names(scope)`、`get(name, scope)`、`has(name, scope)`、`count(scope)`、`call(name, args, opts)` `run()`、`toRecord()`、`services` |
| `fs` | `resolve(path, opts)` `targetOf()`、`stat(path)`、`exists(path)`、`read(path)` `readText()`、`readBytes(path, opts)`、`list(path)` `listDir()`、`write(path, content, opts)` `writeText()`、`edit(path, {oldString, newString, replaceAll})`、`fileUrl(path)`、`contains(parent, child)`、`services` |
| 钩子 | `hook(name, fn, opts)`、`unhook(name, fn)`、`fire(name, payload)`、`hooks()`、`hookNames`、`wiredHooks` |
| 公告 | `notice(...)` / `公告(...)` / `toast(...)`、`notice.show()`、`notice.push(record)`、`notice.since(seq)`、`notice.snapshot()`、`notice.clear()`、`notice.store.ack(ids)`、`notice.store.wait(seq, ms)`、`Toast`、`noticeLevels` |
| 事件 | `events.create(name, {combiner})`、`events.get(name)`、`events.has(name)`、`events.names()`、`events.remove(name)`、`events.on(name, fn, {order})`、`events.fire(name, ...args)`、`events.describe()` |
| 注册表 | `registry.create(name, {limit})`、`registry.use(name)`、`registry.get(name)`、`registry.has(name)`、`registry.names()`、`registry.remove(name)`、`registry.describe()` |
| 模块与版本 | `modules.get/has/names/list/describe/supports`、`requires(spec)`、`api(name)` |
| 其它 | `health()`、`info()`、`services()`、`require(name)`、`selfcheck.run()` / `.snapshot()` / `.resetFailures()` / `.statePath`、`scripts`、`log`、`sleep(ms)`、`utils.sleep(ms)`、`version`、`pluginVersion`、`name` |

四个域的方法返回 Promise（`toRecord` 除外，它是同步的），另有少数纯本地查询同步返回：`hooks()`、`health()`、`info()`、`services()`、`require()`、`notice.push/show/since/snapshot/clear`、`selfcheck.snapshot()`、`scripts.files()`。返回值是纯 JSON——宿主对象里的函数、循环引用、超深结构在跨边界时就被净化掉了。

## mod 装载与调用架构（对齐 Fabric API）

这一层让 mod 从"调用某个函数"升级为按**命名空间**扩展宿主：自定义事件、注册内容、声明版本要求。

### 事件

```js
const greeting = modapi.events.create('mymod:greeting');   // combiner: 'all' | 'first' | 'waterfall'
const off = modapi.events.on('mymod:greeting', (payload, next) => next({ ...payload, seen: true }));
modapi.events.fire('mymod:greeting', { id: 'mymod' });
off();                                                     // 返回值就是 disposer
```

- 合并方式：`all`（依次调用、收集返回值）、`first`（第一个有返回值的监听器胜出）、`waterfall`（后注册的在外层，`next(value)` 决定是否继续，不调用即中断）。
- 同名事件默认只能 `create` 一次，要替换传 `{ replace: true }`。
- 监听器按 `order` 升序、同 `order` 按注册顺序执行；单个监听器抛错只上报 `onerror`，其余照跑。
- 脚本里注册的监听器带脚本 source，脚本卸载或加载失败时一并清理。

### 注册表

```js
const blocks = modapi.registry.create('blocks');           // 注册表名是普通名字
blocks.register('mymod:ruby', { hardness: 3 });            // 条目 id 是 namespace:path
blocks.get('mymod:ruby');                                   // → { hardness: 3 }
blocks.keys();                                              // ['mymod:ruby']
```

- 条目 id 必须匹配 `^[a-z0-9_.-]+:[a-z0-9/._-]+# dsh-modapi

给 DeepSeek Harness 插件用的**稳定接口层**：把宿主内部的服务名、方法名、事件名收进一张 ModPE 风格的函数表，插件只认这张表。DSH 升级改了内部接口时，只改 `lib/domains/` 里的适配代码，调用方的插件代码不动。

- 包名 `dsh-modapi`，版本 `0.2.0`，API 版本 `1`
- 工作区 / 会话 / 工具 / 文件四个域 + 11 个钩子 + HTTP 公告通道
- 完整参考：[docs/API.md](docs/API.md)

## 安装

插件是 bundle（`cordis.patch.yml` 往宿主配置里插一条 `modapi`），装进 profile 的两种方式。**两种都用之前先完全退出应用**：Windows 上 profile 目录里的 `node_modules` 会被运行中的应用锁住。

### 方式①：桌面 profile

目标 profile 目录（示例）`C:\Users\fantasytat\.dsh\profiles\desktop`。

1. 在 profile 的 `package.json` 里加依赖，并把它列进 bundles：

```json
{
  "dependencies": {
    "dsh-modapi": "link:D:/dsh/dsh-modapi"
  },
  "dsh": {
    "profile": {
      "bundles": ["dsh-modapi"]
    }
  }
}
```

`bundles` 里保留原有条目，把 `"dsh-modapi"` 追加进同一个数组。

2. 建 junction，让 profile 能按包名解析到这个目录（`link:` 依赖在 Windows 上不会自动建链接）：

```bat
cmd /c mklink /J "C:\Users\fantasytat\.dsh\profiles\desktop\node_modules\dsh-modapi" "D:\dsh\dsh-modapi"
```

目录已存在时先删掉旧的 junction（只删链接，别删源目录）。

3. 完全退出应用再启动。`modapi.health().started` 应为 `true`；自检全部通过后 `$DSH_HOME/modapi/state/contract.json` 会被写下（有缺失时不会写，见「自检」）。

### 方式②：CLI

应用必须已退出：

```bat
D:\DSHPC\resources\runtime\cli\bin\dsh.cmd plugin --profile <profile> add "link:D:/dsh/dsh-modapi"
```

`<profile>` 换成 profile 名。CLI 会自己写依赖并建链接。profile 的 store 不要放在工作区里——工作区会被文件工具与索引扫到，profile 应该待在自己的 `~/.dsh/profiles/` 下。

## 30 秒上手

写一个脚本文件：

```js
// $DSH_HOME/modapi/scripts/hello.js
function checkstart() {
  公告('已启动').show()
}
```

重启应用。右下角会弹出「已启动」公告；`GET /modapi/api/info` 的 `hooks` 里 `checkstart` 的 `count` 会变成 1、`sources` 里出现脚本的绝对路径，说明脚本已加载并自动注册。

脚本目录里所有 `*.js` 都会被加载；**顶层函数名等于钩子名**就自动注册，不用手写 `modapi.hook(...)`。

## 在别的插件里用

```js
export const inject = ['modapi'];

export function apply(ctx) {
  const api = ctx.modapi;
  void api.work.list().then((rows) => {
    ctx.logger.info(`workspaces: ${rows.length}`);
  });
}
```

`inject` 里写 `'modapi'` 保证装配顺序；`ctx.modapi` 就是下表那套接口。装不上的时候 `inject` 会挡住 `apply`，不会拿到 `undefined`。

脚本沙箱里这套接口直接以全局变量出现：`modapi`、`work`、`session`、`tool`、`fs`、`notice` / `toast` / `公告`、`log`、`sleep`。

## API 一览

方法名后面的别名等价于同一个函数。

| 域 | 方法 |
| --- | --- |
| `work` | `list()` `getlist()` `getAll()`、`get(id)` `byId()`、`find(path)` `findByPath()`、`create(path, title)`、`rename(id, title)`、`remove(id)` `delete()`、`move(id, beforeId)`、`forSession(sessionId)`、`paths()`、`count()`、`toRecord()`、`services` |
| `session` | `list()` `all()`、`get(id)` `byId()`、`current()`、`exists(id)`、`ids()`、`messages(id, {limit})` `deriveMessages()`、`count(id)`、`flush(id)`、`toRecord()`、`currentSessionId`、`services` |
| `tool` | `list(scope)`、`schemas(scope)`、`names(scope)`、`get(name, scope)`、`has(name, scope)`、`count(scope)`、`call(name, args, opts)` `run()`、`toRecord()`、`services` |
| `fs` | `resolve(path, opts)` `targetOf()`、`stat(path)`、`exists(path)`、`read(path)` `readText()`、`readBytes(path, opts)`、`list(path)` `listDir()`、`write(path, content, opts)` `writeText()`、`edit(path, {oldString, newString, replaceAll})`、`fileUrl(path)`、`contains(parent, child)`、`services` |
| 钩子 | `hook(name, fn, opts)`、`unhook(name, fn)`、`fire(name, payload)`、`hooks()`、`hookNames`、`wiredHooks` |
| 公告 | `notice(...)` / `公告(...)` / `toast(...)`、`notice.show()`、`notice.push(record)`、`notice.since(seq)`、`notice.snapshot()`、`notice.clear()`、`notice.store.ack(ids)`、`notice.store.wait(seq, ms)`、`Toast`、`noticeLevels` |
| 其它 | `health()`、`info()`、`services()`、`require(name)`、`selfcheck.run()` / `.snapshot()` / `.resetFailures()` / `.statePath`、`scripts`、`log`、`sleep(ms)`、`utils.sleep(ms)`、`version`、`pluginVersion`、`name` |

四个域的方法返回 Promise（`toRecord` 除外，它是同步的），另有少数纯本地查询同步返回：`hooks()`、`health()`、`info()`、`services()`、`require()`、`notice.push/show/since/snapshot/clear`、`selfcheck.snapshot()`、`scripts.files()`。返回值是纯 JSON——宿主对象里的函数、循环引用、超深结构在跨边界时就被净化掉了。

，省略命名空间时落到 `modapi:`。
- 重复 id 抛 `CONFLICT`；超过 `limit`（默认 4096）也抛 `CONFLICT`，不静默丢数据。

### 模块版本

```js
modapi.requires({ work: '^1.0.0', fs: '>=1.0.0 <2.0.0' });  // 任一不满足抛 UNSUPPORTED（一次列全）
modapi.modules.supports({ work: '^2.0.0' });                 // false，不抛
```

内置模块：`work` `session` `tool` `fs` `notice` `events` `registry` `hooks` `scripts` `selfcheck`，当前均为 `1.0.0`。第三方插件可用 `modapi.modules.provide('mymod', '0.2.0')` 发布自己的模块。

### mod 清单 `modapi.mod.json`

放在 `$DSH_HOME/modapi/mods/<目录>/modapi.mod.json`（`config.modDirs` 可追加根目录）：

```json
{
  "id": "fabric-demo",
  "version": "1.2.0",
  "name": "mod 装载示例",
  "entrypoints": { "start": "main.js", "stop": "stop.js" },
  "requires": { "work": "^1.0.0", "events": "^1.0.0" },
  "depends": {}
}
```

- `entrypoints.start` 必填且至少一个文件；`stop` 在 `modapi.scripts.unloadMod(id)` 时执行。
- `requires` 校验模块版本（`modapi` 项比的是契约版本 `apiVersion`）；不满足时整个 mod 不加载，原因写进 `info().mods[]`。
- `depends` 只影响加载顺序：被依赖的 mod 必须先加载成功。
- 入口抛错会回滚该 mod 已注册的钩子，宿主和其他 mod 不受影响。
- 清单非法时该 mod 被跳过并记 warn，不阻止其他 mod 加载。

```js
modapi.info().mods;                              // [{id, version, status, reason, requires, depends, files, hooks}]
modapi.scripts.mods();
await modapi.scripts.unloadMod('fabric-demo');    // 跑 stop、清钩子/事件、删掉注册的事件
```

## 钩子

11 个保留名，其中 8 个接在宿主的真实事件上，3 个只有名字、只能手动 `modapi.fire()` 触发。

| 名字 | 已接线 | 触发时机 | payload |
| --- | --- | --- | --- |
| `checkstart` | ✅ | 插件启动完成、自检之后 | `{api, info, selfcheck, ready}` |
| `checkstop` | ✅ | 插件卸载/停用，清理之前 | `{api, info}` |
| `onerror` | ✅ | 任一钩子订阅者抛错 | `{error, hook, source}` |
| `sessioncreate` | ✅ | 宿主 `session/created` | `{session}` |
| `sessiondelete` | ✅ | 宿主 `session/disposed` | `{session}` |
| `sessionarchive` | ⬜ 保留 | 只能 `fire()` | — |
| `messagereceive` | ✅ | 宿主 `session/event` | `{session, event}` |
| `toolcall` | ✅ | 宿主 `tools/pre-execute`，在每个工具执行前 | `{exec}` |
| `toolresult` | ✅ | 宿主 `tools/result` | `{exec, result}` |
| `pluginload` | ⬜ 保留 | 只能 `fire()` | — |
| `pluginunload` | ⬜ 保留 | 只能 `fire()` | — |

`modapi.hookNames` 是 11 个名字的数组，`modapi.wiredHooks` 是其中 8 个已接线的。

单个订阅者抛错不影响其他人继续收到同一个事件，但 `fire()` 的返回里这一位是 `undefined`、`failed` 加一，错误转给 `onerror`。

## 示例

| 文件 | 演示内容 |
| --- | --- |
| `examples/hello.js` | 最小脚本：`checkstart` 里 `公告(...).show()` |
| `examples/self-test.js` | 启动时把 work/session/tool/fs 的调用结果塞进一条公告 |
| `examples/fabric-mod/` | 完整的 mod：`modapi.mod.json` 清单 + 模块 `requires` 校验 + 命名空间注册表 + 自定义事件 |

`examples/` 里的 `.js` 直接拷到 `$DSH_HOME/modapi/scripts/`；`examples/fabric-mod/` 整个目录拷到 `$DSH_HOME/modapi/mods/fabric-demo/`，重启 DSH 生效。

## 配置

`cordis.patch.yml` 里 7 个键，插进宿主配置的 `modapi` 条目：

| 键 | 默认 | 钳制 | 说明 |
| --- | --- | --- | --- |
| `startupTimeoutMs` | `15000` | `>= 1000` | 等宿主就绪的预算，超时只是记 `timeout`，不阻断启动 |
| `scriptDirs` | `[]` | 相对 `process.cwd()` 解析 | 额外脚本目录，和 `$DSH_HOME/modapi/scripts` 合并去重 |
| `scripts` | `[]` | 同上 | 额外脚本文件 |
| `watchScripts` | `false` | 只认 `=== true` | 开 200ms 去抖的文件监听，改脚本自动重载 |
| `noticeLimit` | `64` | `>= 1` | 公告环形缓冲上限 |
| `noticeTtlMs` | `600000` | `>= 1000` | 公告存活时间，过期即清 |
| `hookLimitPerName` | `64` | `>= 1` | 单个钩子的订阅者上限，超了 `hook()` 抛 `CONFLICT` |

数值键写非数字会回落默认值；小数向下取整；未知键原样保留（方便别的插件读自己的配置）。

## 自检

`$DSH_HOME/modapi/state/contract.json` 是「这台机器上这套 DSH 版提供的接口」的基线，记录 10 项能力（`work.list`、`work.create`、`session.list`、`session.get`、`tool.list`、`fs.resolve`、`fs.read`、`fs.write`、`fs.list`、`notice.bridge`）以及当时的宿主版本。

- 启动时跑一次 `selfcheck.run({deep: true, notify: true})`：逐项看 10 个能力的服务与方法在不在（`deep` 才查方法），不写文件、不建工作区，`notice.bridge` 用桥的挂载状态代替。
- **全部通过才写基线**；有缺失时基线保持原样，方便对照。
- 上次通过、这次缺失的项算**回归**，会弹一条 `error` 级公告（标题「modapi：接口失效（DSH 升级后）」），正文带旧版本 → 新版本和逐项原因。
- 手动重跑：`await modapi.selfcheck.run()`，返回 `{ok, checked, missing[], regressed[], statePath, at}`。
- 换 DSH 版本后基线要重写：`await modapi.selfcheck.run({updateBaseline: true})`，确认 `missing` 为空再写。

## 排错

**`UNSUPPORTED` 是什么意思**
宿主没有这个服务、或者服务在但没有这个方法。`message` 会写明是哪一个（`host service A | B is not available on this DSH build` / `host method A | B is missing`），`domain` 和 `method` 字段指出是哪个域的哪个调用，`hint` 给出下一步。这通常意味着 DSH 换了内部接口名，要么升级 `dsh-modapi`，要么在 `lib/domains/` 里补适配。

**公告不出现 / 桥没装上**
浏览器那半边靠 HTTP 桥取公告。按顺序查：

1. `await modapi.health()` → `services.webServer` 是不是 `true`。`false` 说明 `webServer` 服务没拿到，桥根本没注册。
2. `health().missing` 里有没有 `notice.bridge`。有就是桥没挂上。
3. 直接打桥：`curl http://127.0.0.1:<GUI端口>/modapi/api/info`。404 说明路径没注册，连不上说明端口不对。
4. 浏览器控制台看 `modapi-notices` 槽有没有注册（`shell.overlay`，order 200）。

桥失败时 `registerBridge` 的 `failure()` 会返回 `failed: …`，正常（已挂上或还没轮到）返回 `null`。

**看日志**
所有输出都带 `[dsh-modapi]` 前缀。启动顺序：`script xxx registered: …` → 自检结果 → 脚本里的 `checkstart` 公告。脚本文件编译失败或运行抛错只会 warn 一行 `script <绝对路径> failed: …`，不影响其他脚本。

**跑测试**
`package.json` 里的 `test` 脚本指向 `node test/all.js`，这个文件不存在，所以 `npm test` 直接报 `Error: Cannot find module '…\test\all.js'`。`node --test test/` 同样起不来（`Cannot find module '…\test'`）。按文件跑是可以的：`node --test test/*.test.js`（本机 19:31 测：167 个用例全过）。要验证真实宿主行为，最直接的是在 `$DSH_HOME/modapi/scripts/` 里放一个 `checkstart` 脚本，把 `JSON.stringify(await modapi.health())` 打进公告，重启看结果。

## 已知限制（0.2.0）

1. **脚本暴露的能力就是 modapi 暴露的能力**：脚本沙箱里没有 Node 的 `require`/`fs`，只能走 `modapi`、`work`、`session`、`tool`、`fs`、`公告` 这几个全局。需要更强能力请写正式插件。
2. **`tool.call()` 不带 `agent` 时会绕过 agent 级 guard/approval**：返回值里的 `scoped` 标记会告诉你这一点。
3. **公告只存在内存里**：进程重启即清空，超过 `noticeLimit` 或 `noticeTtlMs` 自动淘汰；浏览器端只负责显示与 ack。

未在真实宿主进程里端到端验证的部分（宿主服务是桩对象）：桥的鉴权链路、浏览器槽渲染、`sessioncreate`/`sessiondelete`/`messagereceive`/`toolcall`/`toolresult` 五个事件的实际 payload 形状。详见 [docs/API.md](docs/API.md) 末尾的「已知偏差与未验证项」。
