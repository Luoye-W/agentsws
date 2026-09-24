import type { ProvenanceState } from './changes.js'
import type {
  AssignmentId,
  Iso8601,
  ObjectRef,
  PersonId,
  RoleId,
  RunId,
  Sensitivity,
  WorkspaceId,
} from './common.js'
import type { WorkspaceVertical } from './identity.js'

/** 17 §1 RunRequest：协同服务 → 运行时适配器。无状态：运行自带全部上下文。 */
export type RunKind =
  | 'work_item'
  | 'scheduled'
  | 'workflow_step'
  | 'extraction'
  | 'reflection'
  | 'dev_task'
  | 'simulation'

export interface ContextItem {
  id: string
  kind:
    | 'customer'
    | 'thread'
    | 'order'
    | 'fact_card'
    | 'memory'
    | 'summary'
    | 'prefetch'
    | 'app_events'
    | 'policy'
    /** WP17：已确认的业务边界（优先级高于爬来的政策页） */
    | 'boundary'
    /** WP22 / 37 §2.2b：事项的「到哪了」摘要，事项续跑时注入（direct-llm 没有会话文件，靠它接上） */
    | 'matter_summary'
  source_ref: ObjectRef | string
  sensitivity: Sensitivity
  content: unknown
  bytes: number
}

export interface GroundingRule {
  name: string
  intent_terms: string[]
  cue_terms: string[]
  tool: string
  prefetch: boolean
}
export interface PromptSection {
  id: string
  name: string
  order: number
  text: string
}
export interface SkillRef {
  name: string
  min_version?: string
  tier: 'open' | 'premium'
  load: 'always' | 'on_demand'
}
export interface ModelRef {
  provider: string
  model: string
  region?: 'cn' | 'global'
}

/**
 * 55 §3 / WP82：这次运行怎么开浏览器。工具面全部来自官方
 * `dsh-browser-use` + Playwright MCP provider，我们这一侧只剩**策略**——
 * 这个字段就是策略的前半截（开不开、怎么开），后半截是 {@link RunRequest.allowed_hosts}。
 *
 * 两种方式，对应上游 provider 的两种 `mode`：
 * - `attach`：接用户自己电脑上已经开着的那个 Chrome（`--remote-debugging-port` 开出来的
 *   CDP 地址）。登录态、标签都是用户自己的，密码只在他自己的浏览器里输（13 §4：
 *   凭据不经模型）；收尾只断连不关浏览器。**只有个人档（本机运行）允许**。
 * - `launch`：起一个独立的 Chromium。`executable_path` 指本机已装的 Chrome / Chromium——
 *   必须指，因为我们没给 playwright 的 postinstall 开构建（16 §3），它自己下不到浏览器。
 */
export type RunBrowser =
  | {
      mode: 'attach'
      /** CDP 地址：`http(s)://…` 或 `ws(s)://…`（上游 `validateBrowserMcpConfig` 的口径）。 */
      endpoint: string
    }
  | {
      mode: 'launch'
      /** 本机 Chrome / Chromium 的可执行文件路径。 */
      executable_path?: string
      /** 不给 = `true`（上游默认）。 */
      headless?: boolean
    }
  | {
      /**
       * 55 §10 / WP92：**用户正在用的那个浏览器**（腾讯 BrowserSkill）。
       *
       * 工具面来自腾讯官方的 dsh 插件（`@wxg-prc-cpg/browser-skill-dsh-plugin`）：
       * 它 spawn 本机的 `bsk` CLI，CLI 经 daemon 让浏览器扩展用 `chrome.debugger`
       * 附到用户自己的 Chrome / Edge 上，每个 Session 一个独立的 Agent 窗口；
       * 要动用户已经开着的标签得先"借"，借要他点头。
       *
       * 与 `attach` 的差别：`attach` 接的是**我们替他另起的**那个 Chrome（单独 Profile，
       * 不带他日常的登录态）；这一种用的就是他**日常那个**浏览器，所以他登录过的东西
       * Agent 直接看得到。**只有个人档允许**（服务得跟浏览器在同一台电脑上）。
       */
      mode: 'browserskill'
      /**
       * `bsk` 可执行文件的路径。不给 = 从 PATH 上找 `bsk`（上游默认）。
       * 我们自己装的那一份在 `AGENTSWS_DATA_DIR/bin/bsk`（钉版本 + sha256，
       * 见仓库根的 `browserskill.lock.json`）。
       */
      bsk_path?: string
    }

