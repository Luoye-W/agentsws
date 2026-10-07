# @agentsws/desktop

Electron 托盘壳（13 §5「桌面壳改为浏览器打开 + 极小启动器」、34 §2）。**没有任何界面逻辑**：
工作台的 UI 只有一份，由服务进程提供，浏览器与应用内窗口加载的是同一个本地 URL。

托盘做五件事：打开工作台（默认应用内窗口）/ 在浏览器打开 / 暂停（急停）/ 状态 / 退出，
外加重启服务、打开日志目录、开机自启。
WP136 起还有「切换场景」子菜单（dsh 的其他场景由服务进程用捆绑的 Node 起，网址交系统浏览器；docs/79）。

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
| `src/updater.ts` | 更新的平台档位（签名定的）+ notify 档的「只查」 |
| `src/update-controller.ts` `src/update-feed.ts` | WP218：一键更新状态机、更新源规则（见「应用内一键更新」） |
| `src/tray-tint.ts` | WP218：Windows 托盘图标上色（template 图在深色任务栏上看不见） |

除 `main.ts` / `preload.cts` 外**没有一个模块 import `electron`**——所以状态机、退避、密钥、
URL 判定、菜单模型都能在 vitest 里跑满 100% 行覆盖；`main.ts` 由 `e2e/` 的 playwright 冒烟覆盖。

## 用户数据目录

`app.getPath('userData')`（macOS `~/Library/Application Support/@agentsws/desktop`）：

