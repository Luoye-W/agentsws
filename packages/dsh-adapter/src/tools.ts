/**
 * 把 RunRequest 的工具变成 dsh 工具（`ctx.tools.register`）。
 *
 * 三类：
 * - 只读工具（`req.tools.allow` 里的）→ 注入的 `executeTool` 出口
 * - `stage_refund` / `draft_reply` → 先过 dsh 的审批 seam（answerer），再落到注入的 `stage` / `createDraft`
 * - 写外部工具（`create_refund` 之类）→ 注册但由 `tools/pre-execute` 在 executor 策略下一律拒
 */
import type { ObjectRef, RunRequest } from '@agentsws/contracts'
import { parseMcpToolName } from '@agentsws/contracts'
import { EXTERNAL_FENCE, redactOutbound } from '@agentsws/core'
import { orderTools } from '@agentsws/ontology'
import type { CreateDraftResult } from '@agentsws/stand-ins'
import { isMcpReadTool } from '@agentsws/stand-ins'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { browserSkillToolName, classifyBrowserSkillEffect } from './browserskill.js'
import { DshAdapterError } from './errors.js'
import type { DraftArgs, StageArgs } from './gate.js'
import type { ToolSideEffect } from './types.js'

/**
 * 工具结果的**模型可见**投影（`ToolOutputDefinition.render`）。
 *
 * WP81：回合由 dsh 驱动之后，工具结果是经这条 render 回到模型的对话里的——
 * 所以围栏必须在这里（31 §3.3：外部文本进模型之前先围起来、先脱敏），
 * 与 direct-llm 往 `messages` 里塞工具结果时那一行逐字一致。
 */
function renderToolResult(value: unknown): { type: 'text'; text: string }[] {
  return [{ type: 'text', text: EXTERNAL_FENCE.fencePayload(redactOutbound('tool_result', value)) }]
}

/** 我们自己的 staging 工具：不写外部，只提审批项。 */
export const STAGE_TOOL = 'stage_refund'
export const DRAFT_TOOL = 'draft_reply'

const WRITE_PREFIXES = ['create_', 'update_', 'delete_', 'send_', 'apply_', 'cancel_']
const READ_PREFIXES = ['get_', 'list_', 'search_', 'read_', 'find_']

/**
 * WP82：官方浏览器 provider 的工具名前缀（上游 `browser-use-runtime/src/mcp.ts` 的
 * `` const toolPrefix = `mcp__${options.name}__` ``，provider 的 `name` 是 `playwright-mcp`）。
 */
export const BROWSER_TOOL_PREFIX = 'mcp__playwright-mcp__'

/**
 * WP82：**只读的浏览器工具**（55 §3 第一行"读写分类"）。
 *
 * 为什么非得逐个写死：官方工具对 hook **不透明**——`tools/pre-execute` 只看得见名字与
 * 入参，没有任何读写标注，而下面 `classifySideEffect` 的兜底是 `write_external`。
 * 不列的话公司端一调就拒，连看一眼网页都做不到。
 *
 * 名字来自实测的上游 `@playwright/mcp@0.0.80`（不带 `--caps`，默认只有 Core
 * automation + Tab management 两组共 24 个工具；provider 拼参数时确实没有 `--caps`，
 * 见上游 `browser-use-playwright-mcp/src/index.ts`）。
 *
 * 我们的分类与上游 README 的 `Read-only` 标注**不完全一样**，两处差异都是有意的：
 * - `browser_navigate` 上游标 `Read-only: false`（它换了页面）；对我们它是**读外部**——
 *   打开一个网页就是"去外面读一份东西"，55 §3 那一行明写它是 `read_external`。
 *   真正管住它的是域名白名单（`gate.ts`），不是读写分类。
 * - `browser_wait_for` / `browser_resize` 上游标 `false`（它们改浏览器自己的状态），
 *   但它们碰不到外面任何东西：等一段文字出现、把窗口调大，跟外部世界无关。
 *
 * `browser_tabs` 不在这张表里：它一个工具管四件事（list / select / new / close），
 * 得按 `action` 入参判——见 {@link classifySideEffect} 的第三个参数。
 */