/**
 * WP89（55 §8 Q7）：这次运行**在沙箱里跑命令**的那一层。
 *
 * 与 {@link RunBrowser} 同一条纪律：**不给 = 这条职责没有终端**——运行时连
 * `dsh-tool-bash` / `dsh-sandbox` 都不挂，工具面里一个 `bash` 都不存在。
 * 只有建站与主题这条职责（`site.shopify-theme`，别名 `site.builder`）才给。
 *
 * 工具面一个字都不是我们写的：官方 `dsh-tool-bash` + `dsh-bash-sandbox` +
 * `dsh-sandbox-local`（macOS Seatbelt / Linux bwrap→Landlock / Windows 受限令牌）。
 * 我们这一侧只剩三样：**档位**（这里）、**命令 allowlist**（`dsh-adapter` 的
 * `shell.ts`）、**凭据怎么进子进程**（`token_record` / `env_refs`，13 §4）。
 */
export interface RunShell {
  /**
   * 沙箱根 = 这个品牌这家店的**主题工作副本目录**（绝对路径，不存在就由运行时建）。
   * 它同时是 dsh 会话的 `cwd`——官方 `sandbox-policy` 按会话 cwd 定 `workspace-write`
   * 的可写边界，所以这两个必须是同一个路径。
   */
  workspace_root: string
  /**
   * 档位。**故意没有 `danger-full-access`**（55 §8 那一行）：契约里根本拼不出来，
   * 就不会有人在配置里手滑打开它。升档的路也堵死了——`bash` 工具的
   * `sandbox_permissions` 由门禁一律拒。
   */
  mode: 'read-only' | 'workspace-write'
  /** 店铺域名（`xxx.myshopify.com`）：进子进程的 `SHOPIFY_FLAG_STORE`。 */
  store?: string
  /**
   * CLI 令牌在 `ctx.credentials` 里的**记录地址**（`<owner>/<id>`，由服务端用
   * `connectionCredentialKey(workspace_id, 'shopify')` 算好）。
   *
   * **这里只有地址，没有值**（13 §4）：运行时在真要跑那条命令的前一跳
   * `readRecord()` 取出来，直接交给那一条命令的子进程（经执行器的显式 `env`，
   * 见 `dsh-adapter` 的 `shell.ts`——**值一次都不进宿主进程的环境**），命令跑完即清。
   * 地址写在契约里、值不写，于是回放包、事件日志、模型面三处都只看得见一个 `<owner>/<id>`。
   */
  token_record?: string
  /**
   * 额外的**环境变量名 → 凭据引用名**（本机引用层，`ctx.credentials.resolve()`）。
   * 同样只有名字。
   */
  env_refs?: Record<string, string>
}

/**
 * WP82（55 §3 末段）：**这台机器上**的浏览器怎么配（`/v1/settings/browser` 的形状）。
 *
 * 为什么是"这台机器"而不是"这个品牌"：attach 接的是用户自己电脑上那个 Chrome，
 * 它与卖哪个品牌无关；同一台机器上的所有品牌用同一个浏览器设置。
 */
export interface BrowserSettings {
  /** `off` = 谁都不许开浏览器（缺省）。 */
  mode: 'off' | 'attach' | 'launch' | 'browserskill'
  /** `attach`：本机 Chrome 的 CDP 地址（`http://127.0.0.1:9222`）。 */
  endpoint?: string
  /** `launch`：本机 Chrome / Chromium 的可执行文件路径。 */
  executable_path?: string
  /** `launch`：不给 = `true`。 */
  headless?: boolean
  /**
   * WP92：`browserskill`：`bsk` 可执行文件的路径。
   * 缺省是我们自己装的那一份（`AGENTSWS_DATA_DIR/bin/bsk`），用户一般不用填。
   */
  bsk_path?: string
}

/**
 * WP92（55 §10）：`bsk doctor` 的一条检查。
 *
 * 形状照抄上游 CLI 的 JSON（`CheckResult`）：`ok` 只有失败时是 false，
 * `status` 才分得出"警告"与"这台机器上不适用"。
 */
export interface BrowserSkillCheck {
  name: string
  ok: boolean
  status: 'ok' | 'fail' | 'warn' | 'na'
  detail: string
  /** 失败 / 警告时上游给的那句"怎么修"。 */
  hint?: string
}

