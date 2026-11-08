# dsh-modapi

给 DeepSeek Harness 插件用的**稳定接口层**：把宿主内部的服务名、方法名、事件名收进一张 ModPE 风格的函数表，插件只认这张表。DSH 升级改了内部接口时，只改 `lib/` 里的适配代码，调用方的插件代码不动。

- 包名 `dsh-modapi`，版本 `0.3.0`，API 版本 `1`
- 工作区 / 会话 / 工具 / 文件四个域 + 11 个钩子 + 公告通道 + 方法钩子（patch）+ UI 规则
- 完整参考：[docs/API.md](docs/API.md)

## 特性

- **版本隔离**：插件写 `ctx.modapi.work.getlist()`，不去碰 `ctx.get('workspaceRegistry')`；DSH 把 `workspaceRegistry` 改名，只需改 modapi。
- **缺能力不炸**：任何域在宿主缺服务时抛结构化 `UNSUPPORTED`，并自动推一条错误公告，不会把整个宿主带崩。
- **自检**：启动时探测 10 项能力并落基线（`$DSH_HOME/modapi/state/contract.json`）；升级后哪项从 ok 变 missing，启动就弹红框告警，写明 DSH 版本从→到。
- **钩子**：`checkstart` 启动即调，另有 `checkstop`/`onerror`/`sessioncreate`/`messagereceive`/`toolcall` 等。
- **Xposed 式方法钩子**：`patch.method()` 改写宿主方法（before / after / replace / 取消）。
- **UI 规则**：脚本给个选择器就能拦截或改写浏览器里某个按钮的点击。
- **Fabric 风格调用层**：命名空间事件、命名空间注册表、按模块的版本约束、`modapi.mod.json` 清单。

## 安装

插件是 bundle（`cordis.patch.yml` 往宿主配置里插一条 `modapi`）。**先完全退出应用**：Windows 上 profile 里的 `node_modules` 会被运行中的应用锁住。

```bat
D:\DSHPC\resources\runtime\cli\bin\dsh.cmd plugin --profile desktop add "link:D:/dsh/dsh-modapi"
```

或者从 GitHub 装（版本号换成你要的那个）：

```bat
D:\DSHPC\resources\runtime\cli\bin\dsh.cmd plugin --profile desktop add "github:menghuanshiguang/dsh-modapi"
```

命令会同时写 profile 的 `dependencies` 和 `dsh.profile.bundles`，失败自动回滚这两个文件。装完重启应用。

## 30 秒上手

把脚本丢进 `$DSH_HOME/modapi/scripts/`（Windows 是 `C:\Users\<你>\.dsh\modapi\scripts\`）：

```js
// hello.js
function checkstart() {
  公告('modapi 已启动，脚本已加载').show();
}
```

重启 DSH，右下角出现公告卡——脚本 → 钩子 → 客户端渲染整条链就通了。

脚本沙箱里的全局变量：`modapi`、`work`、`session`、`tool`、`fs`、`notice` / `toast` / `公告`、`events`、`registry`、`patch`、`ui`、`log`、`sleep`、`console`。顶层同名函数（`function checkstart() {}`）会自动注册成钩子。

## 在别的插件里用

```js
export const name = 'my-plugin'
export const inject = ['modapi']

