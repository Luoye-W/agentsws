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

/**
 * WP82（55 §3 末段）：**这台机器上**的浏览器怎么配（`/v1/settings/browser` 的形状）。
 *
 * 为什么是"这台机器"而不是"这个品牌"：attach 接的是用户自己电脑上那个 Chrome，
 * 它与卖哪个品牌无关；同一台机器上的所有品牌用同一个浏览器设置。
 */
export interface BrowserSettings {
  /** `off` = 谁都不许开浏览器（缺省）。 */
  mode: 'off' | 'attach' | 'launch'
  /** `attach`：本机 Chrome 的 CDP 地址（`http://127.0.0.1:9222`）。 */
  endpoint?: string
  /** `launch`：本机 Chrome / Chromium 的可执行文件路径。 */
  executable_path?: string
  /** `launch`：不给 = `true`。 */
  headless?: boolean
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
  idempotency_key: string
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