/**
 * WP92：**这台机器上 BrowserSkill 装到哪一步了**（设置页那三步向导读它）。
 *
 * 三步各自对应哪一项：
 * ① 装扩展 → `checks` 里那条 "browser extension connected"；
 * ② 装 `bsk` → `installed` / `version`（我们钉的版本，见 `browserskill.lock.json`）；
 * ③ `bsk doctor` → `ok` 与 `checks` 全表。
 */
export interface BrowserSkillStatus {
  /** `bsk` 在不在（文件存在且可执行）。 */
  installed: boolean
  /** 装在哪。 */
  bsk_path?: string
  /** 装上的那一份自己报的版本（`bsk --version`）。 */
  version?: string
  /** 我们钉的版本（`browserskill.lock.json`），与 `version` 对不上就该重装。 */
  pinned_version?: string
  /** 跑过 `bsk doctor` 才有；没跑（或者没装）时是空数组。 */
  checks: BrowserSkillCheck[]
  /** `doctor` 里一条 `fail` 都没有。没装时是 `false`。 */
  ok: boolean
  /** 说给人听的那一句（没装 / 跑不起来 / 这一档不允许）。 */
  detail?: string
}

/** 设置页读到的那一份：设置本身 + 这个部署允不允许 attach。 */
export interface BrowserSettingsView extends BrowserSettings {
  /**
   * 只有**个人档**（本机运行）才允许 attach（55 §3 末段）。
   * Docker 档 / 托管档上服务不在用户那台电脑上，`127.0.0.1` 指的是容器自己——
   * 接过去只会接到一个不存在的浏览器，所以那两档只给 `launch`。
   */
  attach_allowed: boolean
  /** 不允许时说给人听的那一句。 */
  attach_blocked_reason?: string
  /**
   * WP92：这一档允不允许用「我正在用的浏览器」（BrowserSkill）。
   * 与 attach 同一条理由：`bsk` 与浏览器扩展都在**用户那台电脑**上，
   * 服务不在那台电脑上就连不到——所以也只有个人档给。
   */
  browserskill_allowed: boolean
  /** 不允许时说给人听的那一句。 */
  browserskill_blocked_reason?: string
}

/** 探一次 CDP 地址（`GET /json/version`）的结果。 */
export interface BrowserProbeResult {
  ok: boolean
  endpoint: string
  /** 探到了就是浏览器自己报的版本串（`Chrome/140.0.0.0`）。 */
  browser?: string
  /** 没探到时说给人听的那一句。 */
  detail?: string
}

/**
 * WP95（36 §11，`docs/upstream/sidebar-compare.md` #12 / #15）：
 * 第三栏「运行中的浏览器」面板读的**一次运行的浏览器侧汇总**。
 *
 * 它是**投影，不是新状态**：每一格都从事件日志里算出来
 * （`tool.call` / `tool.result{blocked}` / `progress{browser_handoff}`），
 * 服务端不为它多存一张表。所以运行结束之后这一份仍然算得出来——
 * 官方那一侧"会话一销毁摘要就没了"的毛病（`sidebar-compare` §4 第 1 条）我们不学。
 *
 * **只给域名不给整条 URL**：路径里常带订单号、邮箱、一次性 token；
 * 第三栏是给人看"它现在在哪家站上"，不是给人看参数（21 敏感级）。
 */
export interface RunBrowserView {
  run_id: RunId
  /**
   * 哪种执行器（55 §3 / §10）：
   * `playwright-mcp` = 官方 provider 那一种（工具名带 `mcp__playwright-mcp__` 前缀）；
   * `browserskill` = WP92「我正在用的浏览器」（六个 `browser_*` 裸名工具）；
   * `none` = 这次运行一个浏览器工具都没调过。
   */
  executor: 'playwright-mcp' | 'browserskill' | 'none'
  /** 这次运行还在不在跑（日志里有没有 `run.completed` / `run.failed` / `run.cancelled`）。 */
  running: boolean
  /** 最近一次导航去的域（`example.myshopify.com`）。 */
  current_host?: string
  /** 最近一次导航。 */
  last_navigation?: { at: Iso8601; host: string; tool: string }
  /** 最近一次被门禁拦下来的浏览器调用（白名单外的域、写动作越权…）。 */
  last_blocked?: { at: Iso8601; tool: string; reason: string }
  /**
   * 正等人接管（`browser_assist{action:'request-help'}` → `progress{browser_handoff}`）。
   * 有它 = 界面上该出"去接管"，而不是让人盯着一个不动的运行。
   */
  awaiting_handoff?: { at: Iso8601; note?: string }
  /** 导航次数与被拦次数（"运行中"那三个字段的同一条思路，#15）。 */
  navigations: number
  blocked: number
}

