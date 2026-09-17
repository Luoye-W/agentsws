/**
 * WP77（59 §1 / §2 / §3）：建站数据面。
 *
 * 钉六件事：
 *
 * 1. **跑一次检查单也出卡**（`launch_check`，L3）——14 的老规矩：Agent 主动做的
 *    每一件事都进同一条队列，只是它不进人的待办。
 * 2. **读不到 ≠ 缺**：一条只读 Action 读不到，那一格记 `unknown`，不记 `missing`。
 * 3. **支付与税补不了**：那两项的 `fixable_by` 为空（51 §3 N2 在代码里的样子）。
 * 4. **缺变量的模板根本不提上去**：自查就拦，不让模型反复试。
 * 5. **启用那一下路由到 owner**，草稿路由到主管。
 * 6. **装 App 永远 L1**，而且库里那一份不当场变成"装上了"——那是执行器的事。
 */
import type { StagedChange, WorkspaceId } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import {
  createConnectSiteFacts,
  createSiteService,
  createSiteStore,
  seedDemoSite,
  siteDeckData,
} from '../src/site.js'

const WS = 'ws_1' as WorkspaceId
const NOW = '2026-09-17T04:00:00.000Z'

const actor = {
  workspace_id: WS,
  person_id: 'p_1' as never,
  assignment_id: 'asg_1' as never,
  role_id: 'site.shopify-build' as never,
}

/** 店里读回来的一份"什么都齐了"的事实。 */
const FULL_FACTS = {
  domain: { primary: 'https://glassbowl.com', custom: true },
  payment: { providers: ['shopify_payments'], test_mode: false },
  tax: { configured: true, regions: ['US'] },
  shipping: { zones: 2, rates: 3 },
  policies: { present: ['refund', 'privacy', 'terms_of_service', 'shipping'] },
  navigation: { main_menu_items: 5, footer_menu_items: 4 },
  apps: { installed: ['judge-me'] },
  theme: { published: { id: 't1', name: 'Dawn 定制版' } },
}

function harness(options: { facts?: Record<string, unknown> } = {}) {
  const staged: { kind: string; after: unknown; level: string; rule: string }[] = []
  const store = createSiteStore({ workspace_id: WS })
  const service = createSiteService({
    workspace_id: WS,
    store,
    clock: { now: () => NOW },
    approvals: {} as never,
    ledger: {
      stage: async (input) => {
        staged.push({
          kind: input.kind,
          after: input.after,
          level: input.level,
          rule: String((input.approval as { rule?: string }).rule),
        })
        return {
          ok: true,
          change: { id: `chg_${staged.length}`, kind: input.kind } as unknown as StagedChange,
          approval: {
            id: `ap_${staged.length}`,
            // 硬顶那几条（`app_install`）报什么都按回 L1
            automation: {
              level_at_creation: input.kind === 'app_install' ? 'L1' : input.level,
            },
          },
        } as never
      },
    },
    effectiveConfig: () => {
      throw new Error('这一份用例不查生效配置')
    },
    facts: {
      storeFacts: async () => (options.facts ?? FULL_FACTS) as never,
      shop: () => 'glassbowl.myshopify.com',
    },
    appendEvent: () => {},
    random: () => 0.5,
  })
  return { store, service, staged }
}