export function apply(ctx, config) {
  ctx.modapi.work.getlist().then((list) => {
    ctx.modapi.公告({ title: '工作区', body: `${list.length} 个` }).show()
  })
}
```

`inject` 里写 `'modapi'` 保证装配顺序：modapi 没装上时 `apply` 不会被调用，不会拿到 `undefined`。

## API 一览

括号里的别名等价于同一个函数；`getlist/byId/all/delete/hook/unhook` 等在 `apiVersion 1` 内保留，`apiVersion 2` 会移除。

| 域 | 方法 |
| --- | --- |
| `work` | `list()` `getlist()` `getAll()`、`get(id)` `byId()`、`find(path)` `findByPath()`、`create(path, title)`、`rename(id, title)`、`remove(id)` `delete()`、`move(id, beforeId)`、`forSession(sessionId)`、`paths()`、`count()`、`toRecord()` |
| `session` | `list()` `all()`、`get(id)` `byId()`、`current()`、`exists(id)`、`ids()`、`messages(id, {limit})` `deriveMessages()`、`count(id)`、`flush(id)`、`toRecord()`、`currentSessionId` |
| `tool` | `list(scope)`、`schemas(scope)`、`names(scope)`、`get(name, scope)`、`has(name, scope)`、`count(scope)`、`call(name, args, opts)` `run()`、`toRecord()` |
| `fs` | `resolve(path, opts)` `targetOf()`、`stat(path)`、`exists(path)`、`read(path)` `readText()`、`readBytes(path, opts)`、`list(path)` `listDir()`、`write(path, content, opts)` `writeText()`、`edit(path, {oldString, newString, replaceAll})`、`fileUrl(path)`、`contains(parent, child)` |
| 钩子 | `hooks.on(name, fn, opts)`、`hooks.off`、`hooks.fire`、`hooks.describe()`、`hooks.names`、`hooks.wired`、`hooks.clear()` |
| 方法钩子 | `patch.method(target, key, hooks)`、`patch.restore(target, key)`、`patch.restoreBySource(src)`、`patch.restoreAll()`、`patch.list()`、`patch.describe()`、`patch.size` |
| UI 规则 | `ui.hook(spec)`、`ui.unhook(id)`、`ui.get(id)`、`ui.has(id)`、`ui.list()`、`ui.clear()`、`ui.removeBySource(src)`、`ui.serialize()`、`ui.describe()`、`ui.hit(id)`、`ui.version` |
| 公告 | `notice(...)` / `公告(...)` / `toast(...)`、`notice.show()`、`notice.push(record)`、`notice.since(seq)`、`notice.snapshot()`、`notice.clear()`、`notice.store.ack(ids)`、`notice.store.wait(seq, ms)`、`Toast`、`noticeLevels` |
| 事件 | `events.create(name, {combiner})`、`events.get(name)`、`events.has(name)`、`events.names()`、`events.remove(name)`、`events.on(name, fn, {order})`、`events.fire(name, ...args)`、`events.describe()` |
| 注册表 | `registry.create(name, {limit})`、`registry.use(name)`、`registry.get(name)`、`registry.has(name)`、`registry.names()`、`registry.remove(name)`、`registry.describe()` |
| 模块与版本 | `modules.get/has/names/list/describe/supports`、`requires(spec)`、`api(name)` |
| 其它 | `health()`、`info()`、`services()`、`require(name)`、`selfcheck.run()` / `.snapshot()` / `.resetFailures()` / `.statePath`、`scripts`、`log`、`sleep(ms)`、`version`、`apiVersion`、`pluginVersion`、`name` |

四个域的方法返回 Promise（`toRecord` 除外，它是同步的），纯本地查询同步返回：`hooks.describe()`、`health()`、`info()`、`services()`、`require()`、`notice.push/show/since/snapshot/clear`、`selfcheck.snapshot()`、`scripts.files()`。返回值是纯 JSON——宿主对象里的函数、循环引用、超深结构在跨边界时就被净化掉。

错误统一是 `{ code, message, domain, method, hint }`，`code` 取值：`UNSUPPORTED` `BAD_ARGUMENT` `NOT_FOUND` `CONFLICT` `DENIED` `TIMEOUT` `INTERNAL`。

## 钩子

| 钩子 | 触发点 | 自动接线 |
| --- | --- | --- |
| `checkstart` | 宿主就绪、自检跑完、脚本加载完 | ✅ |
| `checkstop` | 插件销毁 | ✅ |
| `onerror` | 任何钩子 / 方法钩子 / 脚本抛错 | ✅ |
| `sessioncreate` | 新会话建立 | ✅ |
| `sessiondelete` | 会话销毁 | ✅ |
| `messagereceive` | 会话收到事件（`session/event`） | ✅ |
| `toolcall` | 模型调用工具前（waterfall，可改参数） | ✅ |
| `toolresult` | 工具返回后 | ✅ |
| `sessionarchive` `pluginload` `pluginunload` | 保留名，只能手动 `hooks.fire` | ❌ |

```js
const off = modapi.hooks.on('checkstart', ({ api }) => {
  api.公告('启动完成').show();
});
off();                                     // 退订
modapi.hooks.fire('sessionarchive', {...}); // 手动触发
modapi.hooks.describe();                    // [{name, count, wired, sources}]
```

## Xposed 式方法钩子（patch）

给宿主里任意 JS 对象的方法打钩子，等价于 Xposed 的 `XC_MethodHook`。

```js
// 公告标题统一加标记
patch.method(modapi.notice, 'show', {
  name: 'notice-title-marker',
  before(args) {
    if (typeof args[0] === 'string') args[0] = '[钩子] ' + args[0]
  },
  after(result) {
    log('shown', result && result.id)
  },
})

