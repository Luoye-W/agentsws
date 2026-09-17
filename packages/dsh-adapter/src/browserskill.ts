/**
 * 第二种浏览器：**你正在用的那个浏览器**（腾讯 BrowserSkill，55 §10，WP92）。
 *
 * 与 WP82 那一种（官方 Playwright provider 起一个单独的 Chrome）并列，一次运行只挂一种。
 * 工具面**一个字都不是我们写的**：它来自腾讯官方的 dsh 插件
 * `@wxg-prc-cpg/browser-skill-dsh-plugin`（MIT，`Tencent/BrowserSkill`），插件 spawn
 * 本机的 `bsk` CLI，CLI 经 daemon 与浏览器扩展说话，扩展用 `chrome.debugger` 附到
 * **用户自己的浏览器**上。我们这一侧仍然只剩策略，而策略与官方 provider 那一份是
 * **同一套**（55 §3 那张表），只是落点不同：
 *
 * | 策略 | 官方 provider（WP82） | BrowserSkill（WP92，这个文件） |
 * |---|---|---|
 * | 读写分类 | 按**工具名**判（24 个名字） | 按 `args.action` 判（6 个多态工具，见 {@link BROWSERSKILL_READ_ACTIONS}） |
 * | 域名白名单 | `browser_navigate` / `browser_tabs{new}` 两处 url | 三处：`browser_page{navigate}` / `browser_session{start}` / `browser_tabs{create}` |
 * | 注 JS 公司端硬拒 | `browser_evaluate` / `browser_run_code_unsafe` | 工具面里**没有** evaluate；`bsk evaluate` 这条 CLI 归 shell allowlist（WP89）管 |
 * | 人接管 | 只能写进提示词（官方没有这个语义） | 插件自带 `browser_assist{request-help}`：放行，并在时间线上记一条 `browser_handoff` |
 *
 * 凭据不经模型（13 §4）在这一种下更直接：页面是用户自己的浏览器里那一个，登录态、
 * cookie、密码从头到尾在他自己的浏览器里，Agent 只看得见"已登录"这个结果。
 */
import { accessSync, constants, statSync } from 'node:fs'
import type { RunBrowser } from '@agentsws/contracts'
import { hostAllowed } from '@agentsws/contracts'
import type { ToolSideEffect } from './types.js'

/** 上游 npm 包名（锁死 0.3.0，见 `pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude`）。 */
export const BROWSERSKILL_PLUGIN = '@wxg-prc-cpg/browser-skill-dsh-plugin'

/**
 * 插件注册的**六个**模型可见工具（`browser-tools.ts` 的 `BROWSER_TOOL_SPECS`）。
 *
 * 注意它们是**裸名**，没有 `mcp__…__` 前缀——插件走的不是官方 `dsh-browser-use` seam，
 * 而是直接 `ctx.tools.register`（55 §10 已核实的那一条）。所以
 * {@link browserSkillToolName} 判的是"在不在这张表里"，不是判前缀。
 */
export const BROWSERSKILL_TOOLS: readonly string[] = [
  'browser_assist',
  'browser_inspect',
  'browser_interact',
  'browser_page',
  'browser_session',
  'browser_tabs',
]

const TOOL_SET: ReadonlySet<string> = new Set(BROWSERSKILL_TOOLS)

/**
 * **读**的动作表（55 §10 那张表）。一个工具管好几件事，所以判定看的是 `args.action`。
 *
 * 表外的动作（上游新增的、或者模型没给 `action`）一律按**写**——与 WP82 同一条最严纪律：
 * 新来的动作默认进不了公司端，要先有人把它写进这张表、同时决定它是读还是写。
 *
 * 逐条的理由：
 * - `browser_inspect`：六个动作全是看页面（observe / snapshot / html / screenshot /
 *   console / network），一个都不碰外面；
 * - `browser_page`：导航算**读外部**——打开一个网页就是"去外面读一份东西"（55 §3 原话），
 *   真正管住它的是域名白名单。back / forward / reload / wait 同理；
 * - `browser_session`：start 开的是一个**独立的 Agent 窗口**（不是用户那个标签），
 *   stop 关的是自己开的那个，list 只是看一眼——都不改外面世界的任何东西；
 * - `browser_tabs`：list / select 是读；create / close 改的是浏览器里的东西，
 *   borrow / return 更是**把用户自己的标签搬进 Agent 窗口**，一律按写；
 * - `browser_interact`：点击、输入、选择、按键——全是写；
 * - `browser_assist`：resize / emulate 只改显示；`request-help` 是**请人接管**
 *   （弹一层让用户自己操作），它本身不替用户动手，所以按读放行（另见
 *   {@link isBrowserSkillHandoff}：放行的同时在时间线上记一条）。
 */