export interface RunRequest {
  id: RunId
  schema_version: 1
  workspace_id: WorkspaceId
  kind: RunKind
  actor: { person_id: PersonId; assignment_id: AssignmentId; role_id: RoleId }
  /** = Matter（37 §2.2b：work_item 的正式形态是「事项」）；`id` 就是 `MatterId` */
  work_item?: { id: string; conversation_id: string; role_id: RoleId }
  trigger: {
    event_id: string
    source: 'inbound' | 'schedule' | 'workflow' | 'approval_result' | 'manual' | 'sentinel'
  }
  context: ContextItem[]
  grounding: GroundingRule[]
  tools: { allow: string[]; connect_token: string; side_effect_policy: 'personal' | 'executor' }
  skills: SkillRef[]
  persona: { sections: PromptSection[] }
  budget: { max_tokens: number; max_tool_calls: number; max_seconds: number; max_cost_base: number }
  expectations: {
    outputs: ('draft' | 'staged_change' | 'proposal' | 'answer' | 'dev_result' | 'none')[]
    must_stage_if_change_requested: boolean
  }
  runtime: { preset: string; profile: string; plugins: string[]; model: ModelRef; seed?: number }
  /**
   * 48 v2 L2（WP54）：这个工作区卖的是什么（`WorkspaceProfile.vertical`）。
   *
   * 运行时拿它去 `getVerticalPack()` 取人设、词表、业务边界与追问措辞。
   * 不给就实物——老的运行记录与回放包里没有这个字段，重放出来必须还是原来那一份。
   */
  vertical?: WorkspaceVertical
  /**
   * WP82（55 §3）：这次运行的浏览器。**不给 = 这条职责不开浏览器**——
   * 运行时不挂 provider，一个 `browser_*` 工具都不存在。
   */
  browser?: RunBrowser
  /**
   * WP89（55 §8 Q7）：这次运行的**终端与沙箱**。不给 = 这条职责没有 `bash` 工具。
   *
   * 给了也还要过第二道：运行时只给建站与主题那条职责挂（`SHELL_ROLE_IDS`）——
   * 契约是"怎么跑"，"谁能跑"不由请求方说了算。老的运行记录里没有这个字段，
   * 回放出来照样是"一个命令都跑不了"。
   */
  shell?: RunShell
  /**
   * WP82（55 §3「域名白名单」那一行）：这次运行**允许打开**的站点。
   *
   * 由职责模板的 `RoleDefinition.browser_scope` 算出来（岗位可能带多条职责，取并集）。
   * 支持 `*.youtube.com` 这种通配（只通配最左一段之前的部分）。
   *
   * **不给 ≡ 空数组 ≡ 一个站都不许开**：门禁看的是"在不在这张表里"，
   * 表是空的就一律拒。老的运行记录里没有这个字段，回放出来照样是"一律拒"，
   * 与它们当初根本没有浏览器工具的事实一致（所以这里是可选字段，不是必填）。
   */
  allowed_hosts?: string[]
  /**
   * WP86（55 §4 第三层）：**这条职责连了哪些 MCP 服务器**。
   *
   * 由服务进程从「连接目录」算出来：职责模板的 `connectors[]` ∩ 已登记的
   * MCP 服务器（目录里 `mode: 'mcp_server'` 的那些，加上职责用 `mcp:<name>`
   * 指名的自定义服务器）。运行时据它生成这条职责的 `agent-presets` 目录，
   * 一行一个官方 `@deepseek-ai/dsh-mcp-client`。
   *
   * **里面没有任何凭据值**：请求头与环境变量只有**名字**（`header_refs` /
   * `env_refs`），值由 `ctx.credentials` 在运行时解析（13 §4）。
   *
   * 不给 ≡ 空数组 ≡ 这条职责一台 MCP 服务器都不挂——preset 里没有 `mcp-client` 行，
   * 工具面里一个 `mcp__*` 都不存在。老的运行记录里没有这个字段，回放出来照样是空。
   */
  connections?: RunConnection[]
  /**
   * WP144（docs/80）：这次运行**能不能操作这台电脑**（官方 `dsh-computer-use` +
   * Cua Driver MCP 提供方）。
   *
   * 三层开关都过了服务端才给：设置页总开关开着、这条职责被勾了「可以操作电脑」、
   * 而且服务就在用户自己的电脑上（`runtimeMode() === 'local'`）。**不给 = 这次运行
   * 连「请求操作电脑」那个工具都没有**。给了也分两步：
   *
   * - 没有 `granted_until`：提供方**不挂**，模型只看得见 `request_computer_use`
   *   一个工具——调它就出一张授权卡（「让它在接下来 N 分钟操作这台电脑？」）；
   * - 有 `granted_until`（人批过的那一次）：才挂提供方，驱动的工具在这个时刻之前可用，
   *   过了立刻全拒。
   *
   * 老的运行记录里没有这个字段，回放出来照样是「碰不到电脑」。
   */
  computer_use?: RunComputerUse
  idempotency_key: string
}