const BROWSER_READ_TOOLS: ReadonlySet<string> = new Set([
  'browser_navigate',
  'browser_snapshot',
  'browser_take_screenshot',
  'browser_find',
  'browser_console_messages',
  'browser_network_requests',
  'browser_network_request',
  'browser_wait_for',
  'browser_resize',
])

/**
 * WP82：`browser_tabs` 里**只读**的两个动作（其余 new / close 是写；`action` 缺了也算写）。
 * 上游参数：`action` = list / new / close / select，`url` 只在 new 时有意义。
 */
const BROWSER_TABS_READ_ACTIONS: ReadonlySet<string> = new Set(['list', 'select'])

/**
 * WP82：**注 JS 的两个**。它们能绕开我们判得出来的一切——白名单、读写分类、
 * 审批——直接在页面里跑任意代码（`browser_run_code_unsafe` 上游自己写着
 * "RCE-equivalent"）。所以除了按写处理之外，公司端另有一条硬拒（`gate.ts`）。
 */
export const BROWSER_SCRIPT_TOOLS: ReadonlySet<string> = new Set([
  'browser_evaluate',
  'browser_run_code_unsafe',
])

/**
 * WP82：上游 `@playwright/mcp@0.0.80` **默认**报出来的 24 个工具（短名，按字母序）。
 *
 * "默认"是关键：provider 拼参数时没有 `--caps`（上游
 * `browser-use-playwright-mcp/src/index.ts` 只加 `--browser chromium` 与
 * attach / launch 那几个），所以只有 Core automation（23 个）+ Tab management（1 个）
 * 两组会挂上来；storage / network / devtools / vision / pdf / testing 那几组都不在。
 * 这张表是**实测**出来的（`browser-seam.test.ts` 用真 provider 连一次假 endpoint、
 * 把它报的名字逐条比对），不是抄文档。
 *
 * 用途只有一个：`ctx.tools.restrict({ allow })` 的白名单里要列出它们，否则
 * 职责 allowlist 会把整组浏览器工具挡在 Agent 的 scope 之外（restrict 是默认拒）。
 * 上游哪天新增一个工具，它**不会**自动出现在模型面前——要先进这张表、
 * 同时决定它是读还是写。这正是我们要的方向。
 */
export const BROWSER_DEFAULT_TOOLS: readonly string[] = [
  'browser_click',
  'browser_close',
  'browser_console_messages',
  'browser_drag',
  'browser_drop',
  'browser_evaluate',
  'browser_file_upload',
  'browser_fill_form',
  'browser_find',
  'browser_handle_dialog',
  'browser_hover',
  'browser_navigate',
  'browser_navigate_back',
  'browser_network_request',
  'browser_network_requests',
  'browser_press_key',
  'browser_resize',
  'browser_run_code_unsafe',
  'browser_select_option',
  'browser_snapshot',
  'browser_tabs',
  'browser_take_screenshot',
  'browser_type',
  'browser_wait_for',
]

/** 上面那 24 个的全名（带 `mcp__playwright-mcp__` 前缀）。 */
export const BROWSER_DEFAULT_TOOL_NAMES: readonly string[] = BROWSER_DEFAULT_TOOLS.map(
  (n) => `${BROWSER_TOOL_PREFIX}${n}`,
)

/** 去掉 provider 前缀之后的短名；不是浏览器工具就回 `undefined`。 */
export function browserToolName(tool: string): string | undefined {
  return tool.startsWith(BROWSER_TOOL_PREFIX) ? tool.slice(BROWSER_TOOL_PREFIX.length) : undefined
}

