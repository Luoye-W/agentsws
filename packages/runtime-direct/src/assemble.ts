import type { ChatMessage, RunRequest, ToolDef } from '@agentsws/contracts'
import { estimateInputTokens, staticPrefixHash } from '@agentsws/model-gateway'
import { assemblePrompt, assemblePromptHash, MCP_TOOL_DEF_BY_NAME } from '@agentsws/stand-ins'

/**
 * 17 §1 装配顺序：静态前缀（persona 段 → skills 索引行 → 工具定义）→ 策略层 ContextItem →
 * 工作项上下文（按新近度到 cap）→ `app_events` → 用户消息。
 *
 * **不重写这个顺序**：定义只有一处（`@agentsws/stand-ins` 的 `assemblePrompt`），
 * 铁律（17 §6.1 / 26 六条不变量的 `prompt_replayable`）就是从事件日志用同一个函数重组比对的。
 * direct-llm 只在它之上加自己的两个产出工具定义。
 */

/** 15 §5 stage 的意图：模型只表达"要改什么"，账本与门禁由宿主回调负责。 */
export const STAGE_REFUND_TOOL = 'stage_refund'
/** 14 §2 对外草稿：模型写正文，审批项由宿主回调建。 */
export const DRAFT_REPLY_TOOL = 'draft_reply'

export const OUTPUT_TOOLS: readonly string[] = [DRAFT_REPLY_TOOL, STAGE_REFUND_TOOL]

/** 产出工具是宿主回调，不是外部 Action：不过 Connect allowlist，也永远不写外部。 */
export function outputToolDefs(req: RunRequest): ToolDef[] {
  const wants = new Set(req.expectations.outputs)
  const defs: ToolDef[] = []
  if (wants.has('draft')) {
    defs.push({
      name: DRAFT_REPLY_TOOL,
      description:
        'Draft a reply to the customer. The draft goes to a colleague for approval; it is never sent directly.',
      input_schema: {
        type: 'object',
        required: ['to', 'subject', 'body'],
        properties: {
          to: { type: 'array', items: { type: 'string' } },
          subject: { type: 'string' },
          body: { type: 'string' },
          citations: {
            type: 'array',
            items: {
              type: 'object',
              properties: { fact_card_id: { type: 'string' }, quote: { type: 'string' } },
            },
          },
        },
      },
    })
  }
  if (wants.has('staged_change') || req.expectations.must_stage_if_change_requested) {
    defs.push({
      name: STAGE_REFUND_TOOL,
      description:
        'Stage a refund on an order. Staging only proposes the change; a colleague approves and the executor applies it.',
      input_schema: {
        type: 'object',
        required: ['order_id', 'amount'],
        properties: {
          order_id: { type: 'string' },
          amount: { type: 'number' },
          currency: { type: 'string' },
          notes: { type: 'array', items: { type: 'string' } },
        },
      },
    })
  }
  return defs.sort((a, b) => a.name.localeCompare(b.name))
}

export interface DirectPrompt {
  messages: ChatMessage[]
  tools: ToolDef[]
  /** 17 §2 `prompt.assembled.hash`：与回放重组用的是同一个式子。 */
  hash: string
  /** 22 §2 缓存纪律：静态前缀字节稳定，两次装配必然相同。 */
  static_prefix_hash: string
  total_tokens: number
}

/**
 * WP44：MCP 只读工具（`shopify.docs.search` / `.schema.introspect` / `.graphql.validate`）
 * 的定义换成真的。
 *
 * `assemblePrompt` 对 `tools.allow` 里的每个名字只会生成一句 `stand-in tool <name>` 的
 * 占位描述——对普通读工具够用（模型从名字就猜得出 `get_order` 干什么），对这三个不够：
 * 它们的价值恰恰在描述里那句"**写之前先查、先验**"。模型是在挑工具的那一刻读描述的，
 * 这句话放在这儿比放在 persona 里管用。
 *
 * 只替换、不新增：`allow` 里没有的名字不会凭空出现在工具表里。
 */
function withMcpDefs(tools: ToolDef[]): ToolDef[] {
  return tools.map((t) => MCP_TOOL_DEF_BY_NAME.get(t.name) ?? t)
}

/** 装配一次运行的 prompt（静态前缀在前，产出工具定义并入工具表）。 */
export function assembleDirect(req: RunRequest): DirectPrompt {
  const base = assemblePrompt(req)
  const tools = [...withMcpDefs(base.tools), ...outputToolDefs(req)]
  return {
    messages: base.messages,
    tools,
    hash: assemblePromptHash(req),
    static_prefix_hash: staticPrefixHash(base.messages, tools),
    total_tokens: estimateInputTokens(base.messages, tools, 4),
  }
}