// 传空参数就不让创建
patch.method(modapi.work, 'create', {
  before(args) { if (!args[0]) return false },
})
```

| 钩子 | 签名 | 语义 |
| --- | --- | --- |
| `before` | `(args, self) => void \| false` | 按注册顺序执行；返回 `false` 取消原方法，**且跳过 `after`** |
| `replace` | `(args, self) => any` | 命中即取代原方法，`after` 仍执行，可改其返回值 |
| `after` | `(result, args, self) => any` | 逆序执行；返回非 `undefined` 覆盖结果 |
| 原方法返回 Promise | — | 等 resolve 后进 `after`，钩子不必写 `async` |

- 控制器：`const handle = patch.method(...)` → `handle.restore()`、`disable()`/`enable()`、`describe()`。
- 批量还原：`patch.restoreBySource(tag)`（脚本卸载自动调用）、`patch.restoreAll()`。
- 钩子抛错只计数 + 打日志 + 转发 `onerror`，原方法继续跑。
- 只作用于 JS 层方法；DOM 用 `ui`；改不了已固化进闭包的内部调用。

## UI 点击拦截（ui）

宿主进程里没有 DOM，UI 规则只是一份**描述**：宿主存 `{selector, event, mode, handler}`，浏览器端每 3 秒同步一次、在 capture 阶段挂监听。

```js
ui.hook({
  selector: 'text=自动化任务',
  event: 'click',
  mode: 'block',
  name: 'block-automation-nav',
  handler(ctx) {
    ctx.toast('拦下了「' + ctx.element.textContent.trim() + '」的点击', 'warn')
  },
})
```

- 选择器：CSS 选择器；`text=自动化任务` 精确匹配可见文本；`text*=自动化` 包含匹配。
- `mode`：`before`（先跑 handler，原行为照旧）、`after`（默认行为之后）、`replace`（跳过原监听）、`block`（拦截）。
- `ctx`：`rule`、`selector`、`element`、`stop()`、`preventDefault()`、`log(...)`、`toast(text, level)`；handler 返回 `false` 等价于 `stop()`。
- **handler 必须自包含**：它以 `toString()` 跨进程传输，客户端用 `new Function` 还原，引用不了闭包/外部变量。
- 规则上限 `uiRuleLimit`（默认 64）；`ui.hook()` 返回 `{id, unhook(), describe()}`，脚本卸载按来源自动清。

## 命名规范

| 动作 | 规范名 | deprecated 别名 |
| --- | --- | --- |
| 列全部 | `list()` | `getlist()`、`getAll()`、`all()` |
| 取单个 | `get(id)` | `byId()`、`find()` |
| 判断存在 | `has(name)` | — |
| 新建 | `create(...)` | — |
| 修改 | `update(...)` 或领域动词（`setTitle`、`rename`） | — |
| 删除 | `remove(...)` | `delete()` |
| 订阅 / 退订 / 触发 | `on` / `off` / `fire`（`hooks.*`、`events.*`、`ui.hook`） | `hook`、`unhook` |
| 自描述 | `describe()` | — |

模块名一律单数小写：`work` `session` `tool` `fs` `notice` `events` `registry` `hooks` `scripts` `selfcheck`。

## Fabric 风格调用层

让 mod 从"调用某个函数"升级成按**命名空间**扩展宿主。

### 事件

```js
const greeting = modapi.events.create('mymod:greeting');   // all | first | waterfall
const off = modapi.events.on('mymod:greeting', (payload, next) => next({ ...payload, seen: true }));
modapi.events.fire('mymod:greeting', { id: 'mymod' });
```

`all` 依次调用并收集返回值；`first` 第一个有返回值的胜出；`waterfall` 后注册的在外层，`next(value)` 决定是否继续，不调用即中断。

### 注册表

```js
const blocks = modapi.registry.create('blocks');            // 表名是普通名字
blocks.register('mymod:ruby', { hardness: 3 });             // 条目 id 是 namespace:path
blocks.get('mymod:ruby');
```

### 模块版本

```js
modapi.requires({ work: '^1.0.0', fs: '>=1.0.0 <2.0.0' });  // 任一不满足抛 UNSUPPORTED（一次列全）
```

内置模块 `work session tool fs notice events registry hooks scripts selfcheck` 均为 `1.0.0`；第三方可用 `modules.provide('mymod', '0.2.0')` 发布自己的模块。

### mod 清单 `modapi.mod.json`

放在 `$DSH_HOME/modapi/mods/<目录>/`：

```json
{
  "id": "fabric-demo",
  "version": "1.2.0",
  "entrypoints": { "start": "main.js", "stop": "stop.js" },
  "requires": { "work": "^1.0.0", "events": "^1.0.0" }
}
```

`entrypoints.start` 必填；`stop` 在 `scripts.unloadMod(id)` 时执行；`requires` 不满足则整个 mod 不加载，原因写进 `info().mods[]`；入口抛错只回滚该 mod 注册的东西。示例见 [`examples/fabric-mod/`](examples/fabric-mod/)。

## 配置

配置写在 profile 的 `cordis.patch.yml` 里那条 `modapi` 的 `config` 下：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `startupTimeoutMs` | `15000` | 等宿主就绪的上限，超时就继续（自检会照实报缺失） |
| `scriptDirs` | `[]` | 追加脚本目录，默认 `$DSH_HOME/modapi/scripts` |
| `scripts` | `[]` | 直接指定脚本文件（绝对路径或相对 cwd） |
| `watchScripts` | `false` | 监听脚本目录变动并热重载 |
| `noticeLimit` | `64` | 公告队列容量 |
| `noticeTtlMs` | `600000` | 公告在服务端保留时长 |
| `hookLimitPerName` | `64` | 单个钩子名下的订阅上限 |
| `modDirs` | `[]` | 追加 mod 根目录，默认 `$DSH_HOME/modapi/mods` |

## 自检

启动时探测 10 项能力：`work.list` `work.create` `session.list` `session.get` `tool.list` `fs.resolve` `fs.read` `fs.write` `fs.list` `notice.bridge`。

- 全绿时把基线写进 `$DSH_HOME/modapi/state/contract.json`。
- 升级 DSH 后某项从 ok 变 missing → 启动弹红框：`modapi：接口失效（DSH 升级后）`，正文列出 `DSH <旧> → <新>` 和具体哪一项、缺哪个服务。
- 运行时调用打到已失效的接口，只弹一次错误公告，重复调用只计数（`info().selfcheck` 可查），不会刷屏。

```js
modapi.selfcheck.run({ deep: true, notify: true });   // → {ok, checked, missing, regressed, statePath, at}
```

## 排错

- 日志里只有 `dsh: skipping profile bundle "dsh-modapi": ... cannot resolve ...` → 依赖没装进 profile，跑一次 `plugin --profile desktop install`。
- `EADDRINUSE` / `startup failed: N required plugins did not activate` → 上一个宿主进程还占着端口，先 `taskkill` 再启动。
- 浏览器里 `401 {"code":"UNAUTHORIZED"}` → 用 `dsh web` 打印的带 `?token=` 的 URL 打开，cookie 会自己下发。
- 公告不弹 → 浏览器控制台看 `[dsh-modapi]` 前缀的 warn；`GET /modapi/api/info` 能看到桥是否挂上。

## 已知限制（0.3.0）

- 公告只存内存（默认 10 分钟 TTL），重启即清空；要持久化得自己落盘。
- `tool.call()` 不带 `agent` 时绕过 agent 级 guard/approval，返回值里 `scoped: false` 标明。
- 脚本沙箱只给上述全局变量，没有 `require`/网络/文件系统裸访问（要走 `fs` 域）。
- UI handler 不能带闭包；复杂逻辑请把数据预先算好塞进规则或让客户端读公告。
- `patch.method` 只能改 JS 层方法，改不了 DOM，也改不了已经固化在闭包里的内部调用。

## 已验证证据

- `docs/images/probe-notices.png`：真实宿主里公告卡片渲染 + `×` 关闭走 ack。
- `docs/images/probe-regression.png`：模拟 DSH 改名后启动自检弹红框。
- `docs/images/probe-fabric.png`：Fabric 风格 mod（注册表 + 自定义事件）加载成功。
- `docs/images/shot-ui-block.png`：`patch.method` 给公告标题加 `[钩子]` 前缀；`ui` 规则拦下「自动化任务」按钮的点击并弹 toast，应用没有跳转。

## 目录

```
index.js              apply()：ctx.provide('modapi') / 桥注册 / 生命周期
lib/modapi.js         API 组装、钩子接线、start/dispose
lib/domains/          work session tool fs 四个域
lib/patcher.js        方法钩子
lib/ui.js             UI 规则表
lib/events.js         命名空间事件
lib/registry.js       命名空间注册表
lib/modules.js        模块版本与 requires 校验
lib/manifest.js       modapi.mod.json 解析与扫描
lib/scripts.js        脚本沙箱、mod 装载
lib/selfcheck.js      能力探测与回归告警
lib/bridge.js         /modapi/api/*
lib/client.js         浏览器端：公告卡片 + UI 规则执行
```
