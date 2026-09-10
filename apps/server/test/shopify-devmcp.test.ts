/**
 * Shopify 官方 Dev MCP 接进运行时（WP44 交付 5）。
 *
 * 测试对着一个**说真 MCP 协议的假 server**（`fixtures/fake-dev-mcp.mjs`，用真子进程起），
 * 所以覆盖到的是真正的 `initialize` → `tools/list` → `tools/call` 那条链，
 * 包括新旧两代工具名的映射与 `conversationId` 的串接。
 */
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createShopifyDevMcp,
  DEV_MCP_TOOLS,
  DOCS_TOOL,
  guardGraphqlStage,
  readVerdict,
  SCHEMA_TOOL,
  type ShopifyDevMcp,
  VALIDATE_TOOL,
} from '../src/shopify-devmcp.js'

const FAKE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-dev-mcp.mjs')

const open: ShopifyDevMcp[] = []
let logFile: string

/**
 * 剧本经**命令行参数**给假 server——环境白名单会把自定义变量筛掉，那正是它该做的事。
 */
function makeMcp(
  script: { flavor?: string; verdict?: string } = {},
  opts: { events?: { type: string; payload: Record<string, unknown> }[] } = {},
): ShopifyDevMcp {
  logFile = join(mkdtempSync(join(tmpdir(), 'agentsws-mcp-')), 'calls.jsonl')
  const mcp = createShopifyDevMcp({
    command: process.execPath,
    args: [
      FAKE,
      `--log=${logFile}`,
      ...(script.flavor === undefined ? [] : [`--flavor=${script.flavor}`]),
      ...(script.verdict === undefined ? [] : [`--verdict=${script.verdict}`]),
    ],
    env: { PATH: process.env.PATH ?? '' },
    timeoutMs: 15_000,
    ...(opts.events === undefined
      ? {}
      : { appendEvent: (type, payload) => opts.events?.push({ type, payload }) }),
  })
  open.push(mcp)
  return mcp
}

/** 假 server 记下的每次 tools/call。 */
function upstreamCalls(): { name: string; args: Record<string, unknown> }[] {
  if (!existsSync(logFile)) return []
  return readFileSync(logFile, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as { name: string; args: Record<string, unknown> })
}

afterEach(async () => {
  for (const mcp of open.splice(0)) await mcp.close()
})

describe('WP44 §5 起 Dev MCP：新旧两代工具名都认', () => {
  it('1.15 那一代：三个我们的名字各自映射到上游哪一个', async () => {
    const mcp = makeMcp()
    const status = await mcp.start()
    expect(status.available).toBe(true)
    expect(status.server?.name).toBe('shopify-dev-mcp')
    expect(status.mapped).toEqual({
      [DOCS_TOOL]: 'search_docs_chunks',
      [SCHEMA_TOOL]: 'learn_shopify_api',
      [VALIDATE_TOOL]: 'validate_graphql_codeblocks',
    })
    // 新版的工具要先跑一次 learn_shopify_api 才认这个会话
    expect(upstreamCalls()[0]?.name).toBe('learn_shopify_api')
  })

  it('老一代：introspect_admin_schema 还在时优先用它', async () => {
    const status = await makeMcp({ flavor: 'legacy' }).start()
    expect(status.mapped[SCHEMA_TOOL]).toBe('introspect_admin_schema')
    expect(status.mapped[DOCS_TOOL]).toBe('search_dev_docs')
  })

  it('起来了但一个认识的工具都没有 → available: false + 一句原因', async () => {
    const status = await makeMcp({ flavor: 'empty' }).start()
    expect(status.available).toBe(false)
    expect(status.reason).toContain('版本对不上')
  })

  it('start() 幂等：调两次只起一次', async () => {
    const mcp = makeMcp()
    const [a, b] = await Promise.all([mcp.start(), mcp.start()])
    expect(a).toBe(b)
    expect(upstreamCalls().filter((c) => c.name === 'learn_shopify_api')).toHaveLength(1)
  })
})