export const BROWSERSKILL_READ_ACTIONS: Readonly<Record<string, ReadonlySet<string>>> = {
  browser_assist: new Set(['resize', 'emulate', 'request-help']),
  browser_inspect: new Set(['observe', 'snapshot', 'html', 'screenshot', 'console', 'network']),
  browser_interact: new Set<string>(),
  browser_page: new Set(['navigate', 'back', 'forward', 'reload', 'wait']),
  browser_session: new Set(['start', 'stop', 'list']),
  browser_tabs: new Set(['list', 'select']),
}

/** 是不是 BrowserSkill 的工具；是就回它自己的名字，不是回 `undefined`。 */
export function browserSkillToolName(tool: string): string | undefined {
  return TOOL_SET.has(tool) ? tool : undefined
}

/** 一次调用的动作名（模型没给、或者给了个非字符串 = `undefined` = 按写兜底）。 */
function actionOf(args: Record<string, unknown> | undefined): string | undefined {
  const action = args?.action
  return typeof action === 'string' ? action : undefined
}

/** 按 `args.action` 判读写（表外一律写；16 §3 最严）。 */
export function classifyBrowserSkillEffect(
  short: string,
  args?: Record<string, unknown>,
): ToolSideEffect {
  const reads = BROWSERSKILL_READ_ACTIONS[short]
  const action = actionOf(args)
  if (reads === undefined || action === undefined) return 'write_external'
  return reads.has(action) ? 'read_external' : 'write_external'
}

/**
 * 会打开一个新地址的**三处**（55 §10）：
 *
 * | 工具 | 动作 | url 参数 |
 * |---|---|---|
 * | `browser_page` | `navigate` | 必填 |
 * | `browser_session` | `start` | 选填（不给 = 开个空白的 Agent 窗口） |
 * | `browser_tabs` | `create` | 选填（不给 = 开个空白标签） |
 *
 * 回 `undefined` = 这次调用没有"要打开的地址"，白名单这一关没话说；
 * 回 `''` = 该给地址却没给（`browser_page{navigate}`），按"打不开这个地址"拒。
 * 别的动作（点击、回退）也可能走到别的站上去，但它们的入参里没有 URL——
 * 判不出来的那些由读写分类兜底。
 */
export function browserSkillNavigationUrl(
  short: string,
  args: Record<string, unknown>,
): string | undefined {
  const action = actionOf(args)
  const url = typeof args.url === 'string' ? args.url : undefined
  if (short === 'browser_page' && action === 'navigate') return url ?? ''
  if (short === 'browser_session' && action === 'start') return url
  if (short === 'browser_tabs' && action === 'create') return url
  return undefined
}

/** 这次调用是不是"请人接管"（`browser_assist{action:'request-help'}`）。 */
export function isBrowserSkillHandoff(short: string, args: Record<string, unknown>): boolean {
  return short === 'browser_assist' && actionOf(args) === 'request-help'
}

export interface BrowserSkillPolicyInput {
  /** 工具名（裸名）。 */
  tool: string
  args: Record<string, unknown>
  /** `RunRequest.allowed_hosts`；空 / 不给 = 一个站都不许开。 */
  allowedHosts: readonly string[] | undefined
  /** `RunRequest.tools.side_effect_policy`。公司端是 `executor`。 */
  policy: 'personal' | 'executor'
}

