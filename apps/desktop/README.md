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
| `src/updater.ts` | electron-updater 骨架 +「冒烟不过不切换」 |

除 `main.ts` / `preload.cts` 外**没有一个模块 import `electron`**——所以状态机、退避、密钥、
URL 判定、菜单模型都能在 vitest 里跑满 100% 行覆盖；`main.ts` 由 `e2e/` 的 playwright 冒烟覆盖。

## 用户数据目录

`app.getPath('userData')`（macOS `~/Library/Application Support/agentsws`）：

```
config.json     端口 / 是否浏览器打开 / 开机自启 / 语言 —— 不含任何密钥
secrets.bin     safeStorage 密文（macOS 钥匙串 / Windows DPAPI 背书）
halt.json       急停档位（托盘"暂停"写它）
logs/           desktop.log、server.log（子进程 stdout / stderr，脱敏后）
data/           传给服务进程的 AGENTSWS_DB_DIR
```

`AGENTSWS_DESKTOP_USER_DATA` 可以把整个目录挪走（开发与 e2e 用）。

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
3. 安装包里随包携带的 `<resources>/node`（v1 还没往里放，见下）；
4. `PATH` 上的 `node`。

**所以 v1 的安装包要求机器上有 Node ≥ 22。** 要做到"一个安装包把运行时带齐"，下一步二选一：
往 `extraResources` 里塞一份独立 Node 运行时；或等 `better-sqlite3` 能编过 Electron 44
（也可以换 `node:sqlite`）之后切回 Electron 自带 Node。

## 打包

```bash
pnpm --filter @agentsws/desktop build     # tsc -b
pnpm --filter @agentsws/desktop package   # electron-builder --dir（不出安装包）
pnpm --filter @agentsws/desktop dist      # macOS .dmg (arm64) / Windows .exe (NSIS x64)
```

产物在 `apps/desktop/release/`（已 gitignore）。v1 **不签名、不公证、不接更新源**：
`identity: null`、`publish: null`。`asar: false`——服务进程是以子进程跑的，从 asar 里执行脚本
要额外的 hook，v1 用平铺目录换确定性。

## 测试

```bash
pnpm --filter @agentsws/desktop test           # vitest（不碰 Electron）
pnpm --filter @agentsws/desktop test:coverage  # 100% 行覆盖门槛
pnpm --filter @agentsws/desktop build && pnpm --filter @agentsws/desktop e2e   # playwright _electron 冒烟
```

冒烟走的是真路径：起壳 → 托盘在且没有窗口 → `apps/server` 真起在随机端口 →
点"打开工作台" → 窗口拿到 `/v1/health` 的 `status: ok`。