/**
 * WP86：这次运行挂的每台 MCP 服务器上，**被人勾成只读**的那些原始工具名。
 *
 * `server_name` → `Set<rawName>`。没登记 `read_tools` 的服务器在这张表里是空集合，
 * 于是它的每一个工具都落到 {@link classifySideEffect} 的兜底（`write_external`）——
 * 公司端（`executor`）一调就拒。**这是有意的最严默认**：MCP 协议本身没有读写标注，
 * 一台服务器能干什么我们事先不知道，不勾就当它什么都能干。
 */
export function mcpReadToolMap(req: RunRequest): Map<string, ReadonlySet<string>> {
  const out = new Map<string, ReadonlySet<string>>()
  for (const conn of req.connections ?? []) {
    out.set(conn.server_name, new Set(conn.read_tools ?? []))
  }
  return out
}

/** 16 §3：判定不了的按 `write_external` 处理（最严）。 */
export function classifySideEffect(
  tool: string,
  overrides?: Record<string, ToolSideEffect>,
  /** WP82：`browser_tabs` 这种"一个名字多件事"的工具要看入参才判得出来。 */
  args?: Record<string, unknown>,
  /** WP86：{@link mcpReadToolMap} 的结果；不给 = 每个 `mcp__*` 工具都按写。 */
  mcpReadTools?: ReadonlyMap<string, ReadonlySet<string>>,
): ToolSideEffect {
  const bare = tool.includes('.') ? tool.slice(tool.indexOf('.') + 1) : tool
  const explicit = overrides?.[tool] ?? overrides?.[bare]
  if (explicit !== undefined) return explicit
  // WP82：浏览器工具走自己那张显式表；表外的一律按写（上游随时会加新工具，
  // 新来的那个默认进不了公司端——这正是我们要的方向）。
  const browser = browserToolName(tool)
  if (browser !== undefined) {
    if (browser === 'browser_tabs') {
      const action = args?.action
      return typeof action === 'string' && BROWSER_TABS_READ_ACTIONS.has(action)
        ? 'read_external'
        : 'write_external'
    }
    return BROWSER_READ_TOOLS.has(browser) ? 'read_external' : 'write_external'
  }
  /*
   * WP92（55 §10）：第二种浏览器（腾讯 BrowserSkill）的六个工具。
   *
   * 它们是**裸名**（`browser_page` / `browser_inspect` …，没有 `mcp__…__` 前缀），
   * 而且一个名字管好几件事，所以判定只能看 `args.action`——表在
   * `browserskill.ts` 的 `BROWSERSKILL_READ_ACTIONS` 里，表外一律按写。
   */
  const bsk = browserSkillToolName(tool)
  if (bsk !== undefined) return classifyBrowserSkillEffect(bsk, args)
  /*
   * WP86（55 §4 第三层）：preset 挂上来的 MCP 工具。
   *
   * 名字形状 `mcp__<serverName>__<rawName>`（上游 `mcp-client` 的命名规则）。
   * 判定只认连接目录里那张**人勾出来的只读清单**——MCP 协议没有读写标注，
   * 名字前缀也不可信（一台服务器叫 `get_everything` 的工具照样可以下单）。
   * 勾了的按 `read_external`，没勾的落到函数末尾的兜底 `write_external`。
   */
  const mcp = parseMcpToolName(tool)
  if (mcp !== undefined && mcpReadTools?.has(mcp.server) === true) {
    return mcpReadTools.get(mcp.server)?.has(mcp.tool) === true ? 'read_external' : 'write_external'
  }
  // WP44：Shopify 官方 Dev MCP 的三个工具**永远只读**（查文档 / 看 schema / 校验 GraphQL，
  // 碰不到任何店铺数据）。要显式列出来：它们既不是 `get_` 也不是 `list_` 开头，
  // 落到下面的兜底就会被当成"写外部"，在 executor 策略下一调就拒。
  if (isMcpReadTool(tool)) return 'read_external'
  if (bare === STAGE_TOOL || bare === DRAFT_TOOL || bare.startsWith('stage_')) return 'staged'
  if (READ_PREFIXES.some((p) => bare.startsWith(p))) return 'read_external'
  if (WRITE_PREFIXES.some((p) => bare.startsWith(p))) return 'write_external'
  return 'write_external'
}