describe('WP44 §5 工具面：三个只读工具，名字是我们的', () => {
  it('toolDefs 只给这三个，描述里说清楚"不碰店铺"', async () => {
    const mcp = makeMcp()
    await mcp.start()
    const defs = mcp.toolDefs()
    expect(defs.map((d) => d.name).sort()).toEqual([...DEV_MCP_TOOLS].sort())
    for (const def of defs) {
      expect(def.description.toLowerCase()).toContain('read-only')
    }
  })

  it('起不来就不给工具定义：别让模型看见调不动的工具', async () => {
    const mcp = createShopifyDevMcp({
      command: process.execPath,
      args: [join(dirname(FAKE), 'does-not-exist.mjs')],
      env: { PATH: process.env.PATH ?? '' },
      timeoutMs: 3000,
    })
    open.push(mcp)
    const status = await mcp.start()
    expect(status.available).toBe(false)
    expect(mcp.toolDefs()).toEqual([])
  })

  it('入参名跟着上游走：docs 的 query → prompt，会话 id 自动带上', async () => {
    const mcp = makeMcp()
    await mcp.start()
    const out = await mcp.call(DOCS_TOOL, { query: '怎么改变体价格' })
    expect(out.text).toContain('productVariantsBulkUpdate')
    const call = upstreamCalls().find((c) => c.name === 'search_docs_chunks')
    expect(call?.args.prompt).toBe('怎么改变体价格')
    expect(call?.args.conversationId).toBe('b3f0c1de-2a44-4d61-9c37-7f21a0d5e8ab')
  })

  it('schema 退化到 learn_shopify_api 时不把 query 传下去（它不认这个参数）', async () => {
    const mcp = makeMcp()
    await mcp.start()
    await mcp.call(SCHEMA_TOOL, { query: 'ProductVariant' })
    const call = upstreamCalls()
      .filter((c) => c.name === 'learn_shopify_api')
      .at(-1)
    expect(call?.args.query).toBeUndefined()
    expect(call?.args.api).toBe('admin')
  })
})

describe('WP44 §5 GraphQL 校验', () => {
  it('过了：status valid', async () => {
    const mcp = makeMcp()
    await mcp.start()
    const verdict = await mcp.validateGraphql({
      document:
        'mutation { productVariantsBulkUpdate(productId: "1", variants: []) { userErrors { field } } }',
    })
    expect(verdict.status).toBe('valid')
    // 文档是按"代码块数组"传下去的（1.15 的形状）
    const call = upstreamCalls().find((c) => c.name === 'validate_graphql_codeblocks')
    expect(Array.isArray(call?.args.codeblocks)).toBe(true)
    expect(call?.args.api).toBe('admin')
  })

  it('没过：把官方那句 "Did you mean" 原样带回来', async () => {
    const mcp = makeMcp({ verdict: 'invalid' })
    await mcp.start()
    const verdict = await mcp.validateGraphql({ document: 'mutation { x(priceV2: 1) { id } }' })
    expect(verdict.status).toBe('invalid')
    if (verdict.status !== 'invalid') throw new Error('unreachable')
    expect(verdict.errors.join('\n')).toContain('Did you mean')
  })

  it('空文档不劳烦上游', async () => {
    const mcp = makeMcp()
    await mcp.start()
    expect((await mcp.validateGraphql({ document: '   ' })).status).toBe('invalid')
    expect(upstreamCalls().some((c) => c.name === 'validate_graphql_codeblocks')).toBe(false)
  })

  it('Dev MCP 没起来 → unavailable，而不是假装通过', async () => {
    const mcp = makeMcp({ flavor: 'empty' })
    await mcp.start()
    expect((await mcp.validateGraphql({ document: 'query { shop { id } }' })).status).toBe(
      'unavailable',
    )
  })

  it('readVerdict：读不懂的结果算"没校验"，绝不算"通过"', () => {
    expect(readVerdict('¯\\_(ツ)_/¯').status).toBe('unavailable')
    expect(readVerdict('Validation passed').status).toBe('valid')
    expect(readVerdict('Cannot query field "foo"').status).toBe('invalid')
  })
})