/** 白名单说给人听的那一句（与官方 provider 那一条逐字同一套措辞）。 */
function hostsSentence(allowed: readonly string[]): string {
  const head = allowed.slice(0, 3).join('、')
  return allowed.length > 3 ? `${head} 等 ${allowed.length} 个站` : head
}

/**
 * 域名白名单：三处 url 一处不漏（规则与官方 provider 同一套）。
 *
 * 回 `undefined` = 这一关没话说（接着走读写分类那一关）；回字符串 = 拒，
 * 字符串就是给人看的原因（门禁把它物化成 `tool.result{blocked}` 进事件日志）。
 *
 * 这里**没有**"注 JS 公司端硬拒"那一条：BrowserSkill 的工具面里压根没有 evaluate
 * （55 §10 已核实）。能跑脚本的是 `bsk evaluate` 这条 CLI，管它的是 shell 的命令
 * allowlist（WP89），不是浏览器门禁——两边各管各的，不重复实现。
 */
export function checkBrowserSkillPolicy(input: BrowserSkillPolicyInput): string | undefined {
  const short = browserSkillToolName(input.tool)
  if (short === undefined) return undefined
  const raw = browserSkillNavigationUrl(short, input.args)
  if (raw === undefined) return undefined
  const allowed = input.allowedHosts ?? []
  if (allowed.length === 0) {
    return 'browser_scope_empty: 这个岗位没有开放任何网站，所以打不开网页'
  }
  let host: string
  try {
    host = new URL(raw).hostname
  } catch {
    return `browser_bad_url: 打不开这个地址（${raw === '' ? '空地址' : raw}）`
  }
  if (!hostAllowed(host, allowed)) {
    return `browser_host_not_allowed: 这个岗位只能打开 ${hostsSentence(allowed)}，${host} 不在里面`
  }
  return undefined
}

/**
 * 插件的 Config（上游 `index.ts` 的 `Config`），四项与缺省**有意不同**：
 *
 * - `lazyTools: false`。上游缺省是 `true`：六个工具**要等 `browser-skill` 这个技能被
 *   成功调用过一次**才注册（progressive disclosure）。我们的组合里没有 `dsh-skill` /
 *   `dsh-tool-skill`，那个触发器一辈子不会响——实测 `lazyTools: true` 时
 *   `ctx.tools.schemas(agent)` 是**空的**（一个浏览器工具都没有）。所以这里必须 `false`。
 * - `observationEnabled: false`。那是给 dsh 自己的 web 客户端做画中画悬浮层用的：
 *   每 1.5 秒截一次屏、经 loopback 的 SSE 路由推出去。我们是 headless 运行，
 *   没有那张界面，开着只是白截屏（而且截屏是用户屏幕上的内容，不开更干净）。
 * - `maxSessions: 1`。55 §3「一 Session 一浏览器」那一行：一次运行只允许占一个
 *   Agent 窗口，与 17 §5.1「一次运行一棵树」一致。
 * - `bskPath` 指的是**我们自己装的那一份**（`AGENTSWS_DATA_DIR/bin/bsk`，钉版本 +
 *   sha256，见 `browserskill.lock.json`），不是 PATH 上那个。
 */
export interface BrowserSkillPluginConfig {
  bskPath: string
  lazyTools: false
  observationEnabled: false
  maxSessions: 1
}

/** `RunRequest.browser`（`mode: 'browserskill'`）→ 插件的 Config。 */
export function browserSkillPluginConfig(browser: RunBrowser): BrowserSkillPluginConfig {
  if (browser.mode !== 'browserskill') {
    throw new Error(`browserSkillPluginConfig: 不是 browserskill（${browser.mode}）`)
  }
  return {
    bskPath: browser.bsk_path ?? 'bsk',
    lazyTools: false,
    observationEnabled: false,
    maxSessions: 1,
  }
}

/**
 * daemon 的清单地址。指到一个**没人监听的回环端口**，等于"查不到更新"。
 *
 * 为什么要有这一条，见 {@link applyBskEnv} 的第二段：`BSK_AUTO_UPDATE=off` 只关掉
 * "装"，**没关掉"查"**。
 */
export const BSK_NO_UPDATE_MANIFEST = 'http://127.0.0.1:1/agentsws-no-update-check.json'

