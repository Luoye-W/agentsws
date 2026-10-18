/**
 * WP418（自查 A16）：建站四条 + 店铺管理 + 订单履约——职责 yml 里写的 grounding 工具必须真有执行器。
 *
 * 以前写了 `shopify.shop.get`、`site.checklist.run`、`shopify.theme.list`、`site.apps.list` 这些全仓没有的名字，
 * 运行时 `offerable` 悄悄过滤掉，测试拦不住——AI 手里就少了说明里承诺的工具。
 */
import { loadBundledRoles } from '@agentsws/roles'
import {
  COMPETITOR_STORE_TOOL_NAMES,
  noPlaybookAnswer,
  renderSiteChecklistAnswer,
  SHOP_TOOL_NAMES,
  SHOP_TOOLS_BY_ROLE,
  SITE_HEALTH_TOOL_NAMES,
  THEME_TOOL_NAMES,
} from '@agentsws/stand-ins'
import { describe, expect, it } from 'vitest'
import { createPremiumThemeClient, type PremiumFetch } from '../src/premium-theme.js'
import type { SecretStore } from '../src/secret-store.js'
import { DOCS_TOOL, SCHEMA_TOOL } from '../src/shopify-devmcp.js'

const WIRED = new Set([
  ...SHOP_TOOL_NAMES,
  ...THEME_TOOL_NAMES,
  ...SITE_HEALTH_TOOL_NAMES,
  ...COMPETITOR_STORE_TOOL_NAMES,
  // 记录源那四个只读工具（`records.ts`）
  'get_order',
  'get_product',
  'list_orders',
  'search_policies',
  DOCS_TOOL,
  SCHEMA_TOOL,
])

const MINE = [
  'site.shopify-build',
  'site.shopify-theme',
  'site.shopify-email',
  'site.shopify-apps',
  'dtc.store',
  'dtc.fulfillment',
]

describe('职责 yml 写的工具都有执行器（自查 A16）', () => {
  const roles = loadBundledRoles().filter((r) => MINE.includes(r.id))

  it('六条职责都在', () => {
    expect(roles.map((r) => r.id).sort()).toEqual([...MINE].sort())
  })

  it('grounding 里的每一个工具都接上了', () => {
    for (const role of roles)
      for (const g of role.grounding ?? [])
        expect(WIRED.has(g.tool), `${role.id} → ${g.tool}`).toBe(true)
  })

  it('grounding 点名的店铺工具，这条职责的工具表里也有（不然一样被过滤掉）', () => {
    for (const role of roles)
      for (const g of role.grounding ?? [])
        if (SHOP_TOOL_NAMES.includes(g.tool))
          expect(SHOP_TOOLS_BY_ROLE[role.id] ?? [], `${role.id} → ${g.tool}`).toContain(g.tool)
  })

  it('做不到的事在说明里标「还没接通」（决策 1230：不整条隐藏）', () => {
    const text = (id: string): string => {
      const r = roles.find((x) => x.id === id)
      return `${r?.description ?? ''}\n${r?.persona?.zh ?? ''}`
    }
    expect(text('dtc.store')).toContain('评价回复与邀评还没接通')
    expect(text('dtc.fulfillment')).toContain('取消订单')
    expect(text('dtc.fulfillment')).toContain('还没接通')
    expect(text('site.shopify-apps')).toContain('还没接通')
    expect(text('site.shopify-email')).toContain('还没接通')
    expect(text('site.shopify-build')).toContain('基础信息还没接通')
  })
})

describe('演示没有剧本那句话不露内部 id（自查 A20 / U15）', () => {
  it('只写职责名与中文岗位名', () => {
    const text = noPlaybookAnswer('site.shopify-build', 'Shopify 整站搭建')
    expect(text).toContain('这条职责（Shopify 整站搭建，建站）')
    expect(text).not.toContain('site.shopify-build')
    expect(noPlaybookAnswer('site.shopify-email')).not.toMatch(/site\.|，site）/)
  })
})

describe('高级主题暂时不能买的原因分开说（自查 A7）', () => {
  const secrets = { available: true, get: () => ({ token: 'wst_x' }) } as unknown as SecretStore
  const client = (fetch: PremiumFetch) =>
    createPremiumThemeClient({
      secrets,
      baseUrl: 'https://cloud.invalid',
      tokenSecretId: 'tok',
      fetch,
    })

  it('令牌缺「店铺」那一项 → missing_scope（不是「去登录」）；连不上 → offline（不是「即将开放」）', async () => {
    const forbidden = client(async () => ({
      ok: false,
      status: 403,
      text: async () => JSON.stringify({ code: 'forbidden', message: 'no store' }),
    }))
    await expect(forbidden.entitlement('a.myshopify.com')).rejects.toMatchObject({
      code: 'missing_scope',
    })
    const down = client(async () => {
      throw new Error('ECONNREFUSED')
    })
    await expect(down.entitlement('a.myshopify.com')).rejects.toMatchObject({ code: 'offline' })
  })
})

describe('演示剧本：「还差什么才能开门」照实念检查单（自查 A8）', () => {
  it('分「买不成 / 迟早出事 / 没读到」三段念，标题原样', () => {
    const text = renderSiteChecklistAnswer({
      headline: '上线检查单：1 项会让顾客买不成',
      items: [
        {
          item: '店面密码',
          state: '缺',
          severity: '顾客买不成',
          detail: '店面还挂着密码',
          fix: '去后台关',
        },
        { item: '政策页', state: '缺', severity: '迟早出事', detail: '缺 privacy' },
        { item: '税', state: '没读到', severity: '迟早出事', detail: '没读到税务设置' },
        { item: '域名', state: '过了', severity: '迟早出事', detail: 'x.com' },
      ],
    })
    expect(text.split('\n')[0]).toBe('上线检查单：1 项会让顾客买不成')
    expect(text).toContain('· 店面密码：店面还挂着密码（去后台关）')
    expect(text).toContain('这次没读到的（不是没有，是没读到）')
    expect(text).not.toContain('域名')
    expect(renderSiteChecklistAnswer(undefined, '这个进程没接工具')).toContain('没跑成')
  })
})
