/**
 * 门禁插件（dsh 插件，`@deepseek-ai/cordis`）。
 *
 * 17 §4 列的 seam 全部在这里落地，业务代码不直接 import dsh：
 * - `tools/pre-execute`：预算 + allowlist + 业务边界 + 15 §6 provenance + 16 §3 副作用分类
 * - `tools/post-execute`：结果过 `EXTERNAL_FENCE`、实体 id 进 Provenance、发 `tool.result`
 * - `approval/request` answerer：把 dsh 的审批请求转成我们的审批项，fail-closed
 * - `systemPrompt.section`：persona 段（`complete` 段，遮蔽 dsh 自带的 persona 前后缀）
 * - `systemPrompt.context`：每个 ContextItem 一段，注册即发 `context.injected`
 * - `ctx.tools.restrict({ allow })`：在 **Agent 的 scoped ctx** 上调（全局 ctx 会抛）
 *
 * WP81：回合改由 dsh 的 agent-loop 驱动之后，两个产出工具（stage / draft）由**模型**调，
 * 门禁因此多担三件事——预算计数、`15 §6 先读后写`、产出物登记（`change.staged` /
 * `proposal.created` 与 `RunResult.outputs`）。这些以前在 `runtime.ts` 自排回合时做。
 */
import type { ObjectRef, RunEvent, RunOutput, RunRequest } from '@agentsws/contracts'
import { EXTERNAL_FENCE, type Provenance } from '@agentsws/core'
import type {
  BoundaryGate,
  CreateDraftFn,
  CreateDraftResult,
  DraftPayload,
  StageFn,
  StageIntent,
} from '@agentsws/stand-ins'
import {
  boundaryGate,
  contextItemHash,
  ontologyBriefOf,
  rewriteForChannelGuard,
} from '@agentsws/stand-ins'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Scope } from '@deepseek-ai/dsh-scope'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { PostToolDecision, PreToolDecision, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { anyBrowserToolName, browserBrief, checkBrowserNavigation } from './browser.js'
import { browserSkillToolName, isBrowserSkillHandoff } from './browserskill.js'
import {
  checkComputerUse,
  computerUseBrief,
  computerUseGranted,
  computerUseToolDefinitions,
  cuaToolName,
  isComputerUseOwnTool,
  redactComputerUseValue,
} from './computer-use.js'
import { presetToolNames } from './preset.js'
import { inferRefs, plainText } from './reading.js'
import type { ShellCheck } from './shell.js'
import {
  type AgentswsBashExecutor,
  BASH_TOOL,
  checkShellCommand,
  resolveShellEnv,
  runShell,
  shellBrief,
  shellCredentialPlan,
} from './shell.js'
import {
  buildToolDefinitions,
  classifySideEffect,
  DRAFT_TOOL,
  mcpReadToolMap,
  STAGE_TOOL,
} from './tools.js'
import type { DshRuntimeOptions, GateRecord } from './types.js'

/** dsh 的审批 seam 词汇（我们只用它的四个结果值，其余靠 answerer 自己判断）。 */
const GRANT: ApprovalOutcome = 'allowed-once'
const OUTCOMES: readonly string[] = ['allowed-once', 'rejected', 'cancelled', 'unavailable']

/** persona 段的名字：`complete` 段是唯一有效段，等于遮蔽 dsh 的 `deployment:persona-*`。 */
export const PERSONA_SECTION = 'agentsws:persona'
/** 每个 ContextItem 一段，名字稳定可回放。 */
export const CONTEXT_PREFIX = 'agentsws:context:'
/** ContextItem 段的起始 order（dsh 中央分配的位置最大 120，往后排不撞名）。 */
const CONTEXT_ORDER_BASE = 1000

/** 模型给 stage 的入参（`STAGE_PARAMS`）。 */
export interface StageArgs {
  order_id?: string
  amount: number
  currency?: string
  reason?: string
  notes?: string[]
}

/** 模型给 draft 的入参（`DRAFT_PARAMS`）。 */
export interface DraftArgs {
  subject: string
  body: string
  to?: string[]
  citations?: { fact_card_id: string; quote: string }[]
  /** 本次运行已经挂上的变更（门禁填，不是模型给的）。 */
  child_change_ids: string[]
}

export interface GateInput {
  request: RunRequest
  sink: (e: RunEvent) => void
  provenance: Provenance
  options: DshRuntimeOptions
  /** 由运行时提供：把工具入参补成完整的 stage 意图（运行时才知道订单与政策）。 */
  buildStageIntent(args: StageArgs): StageIntent | undefined
  buildDraftPayload(args: DraftArgs): DraftPayload | undefined
  /** dsh 官方 Agent（scoped dispatch 与 `tools.restrict` 的路由键）。 */
  agent?: Agent
  /** Agent 的 scoped ctx；`tools.restrict` 只能在它上面调。缺省时自己开一个 scope。 */
  agentCtx?: Context
  /** 一次读工具成功之后回调运行时（运行时据此更新订单等事实）。 */
  onToolResult?: (tool: string, value: unknown) => void
  /** 预算耗尽：宿主发 `budget.exhausted` 并把 Agent 停下。 */
  onBudgetExhausted?: (which: keyof RunRequest['budget'], used: number, cap: number) => void
}

/** 一张发出去的边界选择题卡。 */
export interface AskedBoundary {
  approval_item_id: string
  label: string
}

export interface GateApi {
  ctx: Context
  /** preset 的 agent scope key：`tools.restrict` 与 scoped dispatch 都按它路由。 */
  agent: object
  scope?: Scope
  records: Map<string, GateRecord>
  /** 已发过 `tool.result` 的 call_id。 */
  emitted: Set<string>
  /** 注入模型的上下文段名（按注册顺序），回放校验用。 */
  contextNames: string[]
  /** 36 §2.2 的边界判定（与 stub / direct-llm 同一份：`@agentsws/stand-ins` 的 `boundaryGate`）。 */
  boundary: BoundaryGate
  /** 本次运行的产物（17 §2 的 `RunResult.outputs`）。 */
  outputs: RunOutput[]
  /** 真的读成功过的工具（按调用顺序，摘要用）。 */
  readTools: string[]
  /** 已经消耗的工具调用数（预算）。 */
  toolCalls: number
  staged: boolean
  drafted: boolean
  stagedMoney?: { kind: string; amount: number; currency: string }
  stagedChangeIds: string[]
  /** 预算耗尽的那一项（运行时据此收成 `budget_exhausted`）。 */
  exhausted?: { which: keyof RunRequest['budget']; used: number; cap: number }
  /**
   * 把没答过的边界发成选择题卡（`policy_change`），同一次运行只发一次。
   * `tools/pre-execute` 拒掉 stage 时调它；运行时也调它（模型压根没提变更那条路）。
   */
  askBoundaries(): Promise<AskedBoundary[]>
  /** 供契约测试直接驱动 answerer waterfall。 */
  requestApproval(req: {
    toolName: string
    callId?: string
    reason?: string
  }): Promise<ApprovalOutcome>
  /** 经 dsh 工具流水线执行一次调用（带 agent scope）。 */
  execute(
    call_id: string,
    name: string,
    input: Record<string, unknown>,
  ): Promise<ToolExecutionResult>
  dispose(): Promise<void>
}

function isOutcome(v: unknown): v is ApprovalOutcome {
  return typeof v === 'string' && OUTCOMES.includes(v)
}

/** 记一条判定；同一 call_id 只记第一条（pre-execute 的拒绝优先于后续）。 */
function note(api: GateApi, record: GateRecord): void {
  if (!api.records.has(record.call_id)) api.records.set(record.call_id, record)
}

function emitResult(api: GateApi, sink: (e: RunEvent) => void, call_id: string): void {
  if (api.emitted.has(call_id)) return
  const rec = api.records.get(call_id)
  if (rec === undefined) return
  api.emitted.add(call_id)
  sink({
    type: 'tool.result',
    call_id,
    status: rec.status,
    ...(rec.reason === undefined ? {} : { reason: rec.reason }),
    ...(rec.provenance_added.length > 0 ? { provenance_added: rec.provenance_added } : {}),
  })
}

function asRecord(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : {}
}

/**
 * 在一个已注入 `tools` / `systemPrompt` 的 context 上装好整套门禁。
 * 调用方保证 `ctx` 已经拿到服务（见 `harness.ts` 的 inject 行）。
 */
export function installGate(ctx: Context, input: GateInput): GateApi {
  const { request, sink, provenance, options } = input
  const allow = new Set(request.tools.allow)
  // staging 工具是我们自己的出口，不在 Connect 的 allowlist 里，但必须可调
  allow.add(STAGE_TOOL)
  allow.add(DRAFT_TOOL)
  /*
   * WP82（55 §3）：浏览器工具不是 Connect 发的，也不在职责的 `tools.allow` 里——
   * 它们由官方 provider 按 Agent 注册（`harness.ts` 的 `setup`）。**这一整组在不在，
   * 只取决于 `RunRequest.browser` 给没给**：不给就连 provider 都不挂，一个都不存在。
   *
   * 给了就整个命名空间（`mcp__playwright-mcp__*`）过 allowlist 这一关——不逐个列名，
   * 理由是上游随时会增删工具，写死一张名单只会让新工具变成"不在 allowlist"这种
   * 看不懂的拒绝。**真正管着它们的是后面三道**：域名白名单、读写分类（表外一律按写，
   * 公司端因此拒）、注 JS 公司端硬拒。新来的工具默认落到"按写"，方向是对的。
   */
  const browserOn = request.browser !== undefined
  /*
   * WP86（55 §4 第三层）：preset 挂上来的 MCP 工具（`mcp__<workspace>_<kind>__<tool>`）。
   *
   * 与浏览器那一整组不同，**这些是逐个列名的**：名字来自连接目录里那台服务器
   * 探测出来的工具清单（`RunConnection.tools`），不是运行时猜的。列名的好处是
   * 「这条职责能用哪台服务器的哪几个工具」在 RunRequest 里看得见、回放得出来；
   * 而且 preset 的工具**确实受** `tools.restrict` 管（实测，见 `preset-seam.test.ts`），
   * 不列就一个都到不了模型面前。
   */
  const presetTools = new Set(presetToolNames(request))
  /** `server_name` → 那台服务器上被人勾成"只读"的工具（`McpServerRecord.read_tools`）。 */
  const mcpReadTools = mcpReadToolMap(request)
  /*
   * WP92（55 §10）：第二种浏览器（BrowserSkill）的工具是**六个裸名**（`browser_page` …），
   * 没有前缀，所以"是不是浏览器工具"这一问由 `anyBrowserToolName` 回答（两张表各认各的；
   * 一次运行只挂一种，不会同时命中）。这一整组在不在，照旧只取决于 `RunRequest.browser`。
   *
   * WP89（55 §8 Q7）：官方 `bash` 工具。与浏览器同一条纪律——**在不在只取决于
   * 这次运行挂没挂终端**（`runShell()` 两道都过才有），不在职责的 `tools.allow` 里。
   * 真正管着它的是 {@link checkShellCommand} 那张命令表。
   */
  const shell = runShell(request)
  /*
   * WP144（docs/80）：电脑操控。与浏览器同一条纪律——**在不在只取决于这次运行给没给
   * `computer_use`**，不在职责的 `tools.allow` 里。给了还分两步：没授权时只有
   * `request_computer_use`（出授权卡），批过（`granted_until` 没过）才有驱动那一整组
   * （`mcp__cua-driver-mcp__*`，由 `harness.ts` 挂的官方提供方注册）+ `computer_handoff`。
   * 授权按**墙钟**判（合成时钟 / 子进程镜像时钟不走的时候它也得走）。
   */
  const computerUse = request.computer_use
  const wallNow = options.wallClockMs ?? Date.now
  const cuGranted = computerUseGranted(computerUse, wallNow())
  /** Agent 调过 `computer_handoff`：这次运行不再碰电脑。 */
  let handedOff = false
  const allowed = (name: string): boolean =>
    allow.has(name) ||
    presetTools.has(name) ||
    (browserOn && anyBrowserToolName(name) !== undefined) ||
    (shell !== undefined && name === BASH_TOOL) ||
    (computerUse !== undefined && isComputerUseOwnTool(name)) ||
    (cuGranted && cuaToolName(name) !== undefined)

  // Agent 层在场时用真 Agent 当 scope key（官方语义）；没有时退回一个占位键 + 自开 scope。
  const agent: object = input.agent ?? { preset: request.runtime.preset, run_id: request.id }
  const scope: Scope | undefined =
    input.agentCtx === undefined ? createScope(ctx, agent) : undefined
  const scopedCtx: Context = input.agentCtx ?? (scope as Scope).ctx

  // 36 §2.2：管着这次变更的边界答过没有。三个运行时同一份判定。
  const boundary = boundaryGate({
    request,
    now: options.clock.now(),
    defaultReturnWindowDays: options.defaultReturnWindowDays ?? 14,
  })
  let askedOnce: Promise<AskedBoundary[]> | undefined

  /*
   * WP89：这次运行要往子进程交的那几个名字（**只有名字**，值是跑命令那一跳现取的）。
   * `clearShellEnv()` 把执行器上那一跳的值清空——`tools/post-execute` 与 `dispose()`
   * 两处都会调它，保证凭据活不过"这一条命令"。
   */
  const shellPlan = shell === undefined ? undefined : shellCredentialPlan(shell)
  const bashExecutor = (): AgentswsBashExecutor | undefined =>
    shell === undefined ? undefined : (ctx.get('shell') as AgentswsBashExecutor | undefined)
  const clearShellEnv = (): void => {
    bashExecutor()?.clearCommandEnv()
  }
  /** 同一条发布命令只发一张卡（模型会重试；重试不该变成第二张卡）。 */
  const publishedCommands = new Set<string>()

  const pendingStage = new Map<string, StageIntent>()
  const pendingDraft = new Map<string, DraftPayload>()
  const stageResults = new Map<string, { change_id: string }>()
  const draftResults = new Map<string, Exclude<CreateDraftResult, undefined>>()

  const api: GateApi = {
    ctx,
    agent,
    ...(scope === undefined ? {} : { scope }),
    records: new Map(),
    emitted: new Set(),
    contextNames: [],
    boundary,
    outputs: [],
    readTools: [],
    toolCalls: 0,
    staged: false,
    drafted: false,
    stagedChangeIds: [],
    async askBoundaries() {
      if (askedOnce === undefined) askedOnce = askAll()
      return askedOnce
    },
    async requestApproval(req) {
      try {
        // 17 §4 的 answerer waterfall：任一 answerer 认领即返回；没人认领 → `unavailable`（fail-closed）
        const out: unknown = await ctx.waterfall(
          'approval/request',
          { agent, toolName: req.toolName, callId: req.callId, reason: req.reason } as never,
          async () => 'unavailable' as ApprovalOutcome,
        )
        return isOutcome(out) ? out : 'unavailable'
      } catch {
        return 'unavailable'
      }
    },
    async execute(call_id, name, toolInput) {
      return ctx.tools.execute({
        callId: call_id as never,
        name,
        arguments: toolInput,
        agent: agent as never,
        signal: new AbortController().signal,
      })
    },
    async dispose() {
      // 兜底：工具体抛异常时 `tools/post-execute` 未必走到，凭据不能跟着运行一起留下
      clearShellEnv()
      await scope?.dispose()
    },
  }

  /** 逐条把没答过的边界发成卡；宿主不接回调就什么都不发生。 */
  async function askAll(): Promise<AskedBoundary[]> {
    const ask = options.createPolicyQuestion
    if (ask === undefined || boundary.missing.length === 0) return []
    const out: AskedBoundary[] = []
    for (const item of boundary.missing) {
      const asked = await ask({ request, boundary: item })
      if (asked === undefined) continue
      out.push({ approval_item_id: asked.approval_item_id, label: item.label })
      sink({
        type: 'proposal.created',
        approval_item_id: asked.approval_item_id,
        kind: 'policy_change',
      })
      api.outputs.push({ kind: 'proposal', approval_item_id: asked.approval_item_id })
    }
    return out
  }

  /**
   * WP89（55 §8「门禁」那一行）：把一条发布命令**物化成一张卡**，而不是简单拒掉。
   *
   * 43 的流程一个字没变：改的是副本 → `theme push --unpublished` → 审批卡 → 批了才发布。
   * 变的只是"提出发布"这一跳的来源——以前是服务端的几条写死的调用，现在是 Agent
   * 在沙箱里想跑 `shopify theme publish`，被这里接住。
   *
   * **`before` 这里填不出来**（15 §1：字段必须来自真读）：Agent 没读过线上那一份主题，
   * 我们也不该替它编一个。真正的 `before` 由服务端 `shopify-theme.ts` 的
   * `proposePublish()` 在渲染这张卡之前用一次真的 `theme list` 补上——那一跳本来就在。
   * 所以这里的 `after` 只带"Agent 想发布哪一份、用的哪条命令"。
   */
  async function materializePublish(theme_id: string | undefined, command: string): Promise<void> {
    const stage: StageFn | undefined = options.stage
    if (stage === undefined) return
    if (publishedCommands.has(command)) return
    publishedCommands.add(command)
    const res = await stage({
      request,
      kind: 'publish_theme',
      target: { type: 'theme', id: theme_id ?? 'pending' },
      field: 'live_theme',
      // 线上那一份是什么，由服务端在渲染卡之前真读一次补上（见上面那段注释）
      before: null,
      after: { theme_id: theme_id ?? 'pending', command },
      notes: [
        'AI 想把一份主题副本设成线上主题。',
        `它打算跑的命令：\`${command}\``,
        '发布之前请先点开这份副本的预览看一眼——按下去顾客立刻就看得到。',
      ],
    })
    if (res === undefined) return
    api.staged = true
    api.stagedChangeIds.push(res.change_id)
    sink({ type: 'change.staged', change_id: res.change_id })
    api.outputs.push({ kind: 'staged_change', change_id: res.change_id })
  }

  // ── 工具：注册进 dsh 的注册表，读走注入的出口，写走审批 seam ────────────
  const definitions = buildToolDefinitions(
    request,
    {
      async run(name, toolInput) {
        const exec = options.executeTool
        if (exec === undefined) return { status: 'error', reason: 'no_tool_executor' }
        return exec({ name, input: toolInput, request })
      },
      note(callId, tool, status, reason) {
        note(api, { call_id: callId, tool, status, reason, provenance_added: [] })
      },
      provenance(callId, refs) {
        provenance.see(refs, { full: true })
        const rec = api.records.get(callId)
        if (rec !== undefined) rec.provenance_added.push(...refs)
        else {
          api.records.set(callId, {
            call_id: callId,
            tool: '',
            status: 'ok',
            provenance_added: [...refs],
          })
        }
      },
    },
    {
      async stage(callId, args) {
        const intent = input.buildStageIntent(args)
        if (intent === undefined) return undefined
        pendingStage.set(callId, intent)
        const outcome = await api.requestApproval({
          toolName: STAGE_TOOL,
          callId,
          reason: intent.notes.join('；'),
        })
        if (outcome !== GRANT) return undefined
        const res = stageResults.get(callId)
        if (res === undefined) return undefined
        // 15 §6：动过的实体钉住；产物与事件在这里登记（一次运行只此一处）
        api.staged = true
        api.stagedMoney = {
          kind: intent.kind,
          amount: intent.money?.amount ?? args.amount,
          currency: intent.money?.currency ?? args.currency ?? 'USD',
        }
        api.stagedChangeIds.push(res.change_id)
        provenance.pin(intent.target)
        sink({ type: 'change.staged', change_id: res.change_id })
        api.outputs.push({ kind: 'staged_change', change_id: res.change_id })
        return res
      },
      async draft(callId, args) {
        const payload = input.buildDraftPayload({
          ...args,
          child_change_ids: [...api.stagedChangeIds],
        })
        if (payload === undefined) return undefined
        pendingDraft.set(callId, payload)
        const outcome = await api.requestApproval({
          toolName: DRAFT_TOOL,
          callId,
          reason: payload.subject,
        })
        if (outcome !== GRANT) return undefined
        const res = draftResults.get(callId)
        if (res === undefined || !('approval_item_id' in res)) return undefined
        api.drafted = true
        sink({
          type: 'proposal.created',
          approval_item_id: res.approval_item_id,
          kind: 'outbound_draft',
        })
        api.outputs.push({ kind: 'draft', approval_item_id: res.approval_item_id })
        return res
      },
    },
  )
  for (const def of definitions) ctx.tools.register(def)
  /*
   * WP144：两个自有工具（只出卡，不碰外部）。与 stage / draft 同一类出口：
   * 卡由宿主建（`options.requestComputerUse`），这里只登记产出与时间线。
   */
  const computerUseTools =
    computerUse === undefined
      ? []
      : computerUseToolDefinitions(cuGranted, {
          async card(_callId, stage, reason) {
            const ask = options.requestComputerUse
            if (ask === undefined) return undefined
            const res = await ask({ request, stage, reason })
            if (res === undefined) return undefined
            if (stage === 'handoff') {
              handedOff = true
              sink({ type: 'progress', step: 'computer_handoff', note: reason })
            } else {
              sink({ type: 'progress', step: 'computer_use_requested', note: reason })
            }
            sink({
              type: 'proposal.created',
              approval_item_id: res.approval_item_id,
              kind: 'computer_use',
            })
            api.outputs.push({ kind: 'proposal', approval_item_id: res.approval_item_id })
            return res
          },
        })
  for (const def of computerUseTools) ctx.tools.register(def)

  // ── `ctx.tools.restrict`：preset 的工具集按 RunRequest.tools.allow ───────
  //
  // WP82 查证：**浏览器工具不用（也不能）列进这里**。`restrict` 只遮"继承下来的
  // 全局工具"，上游原话是 "Restrictions intersect; scoped registrations remain
  // visible"；而官方 provider 是在它自己那个 `createScope(ctx, agent)` 里注册
  // MCP 工具的（scoped registration），本来就不受这张白名单影响。真列进去反而会抛
  // ——restrict 只认调用当刻**已经全局注册**的名字，而 provider 是在 `agent/created`
  // 之后才挂的，比 `setup` 晚一步。
  //
  // WP86 补一条相反的事实：**preset 挂上来的 MCP 工具反过来必须列进来**。
  // 它们是 `mount()` 在 `setup` 里注册的（比 `restrict` 早一步），所以 `restrict`
  // 认得它们；不列的话整组被这张白名单挡掉。名单按"这一刻真的注册上来了的"取交集
  // ——一台连不上的服务器不会让 `restrict` 抛（抛了整张白名单都装不上，反而更松）。
  const registered = new Set(
    input.agent === undefined ? [] : ctx.tools.schemas(input.agent).map((sc) => sc.name),
  )
  const visible = [
    ...definitions.map((d) => d.name).filter((n) => allow.has(n)),
    ...[...presetTools].filter((n) => registered.has(n)),
    // WP89：`bash` 与 preset 的工具同类——它是 `harness.ts` 在 `agents.create` 之前
    // 全局注册的，所以 `restrict` 认得它，不列就被职责白名单挡掉。
    ...(shell !== undefined && registered.has(BASH_TOOL) ? [BASH_TOOL] : []),
    // WP144：自有的那一个电脑操控工具是全局注册的（同 stage / draft），不列就被白名单挡掉。
    // 驱动那一整组是提供方在 Agent scope 里注册的（与浏览器 provider 同类），不列、也不能列。
    ...computerUseTools.map((d) => d.name),
  ]
  if (visible.length > 0) scopedCtx.tools.restrict({ allow: visible })

  // ── `tools/pre-execute`：预算 + 三道门（17 §6.3）────────────────────────
  ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    const call_id = String(exec.callId)
    const deny = (reason: string): PreToolDecision => {
      note(api, { call_id, tool: exec.name, status: 'blocked', reason, provenance_added: [] })
      emitResult(api, sink, call_id)
      return { kind: 'deny', reason }
    }
    // 17 §5.3：工具调用预算是硬的，超了当场拒并补齐这条调用
    const cap = request.budget.max_tool_calls
    if (api.toolCalls >= cap) {
      if (api.exhausted === undefined) {
        api.exhausted = { which: 'max_tool_calls', used: api.toolCalls, cap }
        input.onBudgetExhausted?.('max_tool_calls', api.toolCalls, cap)
      }
      return deny('budget_exhausted')
    }
    if (api.toolCalls + 1 === cap) {
      sink({ type: 'budget.warning', which: 'max_tool_calls', used: api.toolCalls + 1, cap })
    }
    api.toolCalls += 1

    /*
     * WP144（docs/80 §4）：驱动的工具**全部**按写外部判，而且只看授权窗口——
     * 放在 allowlist 之前，拒绝理由才说得清（没授权 / 过期 / 已交还给人），
     * 不然模型只看到一句 `not_in_allowlist`。截图、列窗口这类只读也在这里拦：
     * 整屏截图是隐私，与点击同一档。放行也要留痕（`progress{computer_use}`）。
     */
    if (cuaToolName(exec.name) !== undefined) {
      const denial = checkComputerUse({
        tool: exec.name,
        args: asRecord(exec.arguments),
        request,
        nowMs: wallNow(),
        handedOff,
      })
      if (denial !== undefined) return deny(denial)
      sink({ type: 'progress', step: 'computer_use', note: exec.name })
      return next()
    }
    if (!allowed(exec.name)) return deny(`not_in_allowlist: ${exec.name}`)
    // WP144：两个自有工具只出卡（与 stage 同类），不走读写分类（那样公司端一律拒）
    if (isComputerUseOwnTool(exec.name)) return next()
    // 36 §2.2：没答过的边界挡着变更——拒掉这次 stage，同时把选择题发给商家
    if (exec.name === STAGE_TOOL && !boundary.allowed) {
      await api.askBoundaries()
      return deny(`boundary_unanswered: ${boundary.missing.map((b) => b.id).join(',')}`)
    }
    // 15 §6：只能对本次运行「读过」的实体动手
    if (exec.name === STAGE_TOOL) {
      const orderId = asRecord(exec.arguments).order_id
      if (typeof orderId === 'string' && !provenance.has({ type: 'order', id: orderId })) {
        return deny('provenance_missing')
      }
    }
    const args = asRecord(exec.arguments)
    // WP82（55 §3）：注 JS 公司端一律拒 + 域名白名单（只看要打开的那个地址）
    const browserDenial = checkBrowserNavigation({
      tool: exec.name,
      args,
      allowedHosts: request.allowed_hosts,
      policy: request.tools.side_effect_policy,
    })
    if (browserDenial !== undefined) return deny(browserDenial)

    /*
     * WP89（55 §8 Q7）：命令 allowlist。**放在读写分类之前**——`bash` 这一个工具名
     * 底下藏着几十条不同的命令，读写分类按名字判是判不出来的（`classifySideEffect`
     * 的兜底会把它整个当成写外部，那样公司端连 `shopify theme list` 都跑不了）。
     * 所以这一关先把命令拆开判，判完直接给出副作用分类，不再走下面那一关。
     */
    if (exec.name === BASH_TOOL) {
      if (shell === undefined) {
        return deny('shell_not_enabled: 这个岗位没有终端，跑不了命令')
      }
      const check: ShellCheck = checkShellCommand({
        command: typeof args.command === 'string' ? args.command : '',
        ...(typeof args.workdir === 'string' ? { workdir: args.workdir } : {}),
        root: shell.workspace_root,
        ...(typeof args.sandbox_permissions === 'string'
          ? { sandboxPermissions: args.sandbox_permissions }
          : {}),
        ...(args.run_in_background === true ? { background: true } : {}),
      })
      if (check.verdict === 'deny') return deny(check.reason)
      if (check.verdict === 'publish') {
        // 公司端**不直接拒**：物化成 43 的 `publish_theme` 提案（永远 L1），批了才由
        // 服务端真跑。这次调用本身仍然不执行——卡出去了，命令就不该再跑一遍。
        await materializePublish(check.theme_id, String(args.command ?? ''))
        return deny(check.reason)
      }
      if (check.effect === 'read_external' && request.tools.side_effect_policy === 'executor') {
        // 读外部在公司端是放行的（与别的读工具同档）；这一行只是把 16 §3 的分类写清楚
        sink({ type: 'progress', step: 'shell_command', note: check.note })
      }
      // 13 §4：CLI 的凭据只在这一条命令的前后存在（post-execute 里还原）
      bashExecutor()?.setCommandEnv(
        await resolveShellEnv(
          ctx,
          shellPlan ?? { literals: {}, refs: {}, records: {} },
          options.credentials !== undefined,
        ),
      )
      return next()
    }

    const effect = classifySideEffect(exec.name, options.sideEffects, args, mcpReadTools)
    if (effect === 'write_external' && request.tools.side_effect_policy === 'executor') {
      return deny(`write_external_requires_executor: ${exec.name}`)
    }
    /*
     * WP82：个人档放行浏览器的写操作（点击、输入、提交）——那是用户自己的浏览器、
     * 自己的登录态。放行归放行，**得留下痕迹**：这一条 `progress` 就是
     * 「AI 在我的浏览器里动了手」在时间线上的那一行，与 `tool.call` / `tool.result`
     * 一起构成 16 §2 的 Model-visible ⟺ logged。
     */
    if (effect === 'write_external' && anyBrowserToolName(exec.name) !== undefined) {
      sink({ type: 'progress', step: 'browser_write', note: exec.name })
    }
    /*
     * WP92（55 §10「人接管」）：`browser_assist{action:'request-help'}` 是 BrowserSkill
     * 自带的人接管——它不替用户动手，只是在他自己的浏览器里弹一层"请你来做这一步"。
     * 所以**两档都放行**（公司端也放行：让人来做正是公司端想要的那条路），
     * 但要在时间线上留一行——"AI 卡住了，把活交回给人"这件事，人应该看得见。
     */
    const bskShort = browserSkillToolName(exec.name)
    if (bskShort !== undefined && isBrowserSkillHandoff(bskShort, args)) {
      sink({ type: 'progress', step: 'browser_handoff', note: exec.name })
    }
    return next()
  })

  // ── `tools/post-execute`：围栏 + provenance + 事件 ───────────────────────
  ctx.on('tools/post-execute', async (exec, result, next): Promise<PostToolDecision> => {
    const call_id = String(exec.callId)
    // WP89：命令跑完了，CLI 凭据立刻从执行器上撤掉（13 §4：窗口越窄越好）
    if (exec.name === BASH_TOOL) clearShellEnv()
    const decision = await next()
    if (decision.kind === 'block') {
      note(api, {
        call_id,
        tool: exec.name,
        status: 'blocked',
        reason: 'post_execute_block',
        provenance_added: [],
      })
      emitResult(api, sink, call_id)
      return decision
    }
    if (result.isError) {
      // 失败结果不允许被替换 value（dsh 的规矩），只登记与发事件
      const existing = api.records.get(call_id)
      note(api, {
        call_id,
        tool: exec.name,
        status: existing?.status ?? 'error',
        reason: existing?.reason ?? result.error.message,
        provenance_added: [],
      })
      emitResult(api, sink, call_id)
      return decision
    }
    // 结果是外部文本：围栏（fencing 在入口，运行时不再信任任何外部文本）
    // WP144：驱动的结果先把截图 / base64 拿掉（截图不进模型，docs/80 §5）
    const value =
      cuaToolName(exec.name) !== undefined ? redactComputerUseValue(result.value) : result.value
    const fenced = EXTERNAL_FENCE.sanitizeValue(value) as JsonValue
    const refs: ObjectRef[] = inferRefs(value)
    if (refs.length > 0) provenance.see(refs, { full: true })
    const rec = api.records.get(call_id)
    const added = [...(rec?.provenance_added ?? [])]
    for (const ref of refs) {
      if (!added.some((r) => r.type === ref.type && r.id === ref.id)) added.push(ref)
    }
    api.records.set(call_id, {
      call_id,
      tool: exec.name,
      status: 'ok',
      provenance_added: added,
    })
    if (exec.name !== STAGE_TOOL && exec.name !== DRAFT_TOOL && !isComputerUseOwnTool(exec.name)) {
      api.readTools.push(exec.name)
      input.onToolResult?.(exec.name, value)
    }
    emitResult(api, sink, call_id)
    return { kind: 'accept', value: fenced }
  })

  // ── `approval/request` answerer：dsh 的审批请求 → 我们的审批项 ────────────
  ctx.on('approval/request', async (req, next): Promise<ApprovalOutcome> => {
    const callId = typeof req.callId === 'string' ? req.callId : undefined
    if (callId === undefined) return next()
    try {
      if (req.toolName === STAGE_TOOL) {
        const intent = pendingStage.get(callId)
        if (intent === undefined) return 'unavailable'
        const stage: StageFn | undefined = options.stage
        if (stage === undefined) return 'unavailable'
        const res = await stage(intent)
        if (res === undefined) return 'rejected'
        stageResults.set(callId, res)
        return GRANT
      }
      if (req.toolName === DRAFT_TOOL) {
        const payload = pendingDraft.get(callId)
        if (payload === undefined) return 'unavailable'
        const create: CreateDraftFn | undefined = options.createDraft
        if (create === undefined) return 'unavailable'
        // WP55 / 48 §4 L3 #2：出站硬闸的重写循环。拦下 = **打回重写**——原因回到
        // 写正文的这一跳，重写一版再提交给闸判一次；绝不静默删改后照发。
        // 循环在 answerer 里而不是在 turn loop 里：重写是同一次 `draft_reply`
        // 调用内部的事，跑成两次工具调用会让 dsh 这一档的工具计数与另外两个
        // 运行时对不上。只重写一次：修不好的那几类本来就不该进重写循环。
        let res = await create(payload)
        if (res !== undefined && 'rewrite' in res) {
          sink({
            type: 'progress',
            step: 'channel_guard_rewrite',
            note: res.rewrite.split('\n')[1] ?? '',
          })
          res = await create({ ...payload, body: rewriteForChannelGuard(payload.body) })
        }
        if (res === undefined) return 'rejected'
        draftResults.set(callId, res)
        return GRANT
      }
      return next()
    } catch {
      // fail closed：answerer 抛错等于没有答案
      return 'unavailable'
    }
  })

  // ── `systemPrompt.section`：persona（complete 段 = 唯一有效段）──────────
  //
  // 47 J3 的那一段"你能查什么、能做什么"跟着 persona 一起进这个段：
  // preset 的白名单里 complete 段是**唯一**有效段（16 §2），另开一段会被遮掉。
  // WP81 起这一份**真的送模型**：dsh 的 `systemPrompt.assemble()` 就是 agent-loop
  // 每一步的系统提示词（54（将改号 55）§2.2 第三条）。
  const persona = [...request.persona.sections]
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
    .map((s) => `## ${s.id} ${s.name}\n${s.text}`)
    .join('\n\n')
  //
  // WP82：浏览器那一段也进**这一个**段。官方 provider 自己加的 `mcp:playwright-mcp`
  // 段会被 complete 段遮掉（WP70 实测），所以"能打开哪些站、遇到登录页怎么办"
  // 只能由我们自己写进来——不写的话模型对这两件事一无所知。
  const brief = [
    ontologyBriefOf(request),
    ...(browserOn
      ? [
          browserBrief({
            allowedHosts: request.allowed_hosts,
            policy: request.tools.side_effect_policy,
            ...(request.browser === undefined ? {} : { mode: request.browser.mode }),
          }),
        ]
      : []),
    /*
     * WP89：终端那一段也进**这一个**段，理由与浏览器逐字一致——官方 `tool-bash`
     * 自己注册的 `tool:bash` 是独立段（不受 complete 段遮蔽，那一句留着），
     * 但"能跑哪几条命令、只能在哪个目录里写、为什么 publish 按不下去"这三件
     * 官方不知道，只能我们写进来。不写的话模型会一条一条去试，试一条被拦一条。
     */
    ...(shell === undefined
      ? []
      : [
          shellBrief({
            root: shell.workspace_root,
            mode: shell.mode,
            ...(shell.store === undefined ? {} : { store: shell.store }),
          }),
        ]),
    /*
     * WP144：电脑操控那一段也进**这一个**段。官方提供方一句指导都不写（它只挂驱动报的
     * 工具），「什么时候能动、遇到密码怎么办、截图看不看得到」只能我们写。
     */
    ...(computerUse === undefined
      ? []
      : [
          computerUseBrief({
            granted: cuGranted,
            minutes: computerUse.minutes,
            ...(computerUse.granted_until === undefined
              ? {}
              : { until: computerUse.granted_until }),
          }),
        ]),
  ]
    .filter((t) => t !== '')
    .join('\n\n')
  ctx.systemPrompt.section({
    name: PERSONA_SECTION,
    order: 0,
    text: brief === '' ? persona : `${persona}\n\n${brief}`,
    complete: true,
  })

  // ── `systemPrompt.context`：每个 ContextItem 一段 + `context.injected` ───
  request.context.forEach((item, i) => {
    const name = `${CONTEXT_PREFIX}${item.id}`
    ctx.systemPrompt.context({
      name,
      order: CONTEXT_ORDER_BASE + i,
      text: `[${item.kind}:${item.id}]\n${plainText(item.content)}`,
    })
    api.contextNames.push(name)
    sink({
      type: 'context.injected',
      item_id: item.id,
      kind: item.kind,
      bytes: item.bytes,
      hash: contextItemHash(item),
    })
    const ref = typeof item.source_ref === 'string' ? undefined : item.source_ref
    if (ref !== undefined) provenance.see([ref])
  })

  return api
}
