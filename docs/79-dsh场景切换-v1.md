# 79 · 在 Agents 工坊里切换 dsh 场景 v1（WP136）

> 状态：**已实现**（分支 `wp/136-dsh-scenes`）。Luoye 09-24 定：dsh 的 Profile 就是「不同的工作场景」；
> Agents 工坊只专注跨境电商 / 出海营销，是 dsh 里的**一个**场景。用户想编程、做别的事，切到 dsh 官方的
> 场景（或自己建的），**不用再单独下载一份 dsh**。其他场景不是我们做的，我们只提供入口，不维护它们。

## 0. 一句话

安装包里本来就带着完整的 dsh（0.1.7-rc.1）和 Node 22（WP111），这一版只是**给用户留了入口**：
托盘「切换场景」、工作台左下角「场景」一行。点官方的 `web` 场景 = 服务进程用捆绑的 Node 起捆绑的
`dsh --profile web`（只听 127.0.0.1、端口系统挑），拿到带一次性 token 的网址交给系统浏览器。

## 1. 有哪些场景（事实全部查自 dsh 0.1.7-rc.1）

| 场景 | 谁维护 | 在这里能做什么 |
|---|---|---|
| **Agents 工坊** | 我们 | 固定第一、默认、打勾。它就是这个工作台本身，**不是** `$DSH_HOME/profiles/` 下的目录——我们的运行时一直是 dsh-adapter 自己搭的最小组合（`harness.ts`，不读 `DSH_HOME`），不走 `dsh --profile` |
| `web` | DeepSeek 官方模板 | 打开 / 重启 / 关闭。dsh 官方的浏览器界面（聊天、模型设置、会话历史、插件管理）|
| 自建（例：`coding`） | 用户自己 | 从官方模板建（选模板、起名），打开 / 重启 / 关闭 / **删除** |
| `headless` `sdk` `sdk-minimal` `acp` | DeepSeek 官方模板 | 只列名字：一个跑完一件事就退出，三个是给程序接的标准输入输出服务，工作台里打不开；新建场景时可以选它们当底子 |

出处：模板表 = `@deepseek-ai/dsh-app-boot` 的 `PROFILE_TEMPLATES`（`packages/dsh-adapter/test/scenes.test.ts`
逐项对照，上游加 / 删 / 改一个模板就红）；`desktop` 名字归 Electron 版 dsh（`dsh` 的 `rejectElectronProfile`）；
名字规则 = `resolveProfileDir`；网页场景的输出与参数 = `dsh-web-app` README「Starting the Web GUI」
（`dsh web: <带 token 的网址>`、`--no-open`、`--port 0`、不能绑全部网卡）。

**新建不启动**：`dsh --profile <名> --from-default-profile <模板> --dump-default-config`——用 dsh 自己的
初始化代码建目录、打印组合、退出（0.2 秒）。名字比 dsh 严：小写字母开头、字母数字短横线、≤32；
`agentsws` / `desktop` / `node_modules` / 五个模板名是保留名。

## 2. 放在哪、和用户另装的 dsh 怎么共存（交付 2）

| 东西 | 位置 |
|---|---|
| 我们的 `DSH_HOME` | `<userData>/dsh`：macOS `~/Library/Application Support/agentsws/dsh`，Windows `%APPDATA%\agentsws\dsh`。与 `data/` **平级**，不在它里面（备份 / 导出不把 dsh 的凭据库和插件打进去） |
| 各场景 | `<userData>/dsh/profiles/<名>/`（官方场景第一次打开时由 dsh 自己初始化） |
| dsh 本机凭据库 | `<userData>/dsh/.credentials.yaml`（`dsh-credentials-local` 的默认位置）——所有场景共用 |
| 其他场景的默认工作目录 | `~/dsh-workspace`（`AGENTSWS_DSH_WORKSPACE` 可改；网页里还能再加别的工作区） |

**用户已有另一份 dsh（`npm i -g @deepseek-ai/dsh`、`~/.dsh`）时**：两边**完全不相干**。

- 我们起的 dsh 一律带 `DSH_HOME=<userData>/dsh`，宿主环境里的 `DSH_HOME` 不继承（白名单里没有它）；
  `~/.dsh` 一个字节都不碰（真 dsh 测试比对了 `~/.dsh` 的 mtime）；
- 用的是**安装包里那一版** dsh（从 dsh-adapter 的依赖解析，不走 PATH），不会被全局那版替掉，也不会去改全局那版的配置；
- 两边各有各的凭据库：在他自己的 dsh 里登录过 DeepSeek，在我们这边还要再登一次（反过来也一样）；
- 端口不撞：我们的网页场景 `--port 0` 由系统挑。

