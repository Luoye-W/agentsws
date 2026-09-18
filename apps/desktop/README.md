# @agentsws/desktop

Electron 托盘壳（13 §5「桌面壳改为浏览器打开 + 极小启动器」、34 §2）。**没有任何界面逻辑**：
工作台的 UI 只有一份，由服务进程提供，浏览器与应用内窗口加载的是同一个本地 URL。

托盘做五件事：打开工作台（默认应用内窗口）/ 在浏览器打开 / 暂停（急停）/ 状态 / 退出，
外加重启服务、打开日志目录、开机自启。

## 结构

| 文件 | 管什么 |
|---|---|
| `src/main.ts` | Electron 主进程，**只做装配** |
| `src/preload.cts` | 桥接层，20 行；`sandbox: true` 的 preload 必须是 CJS，所以是 `.cts` |
| `src/bridge-types.ts` | 桥接对象的类型，前端 `import type { DesktopBridge } from '@agentsws/desktop/bridge'` |
| `src/ports.ts` | 注入口：`Clock` / `FileStore` / `TimerPort` / `Spawner` / `FetchLike` / `SafeStorageLike` |
| `src/sidecar.ts` | 进程监督状态机 + 退避重启 |
| `src/server-process.ts` | 怎么起 `apps/server`：跑哪个 Node、传哪些环境变量 |
| `src/secrets.ts` | 首次运行生成三把密钥，safeStorage 加密落盘 |
| `src/redact.ts` `src/logging.ts` | 日志与脱敏 |
| `src/config.ts` `src/halt.ts` `src/paths.ts` | `config.json` / `halt.json` / 用户数据目录布局 |
| `src/navigation.ts` `src/csp.ts` | URL 拦截判定与 CSP |
| `src/menu.ts` `src/i18n.ts` | 托盘菜单的数据模型 |
| `src/connect-runtime.ts` | OpenConnector runtime 检测 + 加固检查（v1 不负责拉起） |
| `src/mode.ts` | 本机 / 连公司服务器的判定（40 §1.3）；`src/wizard-preload.cts` 是首启向导的界面 |
| `src/updater.ts` | electron-updater 骨架 +「冒烟不过不切换」 |

除 `main.ts` / `preload.cts` 外**没有一个模块 import `electron`**——所以状态机、退避、密钥、
URL 判定、菜单模型都能在 vitest 里跑满 100% 行覆盖；`main.ts` 由 `e2e/` 的 playwright 冒烟覆盖。

## 用户数据目录

`app.getPath('userData')`（macOS `~/Library/Application Support/agentsws`）：

```
config.json     端口 / 是否浏览器打开 / 开机自启 / 语言 / 模式与公司服务器地址 —— 不含任何密钥
secrets.bin     safeStorage 密文（macOS 钥匙串 / Windows DPAPI 背书）
halt.json       急停档位（托盘"暂停"写它）
logs/           desktop.log、server.log（子进程 stdout / stderr，脱敏后）
data/           传给服务进程的 AGENTSWS_DB_DIR
```

`AGENTSWS_DESKTOP_USER_DATA` 可以把整个目录挪走（开发与 e2e 用）。

## 两种模式（40 §1.3、41 §2.1）

|  | `local`（默认） | `remote` |
|---|---|---|
| 服务进程 | 本机 sidecar，壳负责起停 | 公司那台常开机器 / NAS 上跑，壳**一个进程都不拉** |
| 本机密钥 | 四把（safeStorage 加密落盘） | **一把都不生成**——没有本机服务要喂 |
| 登录 | 会话密钥换 cookie（token 不进渲染进程） | 邀请链接 / magic-link，cookie 由公司服务器下发 |
| 数据 | 就在这台机器上 | 在公司机器上；**这台电脑不存真源** |
| 托盘状态 | 「服务运行中（127.0.0.1:4317）」 | 「已连接 nas.company.lan」；没有「重启服务」「轮换本机密钥」 |

