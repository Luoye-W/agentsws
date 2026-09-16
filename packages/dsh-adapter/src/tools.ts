/**
 * 把 RunRequest 的工具变成 dsh 工具（`ctx.tools.register`）。
 *
 * 三类：
 * - 只读工具（`req.tools.allow` 里的）→ 注入的 `executeTool` 出口
 * - `stage_refund` / `draft_reply` → 先过 dsh 的审批 seam（answerer），再落到注入的 `stage` / `createDraft`
 * - 写外部工具（`create_refund` 之类）→ 注册但由 `tools/pre-execute` 在 executor 策略下一律拒
 */
import type { ObjectRef, RunRequest } from '@agentsws/contracts'
import { EXTERNAL_FENCE, redactOutbound } from '@agentsws/core'
import { orderTools } from '@agentsws/ontology'
import type { CreateDraftResult } from '@agentsws/stand-ins'
import { isMcpReadTool } from '@agentsws/stand-ins'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
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

/** 16 §3：判定不了的按 `write_external` 处理（最严）。 */
export function classifySideEffect(
  tool: string,
  overrides?: Record<string, ToolSideEffect>,
): ToolSideEffect {
  const bare = tool.includes('.') ? tool.slice(tool.indexOf('.') + 1) : tool
  const explicit = overrides?.[tool] ?? overrides?.[bare]
  if (explicit !== undefined) return explicit
  // WP44：Shopify 官方 Dev MCP 的三个工具**永远只读**（查文档 / 看 schema / 校验 GraphQL，
  // 碰不到任何店铺数据）。要显式列出来：它们既不是 `get_` 也不是 `list_` 开头，
  // 落到下面的兜底就会被当成"写外部"，在 executor 策略下一调就拒。
  if (isMcpReadTool(tool)) return 'read_external'
  if (bare === STAGE_TOOL || bare === DRAFT_TOOL || bare.startsWith('stage_')) return 'staged'
  if (READ_PREFIXES.some((p) => bare.startsWith(p))) return 'read_external'
  if (WRITE_PREFIXES.some((p) => bare.startsWith(p))) return 'write_external'
  return 'write_external'
}

/** 只读工具共用的模型可见参数（隐式开放对象根，多余键照样接得住）。 */
const READ_PARAMS = {
  order_id: { type: 'string', description: 'Order id to read.' },
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
    description: 'Propose an outbound reply. Nothing is sent: it creates an approval item.',
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