/**
 * WP87：订单号与订单 id 不是一回事，这句话得写在模型看得见的地方。
 *
 * 出处：realistic 档（deepseek-v4.1-flash，dsh-subprocess）几乎每条场景的第一件事都是
 * `get_order({order_id: "1001"})`——客户信里写的是「Order #1001」——回「订单不存在：1001」，
 * 再花一到两次调用试出 `ord_1001`。一条运行只有 8 次工具调用的预算，
 * 光这一条就烧掉两次，剩下的不够写回信（报告目录里的 `aftersales__return-within-window.events.jsonl`）。
 *
 * 只改这一句、不改整张工具面：工具说明进 prompt 的静态前缀，多写一段等于每次调用都多付
 * 一份 token。同一批里写长版本（每个只读工具一句说明 + 补 `product_id`）实测让 fast 档的
 * `tokens_per_item` 涨 23%，超过门禁 5% 的线——那条路留在报告里当建议，不在这里落。
 */
const ORDER_ID_HINT =
  'Order id like "ord_1001" — a customer\'s "#1001" is the order number, not the id.'

/** 只读工具共用的模型可见参数（隐式开放对象根，多余键照样接得住）。 */
const READ_PARAMS = {
  order_id: { type: 'string', description: ORDER_ID_HINT },
  email: { type: 'string', description: 'Customer email to filter by.' },
  query: { type: 'string', description: 'Free-text query.' },
  thread_id: { type: 'string', description: 'Conversation thread id.' },
} as const

const STAGE_PARAMS = {
  order_id: { type: 'string', description: 'Order the refund belongs to.', required: true },
  amount: { type: 'number', description: 'Refund amount in the order currency.', required: true },
  currency: { type: 'string', description: 'ISO currency code.' },
  reason: { type: 'string', description: 'Why this refund is proposed.' },
  notes: {
    type: 'array',
    description: 'Why this refund is proposed (one line per reason).',
    items: { type: 'string' },
  },
} as const

/**
 * 收件人与引用**不进模型面**：13 §4「凭据与地址不经模型」，引用由宿主按知识层的命中补
 * （`runtime.ts` 的 `buildDraftPayload`）。模型多给的键 dsh 会忽略（对象根是开放的）。
 */
const DRAFT_PARAMS = {
  subject: { type: 'string', description: 'Reply subject.', required: true },
  body: { type: 'string', description: 'Reply body.', required: true },
} as const

export interface ReadToolHooks {
  /** 真正的读出口（与 stub 运行时同一套回调）。 */
  run(
    name: string,
    input: Record<string, unknown>,
  ): Promise<{
    status: 'ok' | 'error' | 'blocked'
    data?: unknown
    reason?: string
    provenance?: ObjectRef[]
  }>
  /** 把非 ok 的判定记回门禁账（运行时据此发 `tool.result{blocked}`）。 */
  note(callId: string, tool: string, status: 'error' | 'blocked', reason: string): void
  /** 工具结果自带的 provenance（mock connect 会给）。 */
  provenance(callId: string, refs: ObjectRef[]): void
}

export interface StageToolHooks {
  /** 走 dsh 的审批 seam；返回 undefined = 没批下来（fail-closed）。 */
  stage(callId: string, args: StageArgs): Promise<{ change_id: string } | undefined>
  draft(callId: string, args: Omit<DraftArgs, 'child_change_ids'>): Promise<CreateDraftResult>
}