第一次启动会问一句（本机 / 公司服务器二选一），选完写进 `config.json`；
`AGENTSWS_SERVER_URL` 覆盖配置，也跳过那道问卷（运维批量部署与 e2e 都靠它）。
地址只认 http / https，取源（路径与尾斜杠都丢掉）——它同时是 `allowedOrigins`、
cookie 的 url 与 CSP `'self'` 的依据，三处必须是同一个字符串。

## 密钥

首次运行生成三把（各 32 字节）：`OOMOL_CONNECT_ENCRYPTION_KEY`、`OOMOL_CONNECT_ADMIN_TOKEN`
（08 §5：这两个不设 OpenConnector runtime 不许启动）、服务进程会话密钥。

- 用 Electron `safeStorage` 加密后存 `secrets.bin`；**系统密钥库不可用就直接拒绝启动**，
  不落明文；
- 唯一出口是子进程的环境变量（`secretsToEnv()`），顺带把 `OOMOL_CONNECT_BLOCKED_PROXIES=*` 一起给上；
- 不经模型、不经渲染进程、不进日志（`createRedactor()` 把三个值注册成字面量遮罩，
  另有形态兜底——`apps/server` 启动就会打印 `internal token: …`，那一行进日志时是 `[redacted]`）。

## 安全

| 事项 | 做法 |
|---|---|
| 窗口 | `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`、`webSecurity: true`、`webviewTag: false` |
| CSP | 主进程在 `onHeadersReceived` 里**覆盖**成 `default-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'` |
| 导航 | `will-navigate` / `setWindowOpenHandler`：本地源放行，http(s)/mailto 交系统浏览器，**其余协议一律拒**（`file:` `javascript:` `ms-msdt:` 这些交给 `shell.openExternal` 是能执行本机命令的） |
| 权限 | `setPermissionRequestHandler` 一律拒 |
| 桥接 | 只有 `notify / openExternal / platform / version` 四件；IPC 只接受本地源窗口发来的调用 |
| 子进程环境 | 白名单继承（`INHERITED_ENV`），宿主的 `DEEPSEEK_API_KEY` 之类漏不进去 |

## 桥接层与特性检测

工作台**不许** import 任何 electron 东西，只 `import type`，运行时先判空：

```ts
import type { DesktopBridge } from '@agentsws/desktop/bridge'

const bridge: DesktopBridge | undefined = window.agentsws
if (bridge !== undefined) await bridge.notify({ title: '有 3 条待审批' })
else new Notification('有 3 条待审批')   // 普通浏览器里的退化路径
```

## 急停

`packages/kernel` 的 `MemoryHalt` 只在**进程启动时**读 `AGENTSWS_HALT`，网关也没有运行期改急停的路由。
所以托盘"暂停"= 写 `halt.json` + 按新的环境变量重启服务 sidecar（重启后仍然是停的）。
server 哪天提供了运行期急停接口，`src/halt.ts` 换成直接调它即可。

## 原生模块与 sidecar 的 Node

13 §5 的原意是借 Electron 自带的 Node 跑 sidecar，同一段也留了后手：
「Electron 内置 Node 版本须满足要求，**不够则 sidecar 用独立打包的 Node**」。**v1 走的是后手**：

- `better-sqlite3` 11 的 C++ 编不过 Electron 44 的 V8 头（`v8::External::Value()` 换了签名），
  `@electron/rebuild` 会失败；
- 不重建又 ABI 对不上（`ERR_DLOPEN_FAILED`）；
- 而且在 pnpm workspace 里重建会把仓库里给普通 Node 用的那份 `.node` 覆盖掉，
  连带把别的包的测试搞挂。

因此 `electron-builder.yml` 里 `npmRebuild: false`，`resolveServerRuntime()` 默认选独立 Node：

1. `AGENTSWS_SIDECAR_RUNTIME=electron` —— 逃生口，明确要求时才借 Electron 自带 Node；
2. `AGENTSWS_NODE` —— 指定 node 可执行文件；
3. **安装包里随包携带的那一份**（WP111 起真的有了：`<resources>/node/bin/node`，
   Windows 上是 `<resources>/node/node.exe`）；