没有数据目录的全内存档（测试 / 一次性任务）与托管档、Docker 档**不装配**场景切换（`available: false`，
左栏那一行不出、托盘那一项不出）——dsh 起在哪台机器上，场景就是哪台机器的，只有本机档有意义。

## 3. 起、停、状态（交付 1）

- **谁起**：服务进程（`apps/server/src/dsh-scenes.ts`）。它本身就跑在捆绑的 Node 上（桌面壳
  `resolveServerRuntime`），所以 `process.execPath` 就是捆绑的 Node；启动器是 `@deepseek-ai/dsh` 的
  `lib/bin.js`。命令：`<捆绑 Node> <dsh bin.js> --profile <名> --no-open --host 127.0.0.1 --port 0`，
  工作目录 = 工作区根。包内实测：`ps` 看到的就是 `<resources>/node/bin/node`。
- **就绪**：读到 stdout 那一行 `dsh web: http://127.0.0.1:<端口>/?token=…`（只认回环）；60 秒没读到算没起来，杀掉。
- **网址里的 token**：只出现在 `open` / `restart` 的响应体里，交给打开它的那一方（桌面壳 `shell.openExternal`、
  浏览器里预开的标签页）。服务端日志只记抹掉 token 的网址。
- **关闭**：SIGTERM，8 秒不退再 SIGKILL（dsh 自己的关机上限是 5 秒）。服务进程关闭时把起过的场景全停掉；
  demo 实测关掉后没有残留进程。
- **状态**：`stopped` / `starting` / `running` / `failed`（带一句为什么，取 dsh stderr 最后一行，抹过 token）。

接口（`packages/api/src/routes/dsh-scenes.ts`，权限与浏览器设置同档：读 `store_config.read`、改 `policy.stage`，只有所有者）：

| 路由 | 做什么 |
|---|---|
| `GET /v1/dsh-scenes` | 列表 + dsh 版本 + `DSH_HOME` + 工作区根 + 可选模板 |
| `POST /v1/dsh-scenes` | 新建（`{name, template}`，只建不起）|
| `DELETE /v1/dsh-scenes/:name?confirm=<name>` | 删自建场景：先停，只删 `$DSH_HOME/profiles/<name>`（目录是链接就只拆链接）|
| `POST /v1/dsh-scenes/:name/open` | 网页场景：没起就起，回 `{scene, url}` |
| `POST /v1/dsh-scenes/:name/stop` / `restart` | 关 / 重启 |

## 4. 边界（交付 3）

**锁定只管 Agents 工坊。** `profiles/agentsws/cordis.patch.yml` 的七行锁定、`profile-lockdown.test.ts`
一个字没动；其他场景**不带任何我们的 patch**，按 dsh 默认运行——插件管理、HMR、DeepSeek 账号登录、
会话日志随官方接口上报（`session-log-deepseek` 默认开）、匿名遥测都照 dsh 官方的默认。界面上每个其他场景
下面都有一句：「这个场景由 DeepSeek 官方维护，Agents 工坊不对它负责。」唯一的例外是**用户自己**在宿主环境里设了
`DSH_TELEMETRY_DISABLED`，我们照样传下去（不替他打开）。

**我们的业务数据与密钥它们够不着**（`apps/server/test/dsh-scenes.test.ts` 的「边界」组，用假 dsh 把它看到的
环境与工作目录原样写出来再断言）：

- 工作区根**既不在也不包含**我们的数据目录、应用数据目录、`DSH_HOME`，违反就不装配；
- 环境变量**白名单继承**（`SCENE_INHERITED_ENV`：系统必需的、代理、遥测开关），名字里带
  KEY / TOKEN / SECRET / PASSWORD / SESSION 的再挡一遍——我们的四把密钥（会话、秘密库、连接器两把）、
  `AGENTSWS_*`、宿主的 `DEEPSEEK_API_KEY` 一个都带不过去；
- 客户、红人、积分、密钥在 `data/` 与加密库（`secrets.bin` 是 safeStorage 密文，秘密库整库加密）。

**做不到的**（说在前面）：官方网页里用户可以**自己**再添加任意工作区目录；他要是亲手把
`~/Library/Application Support/agentsws/data` 加进去，那个场景就读得到我们没加密的 SQLite 文件。
我们保证的是「默认不指向、不给钥匙」，不是「操作系统层隔离」。

## 5. 共享：DeepSeek 账号登录一次，所有场景都能用（交付 4）