/**
 * WP144（docs/80）：一次运行的电脑操控参数（见 {@link RunRequest.computer_use}）。
 *
 * 驱动由我们钉版本 + sha256 下载，装在数据目录、不进 PATH（`computer-use.lock.json`）。
 */
export interface RunComputerUse {
  /** 驱动可执行文件的**绝对路径**（数据目录里那一份）。 */
  command: string
  /** 传给驱动的参数：macOS `['mcp', '--direct']`（权限记在我们的应用上），其余 `['mcp']`。 */
  args: string[]
  /** 授权卡上问的分钟数（设置页可改，缺省 10）。 */
  minutes: number
  /** 人批过的授权到什么时候为止（墙钟）。不给 = 还没批，提供方不挂。 */
  granted_until?: Iso8601
  /** 批的那张授权卡（时间线与第三栏按它对上号）。 */
  grant_id?: string
}

/**
 * 一条挂给这次运行的 MCP 服务器（官方 `dsh-mcp-client` 的一行配置 + 我们的读写分类）。
 *
 * 形状照上游 `StdioConfig` / `StreamableHttpConfig` 抄，只把凭据那两处换成**引用**。
 */
export interface RunConnection {
  /** 职责模板里的 `connectors[].kind`（`shopify` / `mcp:my-tools`）。 */
  kind: string
  /** 上游 `serverName`，全局唯一（`mcpServerNameFor(workspace_id, kind)`）。 */
  server_name: string
  transport: 'stdio' | 'streamable-http'
  /** stdio：可执行文件与参数。 */
  command?: string
  args?: string[]
  /** streamable-http：服务器地址。 */
  url?: string
  /**
   * 请求头名 → **凭据引用名**（`CredentialRef`，一个 POSIX 环境变量名）。
   * 值不在这里、也不在生成的 preset 文件里；运行时经 `ctx.credentials` 解析。
   */
  header_refs?: Record<string, string>
  /** stdio 子进程的环境变量名 → 凭据引用名，同上。 */
  env_refs?: Record<string, string>
  /**
   * 这台服务器上**只读**的原始工具名（`McpServerRecord.read_tools`）。
   * 门禁按它判读写；表外的一律 `write_external`（16 §3 最严兜底）。
   */
  read_tools?: string[]
  /**
   * 探测时它报出来的**全部**原始工具名。用途只有一个：算出
   * `mcp__<server_name>__<tool>` 放进 `ctx.tools.restrict({ allow })`——
   * preset 挂上来的工具**受**职责白名单管（实测；与官方浏览器 provider 相反）。
   * 不给的话这台服务器的工具一个都进不了模型面。
   */
  tools?: string[]
}

/**
 * 一个 host 在不在白名单里（`*.youtube.com` 通配 `www.youtube.com` 也通配 `youtube.com` 本身）。
 *
 * 三个运行时与门禁共用这一份，免得"通配怎么算"在两处各写一遍。
 * 大小写与末尾的点都归一；端口不参与判定（`new URL(...).hostname` 本来就不带端口）。
 */
export function hostAllowed(host: string, allowed: readonly string[] | undefined): boolean {
  const h = host.toLowerCase().replace(/\.$/, '')
  if (h === '') return false
  for (const raw of allowed ?? []) {
    const pattern = raw.trim().toLowerCase().replace(/\.$/, '')
    if (pattern === '') continue
    if (pattern.startsWith('*.')) {
      const suffix = pattern.slice(2)
      if (h === suffix || h.endsWith(`.${suffix}`)) return true
      continue
    }
    if (h === pattern) return true
  }
  return false
}

