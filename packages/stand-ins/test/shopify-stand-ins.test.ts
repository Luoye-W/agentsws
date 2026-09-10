/**
 * WP44 的两个 Shopify 替身：官方 Dev MCP（查文档 / 校验 GraphQL）与主题 CLI。
 *
 * 这两个替身的价值全在"它们会说不"上：
 * - Dev MCP 替身要真的认得出几个模型爱编的名字，否则场景里那条
 *   "幻觉进不了人的队列"的回归题验的是个空气；
 * - 主题 CLI 替身要保证 `push` 造出来的永远是副本，线上那一份只有 `publish` 能换。
 */
import type { Iso8601 } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import {
  defaultState,
  defaultVerdict,
  isMcpReadTool,
  MCP_DOCS_TOOL,
  MCP_READ_TOOLS,
  MCP_SCHEMA_TOOL,
  MCP_TOOL_DEF_BY_NAME,
  MCP_VALIDATE_TOOL,
  MockDevMcp,
  MockShopifyCli,
  type MockState,
} from '../src/index.js'

const AT = '2026-09-07T09:00:00.000Z' as Iso8601

/** 一份只关心主题那一格的店铺状态（其余照默认，这两条替身碰不到）。 */
function themeState(): MockState {
  const state = defaultState(AT)
  state.themes = [{ id: 'thm_live', name: 'Dawn（现行主题）', role: 'main', updated_at: AT }]
  return state
}

describe('Dev MCP 替身（WP44 交付 5 的模拟侧）', () => {
  it('三个工具都是只读的，而且定义只有一处', () => {
    // dsh-adapter 的 fail-closed 兜底会把认不出来的判成写外部；
    // 这三个名字既不是 get_ 也不是 list_ 开头，所以必须显式在册
    expect(MCP_READ_TOOLS).toEqual([MCP_DOCS_TOOL, MCP_SCHEMA_TOOL, MCP_VALIDATE_TOOL])
    for (const name of MCP_READ_TOOLS) {
      expect(isMcpReadTool(name)).toBe(true)
      expect(MCP_TOOL_DEF_BY_NAME.get(name)?.name).toBe(name)
    }
    expect(isMcpReadTool('shopify_admin.update_product_price')).toBe(false)
  })

  it('查文档回的是 09-10 实查过的真名字（不是模型记忆里那个）', () => {
    const mcp = new MockDevMcp()
    const out = mcp.execute(MCP_DOCS_TOOL, { query: 'change a product price' })
    expect(out.status).toBe('ok')
    const hits = (out.data as { hits: { title: string }[] }).hits
    expect(hits.map((h) => h.title)).toContain('productVariantsBulkUpdate')
  })

  it('校验器认得出几个模型爱编的名字，并把官方那句 Did you mean 原样交回', () => {
    const mcp = new MockDevMcp()
    const bad = mcp.execute(MCP_VALIDATE_TOOL, {
      document: 'mutation { productVariantUpdate(input: { price: "99" }) { id } }',
    })
    const badData = bad.data as { result: string; errors: string[] }
    expect(badData.result).toBe('failed')
    // 这句原样交回给模型才有用——它自己就能改对
    expect(badData.errors.join('；')).toContain('Did you mean "productVariantsBulkUpdate"')

    const good = mcp.execute(MCP_VALIDATE_TOOL, {
      document:
        'mutation { productVariantsBulkUpdate(productId: "p1", variants: []) { userErrors { field } } }',
    })
    expect((good.data as { result: string }).result).toBe('success')
  })

  it('空 GraphQL 与不认识的工具都回 error——绝不悄悄判成"通过"', () => {
    const mcp = new MockDevMcp()
    expect(mcp.execute(MCP_VALIDATE_TOOL, { document: '  ' }).status).toBe('error')
    expect(mcp.execute('shopify.admin.execute', {}).status).toBe('error')
  })

  it('每一次调用都记在 calls 里（场景断言"真的查了、真的验了"读它）', () => {
    const mcp = new MockDevMcp()
    mcp.execute(MCP_DOCS_TOOL, { query: 'x' })
    mcp.execute(MCP_SCHEMA_TOOL, {})
    expect(mcp.calls.map((c) => c.tool)).toEqual([MCP_DOCS_TOOL, MCP_SCHEMA_TOOL])
  })

  it('判决可以换掉：场景要造别的幻觉时不用改替身', () => {
    const mcp = new MockDevMcp({ verdict: () => ({ valid: false, errors: ['nope'] }) })
    const out = mcp.execute(MCP_VALIDATE_TOOL, { document: 'mutation { productUpdate { id } }' })
    expect((out.data as { errors: string[] }).errors).toEqual(['nope'])
    // 默认判决对同一段是放行的，证明上面那条走的是注入的那个
    expect(defaultVerdict('mutation { productUpdate { id } }').valid).toBe(true)
  })
})

describe('主题 CLI 替身（WP44 交付 4 的模拟侧）', () => {
  it('push 造出来的永远是副本，线上那一份一个字节不动', () => {
    const state = themeState()
    const cli = new MockShopifyCli({ state, now: () => AT })
    const a = cli.pushUnpublished({ name: '首页改版 v2' })
    const b = cli.pushUnpublished({ name: '首页改版 v3' })
    expect(a.theme_id).not.toBe(b.theme_id)
    // 预览链接就是审批材料，没有它人没法判断该不该发布
    expect(a.preview_url).toContain(a.theme_id)
    expect(cli.live()?.id).toBe('thm_live')
    expect(cli.list().filter((t) => t.role === 'unpublished')).toHaveLength(2)
  })

  it('publish 换线上那一份，旧的退回副本；重复发布同一份报错', () => {
    const state = themeState()
    const cli = new MockShopifyCli({ state, now: () => AT })
    const pushed = cli.pushUnpublished({ name: '首页改版 v2' })
    const out = cli.publish({ theme_id: pushed.theme_id })
    expect(out.previous_theme_id).toBe('thm_live')
    expect(cli.live()?.id).toBe(pushed.theme_id)
    // 一家店同一时刻只可能有一份线上主题
    expect(cli.list().filter((t) => t.role === 'main')).toHaveLength(1)
    expect(() => cli.publish({ theme_id: pushed.theme_id })).toThrow(/已经是线上主题/)
    expect(() => cli.publish({ theme_id: 'thm_nope' })).toThrow(/主题不存在/)
  })

  it('每条命令都记一笔——但只记命令名与主题 id', () => {
    const state = themeState()
    const seen: { cmd: string; detail: Record<string, unknown> }[] = []
    const cli = new MockShopifyCli({
      state,
      now: () => AT,
      onCommand: (cmd, detail) => {
        seen.push({ cmd, detail })
      },
    })
    const pushed = cli.pushUnpublished({ name: 'v2' })
    cli.list()
    cli.publish({ theme_id: pushed.theme_id })
    expect(seen.map((s) => s.cmd)).toEqual([
      'theme push --unpublished',
      'theme list',
      'theme publish',
    ])
    // 主题名字都不进事件（它可能带客户的活动名），更别说令牌
    for (const s of seen) {
      expect(Object.keys(s.detail).every((k) => k === 'theme_id')).toBe(true)
    }
  })

  it('改的和读的是同一份状态：CLI 发布完，Admin 那侧看到的也变了', () => {
    const state = themeState()
    const cli = new MockShopifyCli({ state, now: () => AT })
    const pushed = cli.pushUnpublished({ name: 'v2' })
    cli.publish({ theme_id: pushed.theme_id })
    expect(state.themes.find((t) => t.role === 'main')?.id).toBe(pushed.theme_id)
  })
})