function readTool(name: string, hooks: ReadToolHooks): ToolDefinition {
  return defineTool({
    name,
    description: `agentsws read tool ${name}`,
    parameters: READ_PARAMS,
    output: {
      schema: { type: 'json' },
      render: (_args, value) => renderToolResult(value),
    },
    async execute(args, exec) {
      const input = Object.fromEntries(
        Object.entries(args).filter(([, v]) => v !== undefined),
      ) as Record<string, unknown>
      const res = await hooks.run(name, input)
      if (res.status !== 'ok') {
        hooks.note(String(exec.callId), name, res.status, res.reason ?? res.status)
        throw new DshAdapterError(
          res.status === 'blocked' ? 'forbidden' : 'provider_error',
          res.reason ?? `${name} ${res.status}`,
        )
      }
      if (res.provenance !== undefined && res.provenance.length > 0) {
        hooks.provenance(String(exec.callId), res.provenance)
      }
      return (res.data ?? null) as JsonValue
    },
  })
}

function stageTool(hooks: StageToolHooks): ToolDefinition {
  return defineTool({
    name: STAGE_TOOL,
    description:
      'Propose a refund on an order. Nothing is applied: it creates an approval item for a colleague.',
    parameters: STAGE_PARAMS,
    output: {
      schema: { type: 'json' },
      render: (_args, value) => renderToolResult(value),
    },
    async execute(args, exec) {
      const res = await hooks.stage(String(exec.callId), {
        amount: args.amount,
        ...(args.order_id === undefined ? {} : { order_id: args.order_id }),
        ...(args.currency === undefined ? {} : { currency: args.currency }),
        ...(args.reason === undefined ? {} : { reason: args.reason }),
        ...(Array.isArray(args.notes)
          ? { notes: args.notes.filter((n): n is string => typeof n === 'string') }
          : {}),
      })
      if (res === undefined) {
        throw new DshAdapterError('not_approved', 'stage_refund 未获批准（fail-closed）')
      }
      return res as unknown as JsonValue
    },
  })
}

function draftTool(hooks: StageToolHooks): ToolDefinition {
  return defineTool({
    name: DRAFT_TOOL,
    // WP87：realistic 档里模型常把回信写在自己的正文里就收工（`model.jsonl` 的
    // `stop: "text"`，`tools_called` 里没有 draft_reply），于是一封信都没发出去。
    // 补的这半句是事实，不是迎合模型：不经这个工具写的字确实到不了任何人手上。
    description:
      'Propose an outbound reply. Nothing is sent: it creates an approval item. ' +
      'A reply you write outside this tool reaches nobody.',
    parameters: DRAFT_PARAMS,
    output: {
      schema: { type: 'json' },
      render: (_args, value) => renderToolResult(value),
    },
    async execute(args, exec) {
      const res = await hooks.draft(String(exec.callId), {
        subject: args.subject,
        body: args.body,
      })
      if (res === undefined) {
        throw new DshAdapterError('not_approved', 'draft_reply 未获批准（fail-closed）')
      }
      return res as unknown as JsonValue
    },
  })
}

/**
 * 一次运行注册的全部工具：allowlist 里的读工具 + 两个 staging 工具。
 *
 * 47 J3：按**查对象 → 查知识 → 提议动作**三组排（排序规则在 `@agentsws/ontology`，
 * 三个运行时共用同一份）。两个 staging 工具本来就在最后一组，位置不变；
 * 名字一个字都没改。组内仍按名字，所以同一 RunRequest 两次装配逐字节相同（17 §6.2）。
 */
export function buildToolDefinitions(
  req: RunRequest,
  read: ReadToolHooks,
  staging: StageToolHooks,
): ToolDefinition[] {
  const names = orderTools([...new Set(req.tools.allow)])
  const defs: ToolDefinition[] = names
    .filter((n) => n !== STAGE_TOOL && n !== DRAFT_TOOL)
    .map((n) => readTool(n, read))
  defs.push(stageTool(staging), draftTool(staging))
  return defs
}