describe('WP77 上线检查单（59 §2）', () => {
  it('跑一次就落一条巡检记录，并且出一张 L3 的卡', async () => {
    const { service, store, staged } = harness()
    const out = await service.port.runChecklist(actor)
    expect(out.run.items).toHaveLength(8)
    expect(out.run.ready).toBe(true)
    expect(out.run.shop).toBe('glassbowl.myshopify.com')
    expect(out.staged.staged).toBe(true)
    expect(staged[0]?.kind).toBe('launch_check')
    // 只读巡检不进人的待办：路由到本人
    expect(staged[0]?.rule).toBe('role_holder')
    // 卡上带的是每一格，不是一个总分——空清单会被 guardrail 当场拦下
    expect((staged[0]?.after as { checked: number } | undefined)?.checked).toBe(8)
    // 落库了，而且带着那张卡的 id
    expect(store.lastRun()?.id).toBe(out.run.id)
    expect(store.lastRun()?.approval_item_id).toBe(out.staged.approval_item_id)
  })

  it('上一次巡检没跑过就是没有——**不现算一份**', async () => {
    const { service } = harness()
    expect(await service.port.lastChecklist(actor)).toEqual({})
    await service.port.runChecklist(actor)
    expect((await service.port.lastChecklist(actor)).run).toBeDefined()
  })

  it('一条都没读到 = 八项里七项 unknown，而不是"这家店什么都缺"', async () => {
    const { service } = harness({ facts: {} })
    const out = await service.port.runChecklist(actor)
    expect(out.run.items.filter((i) => i.state === 'unknown')).toHaveLength(7)
    expect(out.run.items.filter((i) => i.state === 'missing')).toHaveLength(0)
    expect(out.run.blockers).toBe(0)
  })

  it('支付与税那两项的 fixable_by 为空（51 §3 N2）；其余六项说得出谁来补', async () => {
    const { service } = harness()
    const out = await service.port.runChecklist(actor)
    const by = (id: string) => out.run.items.find((i) => i.id === id)?.fixable_by
    expect(by('payment')).toBeUndefined()
    expect(by('tax')).toBeUndefined()
    expect(by('theme_published')).toBe('site.shopify-theme')
    expect(by('required_apps')).toBe('site.shopify-apps')
  })
})

describe('WP77 邮件模板（59 §2）', () => {
  const good = {
    notification_type: 'order_confirmation',
    subject: '订单 {{ order.name }} 收到了',
    body: '你好 {{ customer.first_name }}，{{ order.name }} 收到了：{{ order.order_status_url }}',
    enabled: false,
  }

  it('没跑过也列得出全部通知类型（库里没有 = Shopify 出厂那一份）', async () => {
    const { service } = harness()
    const { rows } = await service.port.emailTemplates(actor)
    expect(rows.length).toBeGreaterThan(5)
    expect(rows.every((r) => !r.enabled)).toBe(true)
  })

  it('缺必需变量 = 根本不提上去（自查就拦，不让模型反复试）', async () => {
    const { service, staged } = harness()
    const out = await service.port.draftEmailTemplate(actor, {
      ...good,
      body: '你好 {{ customer.first_name }}，谢谢下单。',
    })
    expect(out.staged.staged).toBe(false)
    expect(out.problems[0]).toContain('order.name')
    expect(staged).toEqual([])
  })

  it('草稿路由到主管；启用路由到 owner，而且 after 一定带 enabled', async () => {
    const { service, staged } = harness()
    await service.port.draftEmailTemplate(actor, good)
    expect(staged[0]?.kind).toBe('email_template_edit')
    expect(staged[0]?.rule).toBe('scope_manager')
    expect((staged[0]?.after as { enabled: boolean } | undefined)?.enabled).toBe(false)

    await service.port.draftEmailTemplate(actor, { ...good, enabled: true })
    expect(staged[1]?.rule).toBe('owner')
    expect((staged[1]?.after as { enabled: boolean } | undefined)?.enabled).toBe(true)
  })

  it('库里那一份不当场变成"启用"——启用是执行器在卡批下来之后做的事', async () => {
    const { service, store } = harness()
    await service.port.draftEmailTemplate(actor, { ...good, enabled: true })
    const row = store.template('order_confirmation')
    expect(row?.enabled).toBe(false)
    expect(row?.pending_change_id).toBe('chg_1')
    expect(row?.body).toContain('order_status_url')
  })

  it('不认识的通知类型直接回错，不悄悄建一条', async () => {
    const { service } = harness()
    await expect(
      service.port.draftEmailTemplate(actor, { ...good, notification_type: '没这封' }),
    ).rejects.toThrow(/不认识/)
  })

  it('渲染预览是卡面材料：变量换成示例值，控制标签原样留着', async () => {
    const { service } = harness()
    const out = await service.port.draftEmailTemplate(actor, good)
    expect(out.preview).toContain('#1042')
    expect(out.preview).not.toContain('{{ order.name }}')
  })
})