```
config.json     端口 / 是否浏览器打开 / 开机自启 / 语言 / 模式与公司服务器地址 —— 不含任何密钥
secrets.bin     safeStorage 密文（macOS 钥匙串 / Windows DPAPI 背书）
halt.json       急停档位（托盘"暂停"写它）
logs/           desktop.log、server.log（子进程 stdout / stderr，脱敏后）
data/           传给服务进程的 AGENTSWS_DB_DIR
dsh/            WP136：我们自己的 DSH_HOME（dsh 各场景 + 本机凭据库），不是 ~/.dsh；见 docs/79
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
| 桥接 | `notify / openExternal / platform / version`，加 WP184 的 `openScene`、WP218 的 `update`；IPC 只接受本地源窗口发来的调用 |
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

**npm 也跟着带（WP254）。** 同一个脚本再把这版 Node 官方配套的 npm（22.23.2 配 10.9.8；sha512 钉在锁的
`npm` 段，与 registry 的 `dist.integrity` 逐字相同）按官方发行包的布局摆到 `vendor/node/<平台>/lib/node_modules/npm`
（Windows 是 `node_modules/npm`）。服务进程找 npm 先看的就是这里，所以「一键安装 Shopify CLI」「下载连接器」
不再先联网下 npm。安装包大约 +3 MB（npm 的 tgz 2.97 MB，装好后约 11.7 MB、2009 个文件）；afterPack 查它在不在、
版本对不对，本机平台再用捆绑的 Node 跑一次 `npm --version`。

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

## Windows（WP218）

WP218 在 Windows 上查出并修掉的（CI 作业 `desktop-windows.yml` 装起来真跑验它们）：

- **停进程**：Windows 没有 SIGTERM，`kill()` = 直接结束，服务进程的收尾（关场景、关库）永远跑不到，
  它起的场景 `node.exe` 变孤儿、锁住安装目录 → 更新 / 卸载「文件被占用」。现在壳**关 stdin 请服务进程收尾**
  （`AGENTSWS_STOP_ON_STDIN_END=1`），8 秒没退再 `taskkill /T /F` 按进程树强杀；服务进程停场景也按树结束。
- **黑窗口**：服务进程没有控制台，它再起的 headless dsh、git、shopify、cua-driver、bsk 没加 `windowsHide`
  就会各弹一个黑窗口——都加上了。解包用 `%SystemRoot%\System32\tar.exe`（PATH 上的 GNU tar 不认 zip）。
- **环境变量**：子进程白名单补 `PATHEXT`、`ProgramFiles*`、`ProgramData`、`SystemDrive`、`HOMEDRIVE/HOMEPATH`、
  `USERNAME` 等与系统代理；工作用浏览器以前拿到的是空环境。
- **入口判定**：服务进程按真实路径比「我是不是入口」（8.3 短名、盘符大小写不同时以前会直接退出 0、被壳反复重启）。
- **工作目录**：服务进程 `cwd` 固定为用户数据目录（开机自启时 Electron 的 cwd 是 `C:\Windows\System32`）。
- **托盘**：图标染成品牌青绿（黑色 template 图在深色任务栏上看不见）、左键弹菜单；设 AppUserModelId（通知归属）；
  窗口不挂 Electron 默认菜单栏。
- **只听回环**：服务进程、dsh 场景、工作用浏览器的调试口都只开在 `127.0.0.1`，不弹防火墙（CI 里用
  `Get-NetTCPConnection` 查）。
- **中文用户名 / 空格 / 长路径**：路径一律走 UTF-16 参数与环境变量，不经命令行拼接；CI 装到 `智能体 工坊 测试`、
  用户数据放 `agentsws-smoke-数据`，并打印安装目录里最长的路径（≥260 就失败）。
- **连接器不需要 Docker**：桌面版不起 OpenConnector；本机凭据库那 23 张卡（邮箱等）照常用，
  只有标「需要 Docker（可选）」的那 6 张要用户自己装 Docker Desktop（与 mac 一样）。
- **AI 跑命令走 PowerShell**（WP225）：建站与主题那条职责的终端在 Windows 上是官方 `dsh-pwsh-sandbox` +
  `dsh-tool-pwsh`（PowerShell 7 优先，没有就用系统自带的 5.1），不要求装 Git Bash；同一张命令白名单，
  PowerShell 的子表达式 / 脚本块 / 变量整类拒。
- **npm 装的命令行工具**（WP225）：`shopify` / `npx` 是 `.cmd` 壳，服务进程按 PATH + PATHEXT 找到后经
  `cmd.exe /d /s /c` 起（`apps/server/src/win-cli.ts`）；`reg query` 的输出按 OEM 代码页解（中文路径不乱码）。
- **退出等服务进程停干净**（WP225）：壳在 `before-quit` 里等服务进程退（最多 15 秒，8 秒没退按树强杀），
  不先走——强杀的计时器在壳里。
- **CI**（`.github/workflows/desktop-windows.yml`）：`nsis` 作业装起来真跑（WP225 起按进程树 + 目录多种写法认进程、
  原始退出码按十六进制打出来）；`update-e2e` 作业打 N 与 N+1、本机起更新源，真点一次「下载 → 重启并更新」，
  看新版本起来、数据还在。
- **dsh 与官方场景**：用捆绑的 `node.exe` 直接跑 dsh 的 `bin.js`，不经 `.cmd`、不靠 PATH；
  `DSH_HOME` 是 `%APPDATA%\@agentsws\desktop\dsh`。

## 打包

```bash
pnpm --filter @agentsws/desktop fetch-node        # 先把捆绑的 Node 与原生模块下下来（当前平台）
pnpm exec tsc -b                                  # 全仓编译（服务进程要 dist）
pnpm --filter @agentsws/workstation build         # 工作台产物（装进 <resources>/workstation）
pnpm --filter @agentsws/desktop package           # 只出目录、不出安装包（scripts/dist.mjs --dir）
pnpm --filter @agentsws/desktop dist -- --mac --arm64   # 出安装包；架构由命令行给（Windows：--win --x64）
```

产物在 `apps/desktop/release/`（已 gitignore），名字不带空格：`Agents-Workshop-Setup-<版本>-x64.exe`、
`Agents-Workshop-<版本>-<arch>.dmg`、`Agents-Workshop-<版本>-<arch>-mac.zip`（有 zip 才会写 `latest-mac.yml`），
各带一份 `.blockmap`。**不签名、不公证**（`identity: null`）。`asar: false`——服务进程是以子进程跑的，
从 asar 里执行脚本要额外的 hook，v1 用平铺目录换确定性。

**`scripts/dist.mjs` 是唯一的打包入口（WP218）**：它按环境变量与版本号算出这一包的更新源，用
`-c.publish.*` 覆盖 `electron-builder.yml` 里默认那份，并且**一律 `--publish never`**——electron-builder
自己从不上传，上传只由 `release.yml` 做。变量见下面「应用内一键更新 · 更新源」。

**afterPack 的门禁（WP111 → WP218）**：补齐依赖（WP218 起多从 `.pnpm/node_modules` 找，sharp 按平台装的
`@img/sharp-<平台>` 以前一直漏）→ 换原生模块 ABI → 许可证 → 官方插件清单 → **工作台产物在不在**
（WP111 起的包一直没带工作台，装好点「打开工作台」是 404）→ 用捆绑的 Node 冒烟：better-sqlite3 真开一次库、
`sharp` / `koffi` / `node-pty` 真 require 一次、服务进程入口真 import 一次。任何一步不过，打包失败。

**第三方许可证（WP148）**：安装包的 `<resources>/licenses/` 里有三份——`THIRD_PARTY_LICENSES.txt`
（`scripts/third-party-licenses.mjs` 按 `pnpm -F "@agentsws/desktop..." licenses list --prod --json` 生成：
libvips 的 LGPL-3.0 与动态库形态、捆绑的 Node、better-sqlite3 预编译模块写成人话在最前面，
包里真带着的原生二进制逐个列出，然后按许可证汇总、逐包全文）、Electron 的 `LICENSE.electron.txt`、
Chromium 的 `LICENSES.chromium.html`（mac 上 electron-builder 会丢掉后两份，所以由 `after-extract.mjs`
在解包那一刻先存一份）。托盘「开源软件许可」打开的就是那份 txt。**包里带原生二进制、却不在清单里**
的包有一个，打包就失败。单独生成一份看看：`node apps/desktop/scripts/third-party-licenses.mjs <输出路径>`（不联网）。

## 内测安装与升级（WP111）

发给一位**非技术用户**的那条路。给她看的一页纸是
[`docs/62-内测安装与升级-v1.md`](../../docs/62-内测安装与升级-v1.md)；这里是我们这一侧。

### 发一版（WP218）

```bash
git tag v0.2.0-beta.1 && git push origin v0.2.0-beta.1   # beta
git tag v0.2.0 && git push origin v0.2.0                 # stable
```

**只认这两种 tag**（`scripts/release-manifest.mjs tag` 校验，别的一律拒）。版本号**只从 tag 来**
（打包前反写进 `apps/desktop/package.json`）；渠道也由 tag 定：带 `-beta.N` 的是 beta，不带的是 stable。

`.github/workflows/release.yml` 接手：

1. 三台机器各打自己那一份（windows-latest / macos-14 / macos-15-intel）；Windows 那份**装起来真跑一遍**
   （`scripts/win-install-smoke.mjs`），不过就不发；
2. 收拢：两份 `latest-mac.yml` 合成一份、`check` 产物结构、生成官网 `downloads.json`；
3. **同一套产物**传到自有下载站（R2，`dl.agentsws.com/<渠道>/`，**先安装包后 `latest*.yml`**）和
   GitHub Releases（beta 标 prerelease）；
4. 更新根目录的 `downloads.json`（官网读它；哪个渠道上官网由仓库变量 `SITE_DOWNLOAD_CHANNEL` 定，没设 = beta）。

手动触发（workflow_dispatch）**默认 dry_run**：只打包、收拢、自检，整套产物留作 artifact，一个字节都不上传。

**CI 里没有任何真实凭据**：R2 用三个 Actions secrets 的名字（`R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` /
`R2_ACCOUNT_ID`，值由 Luoye 自己填），桶名在仓库变量 `R2_BUCKET`（没设 = `agentsws-downloads`）；
GitHub 用 workflow 自带的 `GITHUB_TOKEN`。不签名、不公证（`CSC_IDENTITY_AUTO_DISCOVERY=false`）。
交叉平台打包不做。

**Windows 真打真跑的 CI 作业**是另一条：`.github/workflows/desktop-windows.yml`（改了桌面 / 服务 / 工作台、
推 `wp/**` 分支或开 PR 时跑；也能手动触发）。它打 NSIS → 静默装到带中文和空格的目录 → Playwright 起装好的
exe（用户数据目录也带中文）→ `/v1/health` 200 → 打开工作台首页截图 → 单实例 → 我们的进程只听回环 →
退出后没有留下进程 → 静默卸载、用户数据还在。安装包、截图与日志都是那次运行的 artifact，**不发布**。

## 应用内一键更新（WP218）

像 Claude / Codex 那样：**工作台左下角（账号区正上方）**一颗按钮，托盘上也有同一项。

```
（没有新版：按钮不出现）
有新版本 ──点──▶ 正在下载 56% ──下完──▶ 重启并更新 ──点──▶（有任务在跑？先问）──▶ 自检 ──▶ 退出、静默装、自动重开
                    │                                        │
                    └──失败──▶ 下载没成功（红，点了重试）      └──自检没过 / 装不上──▶ 没装上（红，点了重试）
```

| 文件 | 管什么 |
|---|---|
| `src/update-controller.ts` | 状态机：`idle → available → downloading → ready → installing`，失败带人话分类（`network` / `not_found` / `checksum` / `disk` / `smoke` / `install`）、可重试；启动 20 秒后查一次，之后每 4 小时 |
| `src/update-feed.ts` | 更新源规则（构建时与运行时同一份）：渠道、下载站地址、`app-update.yml` 的读法、GitHub 备用 |
| `src/updater.ts` | 平台档位（`updatePolicy`，签名定的）与 notify 档的「只查」 |
| `main.ts` | 接线：包 electron-updater、装前确认框、停干净服务进程与场景再 `quitAndInstall(静默, 自动重开)` |
| `bridge-types.ts` / `preload.cts` | `window.agentsws.update`：`status / onChange / download / install`，错误原文不进页面 |
| 工作台 `components/update-button.tsx` | 那颗按钮（普通浏览器里、旧壳、没新版本时不出现） |

几条做法：

- **每一步都等人点**：查到不自动下，下完不自动装，退出时也不偷偷装（`autoInstallOnAppQuit = false`）——
  否则会绕开装前自检。
- **装前确认**照 WP184 退出确认：官方场景在跑、AI 正在操作电脑、或者**岗位 AI 正在干活**
  （WP225：问服务进程 `GET /v1/activity`，跨品牌只回数量；问不到按没有算），先问「有任务在跑，确定现在重启？」；
  选「再等等」按钮留着。
- **装前自检**（WP111 那道闸）：`GET /v1/health` 不 ok 就不装，旧版继续跑。
- **装之前先把服务进程和场景停干净**：Windows 上还开着的 `node.exe` 会让安装程序「文件被占用」。
- **差分下载**：NSIS 出 `.exe.blockmap`，只下变了的块；差分失败 electron-updater 自己退回整包，下完一律校 sha512。
- **数据都在**：用户数据在 `%APPDATA%\@agentsws\desktop`（mac `~/Library/Application Support/@agentsws/desktop`），
  不在安装目录里；NSIS 升级与卸载都不碰它（`deleteAppDataOnUninstall` 默认关）。

### 更新源（Luoye 10-05 定）

| 源 | 角色 | 地址 |
|---|---|---|
| 自有下载站（electron-updater `generic`） | **主源**，应用内只查它 | `https://dl.agentsws.com/<渠道>/latest.yml`（mac `latest-mac.yml`）；安装包、blockmap 在同一目录 |
| GitHub Releases | 镜像（给开源用户下载）+ **备用** | 主源**连不上**（断网、DNS、超时）时退过去查一次；主源回 404 不退 |

- 渠道靠**目录**分（`stable/`、`beta/`），文件名始终是 `latest*.yml`（`detectUpdateChannel: false`），
  运行时也不设 `autoUpdater.channel`（设了它会顺手打开 `allowDowngrade`）。
- **构建时选源**（`scripts/dist.mjs` 读）：`AGENTSWS_UPDATE_PROVIDER=generic|github`（默认 generic）、
  `AGENTSWS_UPDATE_BASE_URL`（默认 `https://dl.agentsws.com`，只认 https）、`AGENTSWS_UPDATE_CHANNEL=stable|beta`
  （不给就按版本号）。结果写进安装包的 `app-update.yml`，运行时照它查。
- **备用开关**：`config.json` 的 `updateGithubFallback`（默认 `true`），环境变量
  `AGENTSWS_UPDATE_GITHUB_FALLBACK=0/1` 优先。

### 版本号与渠道

- 版本号是 semver：`0.2.0`（stable）、`0.2.0-beta.3`（beta）。只从 tag 来。
- 装的是哪个渠道的包，就查哪个渠道的目录；beta 用户在 GitHub 备用那路上也会被提示同号正式版。
- 不降级：查到的版本不比当前新就当没有。

### 平台：差别是签名定的

| 平台 | 走哪条 | 为什么 |
|---|---|---|
| Windows（NSIS） | **应用内一键更新** | 未签名的 NSIS 照样能自更新 |
| macOS | **只提示**：按钮写「有新版本」，点了打开官网下载页 | Squirrel.Mac 强制校验代码签名，未签名连 `checkForUpdates()` 都过不去。读的是下载站的 `latest-mac.yml`（主源连不上退 GitHub API） |
| Linux（AppImage） | 只提示 | release 已不打 Linux 包（WP218），留着这一档 |

判定在 `src/updater.ts` 的 `updatePolicy()`，连**理由**一起进日志与诊断包。三个开关：

- `AGENTSWS_DESKTOP_UPDATES=0` —— 一律不查；`=1` —— 开发期也查（调试用）。
- `AGENTSWS_MAC_AUTOUPDATE=1` —— 将来 mac 签名 / 公证做完之后切自动（mac 包里已经有 zip 与 `latest-mac.yml`）。**默认关**。

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
