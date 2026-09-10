/**
 * Shopify 官方 Dev MCP 的**工具面定义**与**替身**（WP44 交付 5 的共用部分）。
 *
 * 为什么放在 stand-ins：`runtime-direct` 与 `dsh-adapter` 都要认得这三个工具
 * （一个要把它们的定义拼进 prompt，一个要把它们判成只读而不是"写外部"），
 * 而这两个包唯一共同的下游就是本包。定义只有一处，两个运行时不许各写一份。
 *
 * 真正去起那个 stdio 进程的实现在 `apps/server/src/shopify-devmcp.ts`；
 * 这里只有**名字、定义与一个确定性的替身**——模拟回路要在不联网的情况下
 * 把"改价之前先过一次官方校验"这条链跑通。
 */
import type { ToolDef } from '@agentsws/contracts'

/** 对模型暴露的三个名字（与 `apps/server/src/shopify-devmcp.ts` 必须一致）。 */
export const MCP_DOCS_TOOL = 'shopify.docs.search'
export const MCP_SCHEMA_TOOL = 'shopify.schema.introspect'
export const MCP_VALIDATE_TOOL = 'shopify.graphql.validate'

/**
 * 这三个**永远是只读的**。
 *
 * 这一条要写死而不是靠名字前缀去猜：`dsh-adapter` 的 `classifySideEffect` 判不出来的
 * 一律当 `write_external`（16 §3 的 fail-closed），而 `shopify.docs.search` 既不是
 * `get_` 也不是 `list_` 开头——不显式列出来，模型会发现这三个工具一调就被门禁拒掉。
 */
export const MCP_READ_TOOLS: readonly string[] = [MCP_DOCS_TOOL, MCP_SCHEMA_TOOL, MCP_VALIDATE_TOOL]

export function isMcpReadTool(name: string): boolean {
  return MCP_READ_TOOLS.includes(name)
}

/**
 * 工具定义（进 prompt 的那一份）。
 *
 * 描述写得比别的工具长，因为它们要教模型一件事：**写之前先查、先验**。
 * 这句话放在工具描述里比放在 persona 里管用——模型是在挑工具的那一刻读它的。
 */
export const MCP_TOOL_DEFS: readonly ToolDef[] = [
  {
    name: MCP_DOCS_TOOL,
    description:
      'Search the official Shopify developer documentation. Read-only: it never touches a store. ' +
      'Use it before proposing any change, so field and mutation names come from the docs rather than memory.',
    input_schema: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string', description: 'What you want to know, in plain English.' },
      },
    },
  },
  {
    name: MCP_SCHEMA_TOOL,
    description:
      'Load the Shopify Admin GraphQL schema context for an API surface. Read-only. ' +
      'Use it to confirm a type, field or mutation actually exists.',
    input_schema: {
      type: 'object',
      properties: {
        api: { type: 'string', description: 'admin (default), storefront, functions, liquid…' },
        query: { type: 'string', description: 'Type or mutation name to look up.' },
      },
    },
  },
  {
    name: MCP_VALIDATE_TOOL,
    description:
      'Validate a GraphQL document against the real Shopify schema. Read-only: it does NOT execute anything. ' +
      'Every write you propose must pass this first — an invalid document is a change that could never be applied.',
    input_schema: {
      type: 'object',
      required: ['document'],
      properties: {
        document: { type: 'string', description: 'The GraphQL query or mutation, as text.' },
        api: { type: 'string', description: 'Which API surface. Default: admin.' },
      },
    },
  },
]

/** 名字 → 定义（`runtime-direct` 拿它把占位定义换成真的）。 */
export const MCP_TOOL_DEF_BY_NAME: ReadonlyMap<string, ToolDef> = new Map(
  MCP_TOOL_DEFS.map((d) => [d.name, d]),
)

// ── 替身 ───────────────────────────────────────────────────────────────

