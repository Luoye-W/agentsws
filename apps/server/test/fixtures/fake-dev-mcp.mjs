/**
 * 假的 Shopify Dev MCP server（WP44 测试用）。
 *
 * 说的是真的 MCP stdio 协议（换行分隔的 JSON-RPC 2.0），所以测试跑到的是
 * `shopify-devmcp.ts` 里真正的 `initialize` → `tools/list` → `tools/call` 那条链，
 * 而不是对着一个注入的假函数自说自话。
 *

 * 剧本靠**命令行参数**给，不靠环境变量——被测代码的环境白名单会把自定义变量筛掉，
 * 那正是它该做的事（见 `shopify-devmcp.ts` 的纪律 3）。
 *
 * - `--flavor=modern`（默认）：装 1.15 那一代工具名
 *   （`learn_shopify_api` / `search_docs_chunks` / `validate_graphql_codeblocks`）；
 *   `legacy` 装老一代（`search_dev_docs` / `introspect_admin_schema` / …）；
 *   `empty` 一个工具都不给（用来验"起来了但对不上版本"）。
 * - `--verdict=valid|invalid`：校验器说这段 GraphQL 过没过。
 * - `--log=<path>`：每次 tools/call 记一行，测试读它断言参数怎么传下去的。
 */
import { createInterface } from 'node:readline'

const flag = (name, fallback) =>
  process.argv.slice(2).find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback
const flavor = flag('flavor', 'modern')
const verdict = flag('verdict', 'valid')
const CONVERSATION = 'b3f0c1de-2a44-4d61-9c37-7f21a0d5e8ab'

const MODERN = [
  {
    name: 'learn_shopify_api',
    description: 'Load API surface instructions',
    inputSchema: { type: 'object', properties: { api: { type: 'string' } }, required: ['api'] },
  },
  {
    name: 'search_docs_chunks',
    description: 'Search shopify.dev',
    inputSchema: {
      type: 'object',
      properties: { prompt: { type: 'string' }, conversationId: { type: 'string' } },
      required: ['prompt', 'conversationId'],
    },
  },
  {
    name: 'validate_graphql_codeblocks',
    description: 'Validate GraphQL code blocks',
    inputSchema: {
      type: 'object',
      properties: {
        api: { type: 'string' },
        codeblocks: { type: 'array' },
        conversationId: { type: 'string' },
      },
      required: ['api', 'codeblocks', 'conversationId'],
    },
  },
]

const LEGACY = [
  { name: 'search_dev_docs', inputSchema: { type: 'object', properties: { prompt: {} } } },
  { name: 'introspect_admin_schema', inputSchema: { type: 'object', properties: { query: {} } } },
  {
    name: 'validate_graphql_codeblocks',
    inputSchema: { type: 'object', properties: { codeblocks: {} } },
  },
]

const tools = flavor === 'legacy' ? LEGACY : flavor === 'empty' ? [] : MODERN

/** 每次 tools/call 都记一行，测试读它来断言"参数是怎么传下去的"。 */
const logFile = flag('log', undefined)
const log = async (entry) => {
  if (logFile === undefined) return
  const { appendFileSync } = await import('node:fs')
  appendFileSync(logFile, `${JSON.stringify(entry)}\n`)
}

const text = (t) => ({ content: [{ type: 'text', text: t }] })

const reply = (id, result) => {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`)
}

createInterface({ input: process.stdin }).on('line', async (line) => {
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  if (msg.method === 'initialize') {
    reply(msg.id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'shopify-dev-mcp', version: '1.15.0' },
    })
    return
  }
  if (msg.method === 'notifications/initialized') return
  if (msg.method === 'tools/list') {
    reply(msg.id, { tools })
    return
  }
  if (msg.method === 'tools/call') {
    const { name, arguments: args } = msg.params ?? {}
    await log({ name, args })
    if (name === 'learn_shopify_api') {
      reply(msg.id, text(`Loaded admin API. conversationId: ${CONVERSATION}`))
      return
    }
    if (name === 'search_docs_chunks' || name === 'search_dev_docs') {
      reply(msg.id, text('productVariantsBulkUpdate(productId: ID!, variants: [...]!)'))
      return
    }
    if (name === 'introspect_admin_schema') {
      reply(msg.id, text('type Mutation { productVariantsBulkUpdate(...): ... }'))
      return
    }
    if (name === 'validate_graphql_codeblocks') {
      reply(
        msg.id,
        text(
          verdict === 'invalid'
            ? '{"result": "failed"}\nCannot query field "priceV2" on type "ProductVariant". Did you mean "price"?'
            : '{"result": "success"}\nValidation passed: all code blocks are valid.',
        ),
      )
      return
    }
    reply(msg.id, text(`unknown tool ${name}`))
    return
  }
  if (typeof msg.id === 'number') {
    process.stdout.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } })}\n`,
    )
  }
})