/**
 * 把 `bsk` 的两个更新开关按我们的纪律设好（55 §10 / 16 §1）。
 *
 * 插件 spawn 子进程时**不传 `env`**（非 Windows 分支给的是 `undefined`），也就是
 * 原样继承我们这个进程的环境——所以这两条只能在挂插件之前写进 `process.env`。
 *
 * 两条，管的不是同一件事（**实测出来的，不是照 README 抄的**）：
 *
 * 1. `BSK_AUTO_UPDATE=off` 关的是**装**：daemon 发现新版本也不会把自己换掉。
 *    这一条是安全上最要紧的那一条——"自己把自己换掉"绕开了我们钉的版本与 sha256
 *    （`browserskill.lock.json`），版本什么时候升由上游哨兵说了算，不由后台任务。
 * 2. `BSK_UPDATE_MANIFEST_URL` 关的是**查**。本机实测：把 `BSK_AUTO_UPDATE=off`
 *    设上之后 daemon **照样**每 30 分钟去 GitHub 取一次 version.json，并把结果写进
 *    `~/.bsk/update-check.json`（上游 `daemon/start.rs` 的 `spawn_update_check_task`：
 *    `auto_update_enabled` 只喂给 `auto_update_step` 那一跳，`refresh_update_cache`
 *    在它之前就发生了）。那是一条我们没批准过的出网，所以把清单地址指到回环。
 *
 * 一条**管不到**的情况，得说清楚：daemon 要是**早就在跑**（用户自己装过 `bsk`、
 * 先用别的方式起过），它继承的是当初那个环境，我们这次设的两条对它无效。
 * 设置页第 ③ 步的 `bsk doctor` 会把在跑的那个 daemon 报出来，能看得见。
 *
 * 写死覆盖（不是"没设才设"）：这是纪律不是偏好，进程里本来有个 `on` 也一样关掉。
 */
export function applyBskEnv(env: NodeJS.ProcessEnv = process.env): void {
  env.BSK_AUTO_UPDATE = 'off'
  env.BSK_UPDATE_MANIFEST_URL = BSK_NO_UPDATE_MANIFEST
}

/**
 * `bsk` 这个文件在不在、能不能执行。
 *
 * **挂插件之前必须问这一句**，理由是实测出来的一条硬伤：`bskPath` 指到一个不存在的
 * 文件时，插件在加载时会 spawn 一次 `bsk --version` 探活；这个子进程 spawn 失败
 * （ENOENT）但仍被记进它的 in-flight 表，于是插件卸载时 `killAll()` 对一个**没有
 * pid** 的子进程调 `child.kill('SIGINT')`——信号落到**我们自己这个进程组**上，
 * 整个服务进程当场收到 SIGINT 退出。（复现步骤与结论见 AGENT-LAYER §9.7。）
 *
 * 所以纪律是：**装好了才挂**。没装就根本不给 `RunRequest.browser`，
 * 这条职责这次运行就没有浏览器——与"没配浏览器"是同一种结果，也是安全的那一侧。
 */
export function bskBinaryUsable(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * 写进提示词的那一段（persona 的 `complete` 段里，接在 `browserBrief()` 后面）。
 *
 * 三件这一种方式**独有**、模型自己判不出来的事：操作发生在哪个窗口、
 * 动用户已经开着的标签要先问、卡住了可以请人接管（而不是自己猜密码）。
 */
export function browserSkillBrief(): string {
  return [
    '- 你用的是**用户自己那个浏览器**：他登录过的站你直接就看得到，别去登录、别去注册。',
    '- 你的操作都在一个**单独的 Agent 窗口**里（`browser_session{action:"start"}` 开的那个）。' +
      '要用用户已经开着的标签，得 `browser_tabs{action:"borrow"}` 借过来——' +
      '那会打断他手上的事，用完立刻 `return` 还回去。',
    '- 卡住了（要登录、要验证码、要他确认）就用 `browser_assist{action:"request-help"}` ' +
      '请本人接管，把要他做什么写清楚；不要自己猜、不要替他填。',
  ].join('\n')
}