describe('WP77 插件（59 §2）', () => {
  it('目录里有、店里没装的也列出来；装了却还没连的指得出来', async () => {
    const { service, store } = harness()
    store.saveApp({
      id: 'judge-me',
      schema_version: 1,
      workspace_id: WS,
      name: 'Judge.me 评价',
      installed: true,
      known: true,
      updated_at: NOW,
    })
    const { rows } = await service.port.apps(actor)
    expect(rows.find((r) => r.id === 'judge-me')).toMatchObject({
      installed: true,
      connectable: true,
    })
    expect(rows.find((r) => r.id === 'klaviyo')?.installed).toBe(false)
  })

  it('提一条装 App = 一张 L1 的卡，路由到 owner；库里不当场变成"装上了"', async () => {
    const { service, store, staged } = harness()
    const out = await service.port.proposeApp(actor, {
      app_id: 'judge-me',
      operation: 'install',
      reason: '要收商品评价',
    })
    expect(out.staged).toBe(true)
    expect(out.level).toBe('L1')
    expect(staged[0]?.kind).toBe('app_install')
    expect(staged[0]?.rule).toBe('owner')
    expect((staged[0]?.after as { operation: string } | undefined)?.operation).toBe('install')
    // 执行器还没跑，库里一条都没有
    expect(store.app('judge-me')).toBeUndefined()
  })
})

describe('WP77 面板投影（59 §3）', () => {
  it('检查单的 state 原样出；补不了的那两项 fixable 为假', async () => {
    const { service, store } = harness()
    await service.port.runChecklist(actor)
    const data = siteDeckData(store, { apps: [], templates: [] })
    expect(data.checklist).toHaveLength(8)
    expect(data.checklist.find((r) => r.id === 'payment')?.fixable).toBe(false)
    expect(data.checklist.find((r) => r.id === 'navigation')?.fixable).toBe(true)
    expect(data.checked_at).toBe(NOW)
  })

  it('没有预览链接的副本要看得出来；临时主题不摆上面板', () => {
    const store = createSiteStore({ workspace_id: WS })
    const data = siteDeckData(store, {
      apps: [],
      templates: [],
      themes: [
        { id: 't_live', name: '线上那份', role: 'main' },
        { id: 't_copy', name: '双十一版', role: 'unpublished', preview_url: 'https://x' },
        { id: 't_bare', name: '没看过的', role: 'unpublished' },
        { id: 't_dev', name: '临时', role: 'development' },
      ],
    })
    expect(data.themes.map((t) => t.theme_id)).toEqual(['t_live', 't_copy', 't_bare'])
    expect(data.themes.find((t) => t.theme_id === 't_bare')?.preview_url).toBeUndefined()
  })

  it('邮件模板那一块只报"缺几个"，正文一个字都不端上来（21 §1）', () => {
    const store = createSiteStore({ workspace_id: WS })
    const data = siteDeckData(store, {
      apps: [],
      templates: [
        {
          id: 'order_confirmation',
          schema_version: 1,
          workspace_id: WS,
          notification_type: 'order_confirmation',
          name: { zh: '订单确认', en: 'Order confirmation' },
          subject: '收到了',
          body: '一大段 Liquid',
          enabled: true,
          missing_variables: ['order.name'],
          updated_at: NOW,
        },
      ],
    })
    expect(data.email_templates[0]).toEqual({
      notification_type: 'order_confirmation',
      name: '订单确认',
      enabled: true,
      missing_variables: 1,
      has_draft: false,
    })
    expect(JSON.stringify(data)).not.toContain('一大段 Liquid')
  })
})