4. `PATH` 上的 `node`。

**WP111 起用户不需要自己装 Node。** `scripts/fetch-node.mjs` 把官方 Node 22 发行包下到
`vendor/node/<平台>/`（sha256 对官方 `SHASUMS256.txt`，哈希签进 `node-runtime.lock.json`），
`extraResources` 把当前平台那一份摆进 `<resources>/node`。第 4 条留着只是兜底
（开发期没跑过脚本、或者捆绑那份被杀毒软件删了）——退化成"要装 Node"比直接起不来好。

**原生模块跟着那份 Node 的 ABI 走。** 捆绑的是 Node 22（`NODE_MODULE_VERSION` 127），
所以 `better_sqlite3.node` 也必须是 v127 那一份——用开发机 Node（可能是 25）编的那份塞进去
只会在用户那儿炸 `ERR_DLOPEN_FAILED`。脚本按 ABI 取官方 prebuild 放进 `vendor/natives/<平台>/`，
`scripts/after-pack.mjs` 在打包那一刻把包里的换掉，然后**用捆绑的 Node 真 import 一遍**
服务进程入口——不通就让打包失败，不发出去。

那个 afterPack 还顺手补一件事：electron-builder 的 pnpm 依赖收集器解析不了带 peer 后缀的
`.pnpm` 目录（`@hono+node-server@2.1.1_hono@4.13.7`），也不跟 `peerDependencies`。
日志里只有一行 `cannot find path for dependency` 就过去了，而 `@hono/node-server` 正是服务进程
listen 用的那一个——WP111 之前打出来的包**装完根本起不来**。afterPack 按 `dependencies` +
非 optional 的 `peerDependencies` 做一次广度优先补齐（一次补 77 个），那个 import 冒烟就是它的门禁。

## 打包

```bash
pnpm --filter @agentsws/desktop fetch-node  # 先把捆绑的 Node 与原生模块下下来（当前平台）
pnpm --filter @agentsws/desktop build       # tsc -b
pnpm --filter @agentsws/desktop package     # electron-builder --dir（不出安装包）
pnpm --filter @agentsws/desktop dist        # macOS .dmg (arm64 / x64) / Windows .exe (NSIS x64)
```

产物在 `apps/desktop/release/`（已 gitignore）。**不签名、不公证**（`identity: null`）；
WP111 起**接了更新源**：`publish: github`、渠道 `beta`（见下面「内测安装与升级」）。`asar: false`——服务进程是以子进程跑的，从 asar 里执行脚本
要额外的 hook，v1 用平铺目录换确定性。

## 内测安装与升级（WP111）

发给一位**非技术用户**的那条路。给她看的一页纸是
[`docs/62-内测安装与升级-v1.md`](../../docs/62-内测安装与升级-v1.md)；这里是我们这一侧。

### 发一版

```bash
git tag v0.1.0-beta.1 && git push origin v0.1.0-beta.1
```

`.github/workflows/release.yml` 接手：四个平台各在自己的机器上打
（windows-latest / macos-14 / macos-13 / ubuntu-latest），版本号**只从 tag 来**
（打包前反写进 `apps/desktop/package.json`），产物与 `latest*.yml` 传到那个 tag 的
GitHub Release（`draft: false`、`prerelease: true`）。

**CI 里没有任何密钥**：上传用 workflow 自带的 `GITHUB_TOKEN`，不签名、不公证
（`CSC_IDENTITY_AUTO_DISCOVERY=false`）。交叉平台打包不做——原生模块与捆绑的 Node
都按平台取，交叉打出来的包我们验不了（`after-pack.mjs` 那道 import 冒烟也只有同平台跑得起来）。

本机试一次（不出安装包、不上传）：

```bash
pnpm --filter @agentsws/desktop fetch-node   # 当前平台
pnpm --filter @agentsws/desktop package
```

### 更新：两个平台两条路，差别是签名定的