describe('WP44 §5 stage 前的那道关', () => {
  it('校验通过 → 放行，degraded: false', async () => {
    const mcp = makeMcp()
    await mcp.start()
    const out = await guardGraphqlStage(mcp, { document: 'mutation { productUpdate { id } }' })
    expect(out).toMatchObject({ ok: true, degraded: false })
  })

  it('校验不过 → 拦住，官方错误交回给模型，并记一条事件', async () => {
    const events: { type: string; payload: Record<string, unknown> }[] = []
    const mcp = makeMcp({ verdict: 'invalid' })
    await mcp.start()
    const out = await guardGraphqlStage(
      mcp,
      { document: 'mutation { x(priceV2: 1) { id } }' },
      (type, payload) => events.push({ type, payload }),
    )
    expect(out.ok).toBe(false)
    if (out.ok) throw new Error('unreachable')
    expect(out.reason).toContain('改完再提一次')
    expect(events.map((e) => e.type)).toEqual(['shopify.graphql_rejected'])
  })

  it('Dev MCP 起不来 → 仍可 stage（degraded），但记一条事件让审批的人知道', async () => {
    const events: { type: string; payload: Record<string, unknown> }[] = []
    const mcp = makeMcp({ flavor: 'empty' })
    await mcp.start()
    const out = await guardGraphqlStage(
      mcp,
      { document: 'mutation { productUpdate { id } }' },
      (type, payload) => events.push({ type, payload }),
    )
    expect(out).toMatchObject({ ok: true, degraded: true })
    if (!out.ok) throw new Error('unreachable')
    expect(out.detail).toContain('没经过官方校验')
    expect(events.map((e) => e.type)).toEqual(['shopify.graphql_unvalidated'])
  })
})

describe('WP44 §5 不给它任何秘密', () => {
  it('子进程环境走白名单，还关掉了官方遥测', async () => {
    // 假 server 把自己的环境回不出来，所以直接对着 spawn 的入参断言
    let captured: Record<string, string> | undefined
    const mcp = createShopifyDevMcp({
      env: {
        PATH: '/usr/bin',
        AGENTSWS_SECRETS_KEY: 'must-not-leak',
        OOMOL_CONNECT_ADMIN_TOKEN: 'must-not-leak',
        DEEPSEEK_API_KEY: 'must-not-leak',
      },
      spawnMcp: (_cmd, _args, opts) => {
        captured = opts.env
        return {
          send: () => {},
          onLine: () => {},
          close: () => {},
          exited: Promise.resolve(0),
        }
      },
      timeoutMs: 50,
    })
    open.push(mcp)
    await mcp.start()
    expect(captured?.PATH).toBe('/usr/bin')
    expect(JSON.stringify(captured)).not.toContain('must-not-leak')
    // 官方发布版会把工具输入与结果上报到 shopify.dev；我们的运行内容不该出门
    expect(captured?.OPT_OUT_INSTRUMENTATION).toBe('true')
    expect(captured?.DO_NOT_TRACK).toBe('1')
  })
})

describe('WP44 起不来先重试一次', () => {
  it('第一次 initialize 超时、第二次成功 → 最终 available，只记一条 unavailable', async () => {
    const events: { type: string; payload: Record<string, unknown> }[] = []
    let spawns = 0
    const mcp = createShopifyDevMcp({
      env: { PATH: process.env.PATH ?? '' },
      timeoutMs: 2000,
      initTimeoutMs: 100,
      retryDelayMs: 10,
      appendEvent: (type, payload) => events.push({ type, payload }),
      spawnMcp: () => {
        spawns += 1
        const answers = spawns >= 2
        let cb: (line: string) => void = () => {}
        let exit: (code: number) => void = () => {}
        const exited = new Promise<number>((resolve) => {
          exit = resolve
        })
        return {
          send(line) {
            if (!answers) return
            const req = JSON.parse(line) as { id?: number; method: string }
            if (typeof req.id !== 'number') return
            const result =
              req.method === 'initialize'
                ? { serverInfo: { name: 'fake', version: '0' } }
                : req.method === 'tools/list'
                  ? {
                      tools: [
                        { name: 'search_docs_chunks' },
                        { name: 'validate_graphql_codeblocks' },
                      ],
                    }
                  : {}
            setTimeout(() => cb(JSON.stringify({ jsonrpc: '2.0', id: req.id, result })), 1)
          },
          onLine(fn) {
            cb = fn
          },
          close() {
            exit(0)
          },
          exited,
        }
      },
    })
    open.push(mcp)
    const status = await mcp.start()
    expect(spawns).toBe(2)
    expect(status.available).toBe(true)
    expect(events.map((e) => e.type)).toEqual([
      'shopify.devmcp_unavailable',
      'shopify.devmcp_started',
    ])
    expect(String(events[0]?.payload.reason)).toContain('超时')
  })
})