/** 17 §2 事件流。运行时只产出这些；协同服务落事件日志。 */
export type RunEvent =
  | { type: 'run.started'; request_id: RunId; runtime: string; model: ModelRef }
  | {
      type: 'context.injected'
      item_id: string
      kind: ContextItem['kind']
      bytes: number
      hash: string
      /** 来源：请求自带 / 宿主 grounding 预取（17 §5.4）。缺省 `request`。 */
      source?: 'request' | 'prefetch'
    }
  | { type: 'prompt.assembled'; hash: string; static_prefix_hash: string; total_tokens: number }
  /**
   * WP81：除了"运行时自己排回合"那条路，还有"回合由底座排"这一路（dsh 的 Agent 层）。
   * 一次 `run()` 里可能有多个回合、每个回合多步，而 17 §2 以前只有"一次运行"一个粒度——
   * 排障时看不出模型是在第几轮上停的。这两条把回合边界显式记下来。
   * 自排回合的运行时（stub / direct-llm / replay）不发它们。
   */
  | { type: 'turn.started'; turn: number }
  /** `reason` 是底座报的终止原因（`completed` / `aborted` / `error` / …）。 */
  | { type: 'turn.ended'; turn: number; reason: string }
  | { type: 'text.delta'; text: string }
  | { type: 'tool.call'; call_id: string; tool: string; input: unknown }
  | {
      type: 'tool.result'
      call_id: string
      status: 'ok' | 'error' | 'blocked'
      reason?: string
      provenance_added?: ObjectRef[]
    }
  | { type: 'change.staged'; change_id: string }
  | { type: 'proposal.created'; approval_item_id: string; kind: string; dedupe_key?: string }
  | { type: 'ui'; component: string; payload: unknown }
  | { type: 'ui.partial'; component: string; payload: unknown }
  | { type: 'progress'; step: string; note?: string }
  | { type: 'budget.warning'; which: keyof RunRequest['budget']; used: number; cap: number }
  | { type: 'budget.exhausted'; which: keyof RunRequest['budget']; used: number; cap: number }
  | {
      type: 'run.completed'
      usage: RunUsage
      outputs: RunOutput[]
      summary: string
      /** 15 §4.4：变更请求结束却没有 stage（与 RunResult.no_stage 同义，事件日志里也要看得到）。 */
      no_stage?: boolean
    }
  | { type: 'run.failed'; error: { code: string; message: string; retryable: boolean } }
  | { type: 'run.cancelled' }

export interface RunUsage {
  input_tokens: number
  output_tokens: number
  cached_tokens: number
  tool_calls: number
  seconds: number
  cost_base: number
}

export type RunOutput =
  | { kind: 'draft'; approval_item_id: string }
  | { kind: 'staged_change'; change_id: string }
  | { kind: 'proposal'; approval_item_id: string }
  | { kind: 'answer'; text: string }
  | {
      kind: 'dev_result'
      dev_task_id: string
      payload?: {
        pr_url?: string
        theme_id?: string
        branch?: string
        commit?: string
        artifact?: string
      }
    }
  | { kind: 'ui'; ref: string }

export interface MemoryFact {
  key: string
  value: string
  category: 'constraint' | 'preference' | 'context'
  subject: ObjectRef
  source_run_hash: string
  expires_at: Iso8601
}
export interface Lesson {
  id: string
  run_id: RunId
  assignment_id: AssignmentId
  skill: string
  section_id?: string
  signal: 'edit_diff' | 'reject' | 'redirect' | 'guardrail_hit' | 'tool_retry' | 'reflection'
  strength: 'strong' | 'medium' | 'weak'
  text: string
  confidence: number
}

export interface RunResult {
  request_id: RunId
  status: 'completed' | 'failed' | 'budget_exhausted' | 'cancelled'
  outputs: RunOutput[]
  provenance: ProvenanceState
  memory_candidates: MemoryFact[]
  lessons: Lesson[]
  usage: RunUsage
  /** `log_uri` 只有带会话文件的运行时（dsh）才有；direct-llm 之类省略。 */
  session_ref: { runtime: string; session_id: string; log_uri?: string }
  summary: string
  /** 15 §4.4：变更请求结束却没有 stage */
  no_stage?: boolean
}

/** 17 §4 运行时适配器契约：dsh、direct-llm、replay、stub、dev-executor 都实现它。 */
export interface RuntimeAdapter {
  name: string
  capabilities(): { tool_choice: boolean; streaming: boolean; followup: boolean; seedable: boolean }
  run(req: RunRequest, sink: (e: RunEvent) => void, signal: AbortSignal): Promise<RunResult>
  followup?(
    session_ref: RunResult['session_ref'],
    event: { type: string; payload: unknown },
  ): Promise<void>
  health(): Promise<{ ok: boolean; detail?: string }>
}