桌面壳把同一个 `<userData>/dsh` 既作为 `AGENTSWS_DSH_HOME`（场景目录）、也作为 **`DSH_HOME`** 交给服务进程。
所以 WP134（DeepSeek 账号登录，未合入）如果在 Agents 工坊里挂官方的 `dsh-credentials-local` /
`dsh-deepseek-account`，默认就落在 `<userData>/dsh/.credentials.yaml`——与官方 `web` 等场景读的是**同一份**，
登录一次即可。WP134 要注意的只有一条：headless 子进程（`packages/dsh-adapter/src/headless/subprocess.ts`
的 `ENV_ALLOWLIST`）目前不继承 `DSH_HOME`，如果它在子进程里读凭据，要把 `DSH_HOME` 加进那张表。

**评估：把「Agents 工坊官方积分接口」当作其他场景的一个模型来源**（本单不实现）

- 做法：dsh 官方网页的「Settings → Models」接受一个 **Messages 兼容的 API 地址 + 凭据引用**（`dsh-web-app`
  README）。所以 ① 云端积分网关要有一个 Anthropic Messages 兼容的端点（按调用扣积分）；② 本机把一个 provider 行写进
  `$DSH_HOME/cordis.patch.yml`（home 层 patch，**所有场景都生效**，dsh 组合顺序里它排在各 profile 自己那层之后），
  凭据写进 `.credentials.yaml`（用 dsh 自己的凭据接口写，不自己拼 YAML）；③ 工作台场景面板加一个开关「让其他场景也用我的积分」。
- 工作量：约 **3–5 人日**。大头在云端那个 Messages 兼容端点（流式、工具调用、计量扣费、限流）；本机与界面 1 天。
- 风险 / 要想清楚的：令牌交给了一个我们不维护的程序（可被它的插件读到）→ 要用**单独一把、只能调模型、可随时吊销**
  的令牌，额度单独封顶；其他场景的用量要在账单上分开列，不然用户会以为是 Agents 工坊在花钱。

## 6. 安装包体积（交付 6）

实测（`pnpm -F @agentsws/desktop package --dir`，macOS arm64）：在打包后的 `app/node_modules` 上建依赖图，
摘掉 `@deepseek-ai/dsh-web-app` 前后各算一遍可达集——**只为官方 web 场景而在的包 78 个，未压缩 24.8 MB，
gzip 约 7.6 MB**（最大的是 `dsh-client-ui-sidebar-documentpreview` 13.8 MB、`dsh-web-frontend` 4.6 MB）。
整个 `app/` 263 MB、捆绑的 Node 112 MB。

**差值 < 50 MB，照单子留在安装包里，不做「首次打开时下载」。** 而且这些包 WP111 起就在包里了——`@deepseek-ai/dsh`
的 `dependencies` 本来就有 `dsh-web-app`，after-pack 的依赖补齐会把它整棵带进来；WP136 没有改任何 `package.json`，
给安装包加的只有我们自己几个文件（KB 级）。

## 7. 入口（交付 5）

- **托盘**：「切换场景 ▸」子菜单在「打开工作台 / 在浏览器打开」下面——Agents 工坊（打勾）、各网页场景（在跑的挂「运行中」）、
  「管理场景…」（打开 `/?scenes=1`，工作台看到这个参数就把面板展开）。连公司服务器、服务没起来、问不到清单时这一项不出现。
  清单 15 秒问一次。点一个网页场景 = `POST …/open` → `shell.openExternal(网址)`；起不来弹一句人话。
- **工作台**：左栏最下面、账户块上方一行「场景」（一个图标、两个字；有其他场景在跑时右边一个绿色数字）。点开是朝上的小面板：
  每个场景一行（官方 / 自建标签、状态胶囊、打开 / 重启 / 关闭 / 删除）、官方维护那句话、命令行场景一行名字、「新建场景」。
  删除要再输入一遍名字才点得动，并说明「只删这个场景自己的文件夹，Agents 工坊的数据不受影响」。只有所有者看得到。

截图：`docs/assets/workstation/dsh-scenes-entry.png`、`dsh-scenes-panel.png`、`dsh-scenes-delete.png`、
`dsh-scenes-web-opened.png`（官方 web 场景在浏览器里打开的样子）。

## 8. 待定

1. 其他场景「按 dsh 默认」意味着**会话日志上报与匿名遥测是开的**（那是 DeepSeek 官方的默认）。要不要在我们起它们时默认带上
   `DSH_TELEMETRY_DISABLED=1`？（单子写的是按默认，这一版没带。）
2. 默认工作目录 `~/dsh-workspace` 这个名字 / 位置行不行（非技术用户可能更习惯「文稿」下面）。
3. 第 5 节的积分接口作为其他场景模型来源，做不做、什么时候做。