export interface MockDevMcpOptions {
  /**
   * 判一段 GraphQL 成不成立。不给就用 {@link defaultVerdict}：
   * 认得出几种最常见的编造（`priceV2`、`productVariantUpdate` 这类真不存在的名字）。
   */
  verdict?: (document: string) => { valid: boolean; errors: string[] }
}

export interface MockDevMcpResult {
  status: 'ok' | 'error'
  data?: unknown
  reason?: string
}

/**
 * 模拟回路里的 Dev MCP：**确定性**、不联网、不起进程。
 *
 * 它不是"假装什么都对"——{@link defaultVerdict} 认得出几个真实存在的幻觉字段名，
 * 所以场景里可以写一条"模型编了个 `priceV2`，被官方校验挡下"的回归题。
 */
export class MockDevMcp {
  readonly calls: { tool: string; input: Record<string, unknown> }[] = []
  readonly #verdict: (document: string) => { valid: boolean; errors: string[] }

  constructor(options: MockDevMcpOptions = {}) {
    this.#verdict = options.verdict ?? defaultVerdict
  }

  /** 这个替身认哪几个工具。 */
  tools(): readonly string[] {
    return MCP_READ_TOOLS
  }

  execute(tool: string, input: Record<string, unknown>): MockDevMcpResult {
    this.calls.push({ tool, input })
    if (tool === MCP_DOCS_TOOL) {
      const query = typeof input.query === 'string' ? input.query : ''
      return {
        status: 'ok',
        data: {
          query,
          // 09-10 实查过的真名字：改价走 bulk 那一条，单变体的 productVariantUpdate 不存在
          hits: [
            {
              title: 'productVariantsBulkUpdate',
              excerpt:
                'Updates variants of a product. Use `price` on ProductVariantsBulkInput to change a price.',
            },
          ],
        },
      }
    }
    if (tool === MCP_SCHEMA_TOOL) {
      return {
        status: 'ok',
        data: {
          api: typeof input.api === 'string' ? input.api : 'admin',
          types: ['Product', 'ProductVariant', 'Order', 'OnlineStoreTheme'],
          mutations: ['productVariantsBulkUpdate', 'productUpdate', 'themePublish'],
        },
      }
    }
    if (tool === MCP_VALIDATE_TOOL) {
      const document = typeof input.document === 'string' ? input.document : ''
      if (document.trim() === '') {
        return { status: 'error', reason: 'GraphQL 是空的' }
      }
      const out = this.#verdict(document)
      return {
        status: 'ok',
        data: out.valid
          ? { result: 'success', detail: 'Validation passed: all code blocks are valid.' }
          : { result: 'failed', errors: out.errors },
      }
    }
    return { status: 'error', reason: `MockDevMcp 不认识这个工具：${tool}` }
  }
}

/** 几个真实存在的幻觉：模型很爱编这些名字。 */
const KNOWN_HALLUCINATIONS: readonly { pattern: RegExp; says: string }[] = [
  {
    pattern: /\bpriceV2\b/,
    says: 'Cannot query field "priceV2" on type "ProductVariant". Did you mean "price"?',
  },
  {
    pattern: /\bproductVariantUpdate\b/,
    says: 'Cannot query field "productVariantUpdate" on type "Mutation". Did you mean "productVariantsBulkUpdate"?',
  },
  {
    pattern: /\bfulfillmentCreateV2\b/,
    says: '"fulfillmentCreateV2" is deprecated and removed. Did you mean "fulfillmentCreate"?',
  },
  {
    pattern: /\bproductPublish\b/,
    says: '"productPublish" is deprecated. Did you mean "publishablePublish"?',
  },
]

export function defaultVerdict(document: string): { valid: boolean; errors: string[] } {
  const errors = KNOWN_HALLUCINATIONS.filter((h) => h.pattern.test(document)).map((h) => h.says)
  return { valid: errors.length === 0, errors }
}