| 平台 | 走哪条 | 为什么 |
|---|---|---|
| Windows（NSIS） | **应用内自动更新** | 未签名的 NSIS 照样能自更新。第一位内测用户用 Windows，这是主路径 |
| macOS | 只提示 + 开 Releases 下载页 | Squirrel.Mac 强制校验代码签名，未签名连 `checkForUpdates()` 都过不去 |
| Linux（AppImage） | 只提示 | 顺带发的一档，自动更新没在真机上验过 |

判定在 `src/updater.ts` 的 `updatePolicy()`，连**理由**一起端出来（进日志与诊断包：
"为什么我的 mac 不自动更新"要答得上来）。三个开关：

- `AGENTSWS_DESKTOP_UPDATES=0` —— 一律不查；`=1` —— 开发期也查（调试用）。
- `AGENTSWS_MAC_AUTOUPDATE=1` —— 将来 mac 签名 / 公证做完之后切自动。**默认关**。

**冒烟闸没变**：auto 那条路上下载完先打一次 `GET /v1/health`，不 ok 就停在原地
（`state: 'blocked'`），旧版本继续跑。notify 那条不走 `electron-updater`
（mac 上它连查都过不去），而是一次**匿名** GitHub API GET + 自己比版本。

### 升级安全：动数据之前先备份

真身在 `apps/server/src/upgrade-guard.ts`，在 `createServer()` **之前**跑：

1. 有没有**还原单**（`restore-request.json`）——有就先把那个包导回去。
2. 这次**会不会动数据**——两条判据取并集：`SCHEMA_TARGETS` 里登记的库磁盘版本 <
   代码里的最高版本（精确），或者上次成功启动记的 `release` 变了（兜底，覆盖登记不到的库）。
3. 会动 → 先 `runBackup`，文件名尾巴补 `-from-<旧版本>`，只留最近 5 份。
   **备份失败就不往下走。**

建服务炸了 → **不 listen**，留一张 `upgrade-failed.json`（`stage` 是 `backup` 还是
`migrate`、`data_touched: false`、备份路径）。托盘照着它说"升级没成功，数据没动"，
并多出一项「还原上一份备份」（**只在真出事时出现**）。点了写一张还原单 + 重启 sidecar——
托盘**不自己解 zip**：在一台已经出事的机器上，多一处解压逻辑就是多一处会出事的地方。

启动成功才写 `upgrade-state.json`（上一版是什么、各库到了哪一版）。

### 诊断包

托盘「导出诊断包…」→ 白名单收集（`src/diagnostics.ts` 的 `DIAGNOSTIC_ITEMS`，
一项一项列，不在表上的一律不收）→ **先把清单端给用户看** → 她选存哪儿 →
用 `@agentsws/server` 的 `zipDir` 打包。

收：版本 / 平台 / 架构、更新档位与理由、服务进程跑在哪个 Node、`/v1/health` 原文、
各库迁移版本表、已连连接器的**名字与状态**、模块清单、两份日志各最近 2000 行。

不收：任何凭据、邮件正文、事件负载、知识库内容、数据目录里的**任何库文件**，
以及连接的 `alias` 与身份展示名（那多半就是她的邮箱地址——在 `api-client` 那一层就丢掉，
不是收了再挑）。

### 首次启动

装完第一次打开会**自动把工作台端出来**一次（判据：跑首启向导之前 `config.json` 在不在），
落在工作台自己判出来的「初始化设置」上。之后就恢复成托盘壳，不再自己弹窗。
判定在 `src/first-run.ts`。

## 测试

```bash
pnpm --filter @agentsws/desktop test           # vitest（不碰 Electron）
pnpm --filter @agentsws/desktop test:coverage  # 100% 行覆盖门槛
pnpm --filter @agentsws/desktop build && pnpm --filter @agentsws/desktop e2e   # playwright _electron 冒烟
```

冒烟走的是真路径：起壳 → 托盘在且没有窗口 → `apps/server` 真起在随机端口 →
点"打开工作台" → 窗口拿到 `/v1/health` 的 `status: ok`。