describe('WP77 事实经只读 Action 读回来（59 §2）', () => {
  it('没有店铺连接 = 一格都读不到（**不是**全缺）', async () => {
    const facts = createConnectSiteFacts({
      connect: {
        actions: async () => [],
        issueToken: async () => ({ token: 't' }),
        execute: async () => ({}),
      },
      connection: () => undefined,
    })
    expect(await facts.storeFacts()).toEqual({})
  })

  it('一条 Action 炸了只丢那一格，其余照读（令牌过期不该拖垮整次巡检）', async () => {
    const facts = createConnectSiteFacts({
      connect: {
        actions: async () => [
          { id: 'shopify_admin.get_shop' },
          { id: 'shopify_admin.get_payment_settings' },
        ],
        issueToken: async () => ({ token: 't' }),
        execute: async (id) => {
          if (id.endsWith('get_payment_settings')) throw new Error('token expired')
          return {
            shop: {
              primaryDomainUrl: 'https://glassbowl.com',
              myshopifyDomain: 'gb.myshopify.com',
            },
          }
        },
      },
      connection: () => ({ id: 'conn_1', service: 'shopify_admin' }),
    })
    const out = await facts.storeFacts()
    expect(out.domain?.custom).toBe(true)
    // 炸掉的那一格留空 = 检查单那边记 `unknown`
    expect(out.payment).toBeUndefined()
  })

  it('只签一张 role-read 令牌，而且只许那几条读动作', async () => {
    const issued: { kind: string; allowed_actions: string[] }[] = []
    const facts = createConnectSiteFacts({
      connect: {
        actions: async () => [
          { id: 'shopify_admin.get_shop' },
          { id: 'shopify_admin.list_themes' },
        ],
        issueToken: async (input) => {
          issued.push({ kind: input.kind, allowed_actions: input.allowed_actions })
          return { token: 't' }
        },
        execute: async () => ({}),
      },
      connection: () => ({ id: 'conn_1', service: 'shopify_admin' }),
    })
    await facts.storeFacts()
    expect(issued).toHaveLength(1)
    expect(issued[0]?.kind).toBe('role-read')
    expect(issued[0]?.allowed_actions).toEqual([
      'shopify_admin.get_shop',
      'shopify_admin.list_themes',
    ])
  })
})

/**
 * WP77（59 §3）：demo 的那几行。
 *
 * 钉的是**截图与人工验收里那一屏不是空的**，外加一条纪律：种子只在库空的时候放
 * （同 `seedDemoKol` / `seedDemoSocial`）——demo 重启一次就多一份巡检记录的话，
 * "上次什么时候查的"当场就说不清了。
 */
describe('demo 的那几行建站数据（59 §3）', () => {
  it('放完之后检查单有话可说：1 项买不成、2 项迟早出事，支付与税都过了', () => {
    const store = createSiteStore({ workspace_id: WS })
    seedDemoSite(store, NOW)
    const run = store.lastRun()
    expect(run).toBeDefined()
    // 运费（区域配了、一条费率都没有）= 唯一那个 blocker
    expect(run?.blockers).toBe(1)
    expect(run?.items.find((i) => i.id === 'shipping')?.state).toBe('missing')
    // 政策页缺两张 + 页脚菜单是空的……导航那一项只看主菜单，所以 warning 是政策页那一条
    expect(run?.warnings).toBe(1)
    expect(run?.missing_policies).toEqual(['terms_of_service', 'shipping'])
    expect(run?.ready).toBe(false)
    // 支付与税配好了：那两项建站岗位改不了（51 §3 N2），留成缺口只会让整张单
    // 都在重复同一句"去后台自己点"
    expect(run?.items.find((i) => i.id === 'payment')?.state).toBe('ok')
    expect(run?.items.find((i) => i.id === 'tax')?.state).toBe('ok')
    // 一格凭据都没有
    expect(JSON.stringify(run)).not.toContain('token')
  })

  it('已装 App 与邮件模板各有两行，其中一份模板是**还没启用**的草稿', () => {
    const store = createSiteStore({ workspace_id: WS })
    seedDemoSite(store, NOW)
    expect(
      store
        .apps()
        .map((a) => a.id)
        .sort(),
    ).toEqual(['judge-me', 'klaviyo'])
    expect(store.apps().every((a) => a.installed)).toBe(true)
    // 装上了 ≠ 我们连得上它的 API（59 §2 那条接缝）：这里只有 directory_kind，没有连接
    expect(store.apps().every((a) => a.connection_id === undefined)).toBe(true)
    const enabled = store.template('shipping_confirmation')
    const draft = store.template('order_confirmation')
    expect(enabled?.enabled).toBe(true)
    expect(draft?.enabled).toBe(false)
    // 两份都不缺必需变量（缺变量那条题在模拟里，不在 demo 里）
    expect(enabled?.missing_variables).toEqual([])
    expect(draft?.missing_variables).toEqual([])
  })

  it('只在库空的时候放：跑两次还是一条巡检记录', () => {
    const store = createSiteStore({ workspace_id: WS })
    seedDemoSite(store, NOW)
    seedDemoSite(store, '2026-09-18T04:00:00.000Z')
    expect(store.runs()).toHaveLength(1)
  })
})
