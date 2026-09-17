/**
 * WP77（59 §3）：建站面板那五块 + 三条待审车道。
 *
 * 要钉住的五句话：
 *
 * 1. **建站库永远算连上**：一个平台都没连，检查单那一块照样出数——那几行是
 *    我们自己跑出来的结论（36 §3 的"去连接"说的是别的事）。
 * 2. **缺项与"没读到"是两种颜色**：`unknown` 那一行写的是"没读到"，不是"缺"。
 * 3. **补不了的那两项照实说**：支付与税的 `fixable` 为假。
 * 4. **三条待审车道各收各的**：主题发布 / 邮件启用 / 装 App 混成一张表，人就得
 *    一行行点开看它是哪一类。
 * 5. **四条职责各看自己那几块**，而且**一块店铺后台的积木都没有**——建站那四条
 *    的 scopes 里订单与商品是只读的（19 §3）。
 */
import { describe, expect, it } from 'vitest'
import {
  ALWAYS_CONNECTED,
  blocksForRole,
  PENDING_LANES,
  queryNames,
  runQuery,
} from '../src/index.js'
import type { SiteDeckData, TableResult } from '../src/types.js'
import { queryContext, SOURCES, storeChangeItem } from './fixtures.js'

const rowsOf = (data: unknown): Record<string, string | number>[] =>
  (data as TableResult).rows ?? []

const SITE: SiteDeckData = {
  checklist: [
    {
      id: 'payment',
      title: '收款方式',
      state: 'missing',
      severity: 'blocker',
      detail: '一个收款方式都没启用',
      fix: '请店主自己去 Shopify 后台点一下。',
      fixable: false,
    },
    {
      id: 'tax',
      title: '税',
      state: 'unknown',
      severity: 'warning',
      detail: '没读到税务设置',
      fix: '请店主自己去 Shopify 后台点一下。',
      fixable: false,
    },
    {
      id: 'navigation',
      title: '导航',
      state: 'ok',
      severity: 'warning',
      detail: '主菜单 5 项 / 页脚 4 项',
      fix: '',
      fixable: true,
    },
  ],
  checked_at: '2026-09-17T04:00:00.000Z',
  themes: [
    { theme_id: 't_live', name: 'Dawn 定制版', role: 'live' },
    { theme_id: 't_copy', name: '双十一版', role: 'copy', preview_url: 'https://shop/?preview' },
    { theme_id: 't_bare', name: '没看过的副本', role: 'copy' },
  ],
  apps: [
    { app_id: 'judge-me', name: 'Judge.me 评价', installed: true, known: true, connectable: true },
    { app_id: 'klaviyo', name: 'Klaviyo', installed: false, known: true, connectable: false },
    { app_id: 'mystery', name: '某弹窗', installed: true, known: false, connectable: false },
  ],
  email_templates: [
    {
      notification_type: 'order_confirmation',
      name: '订单确认',
      enabled: true,
      missing_variables: 0,
      has_draft: true,
    },
    {
      notification_type: 'shipping_confirmation',
      name: '发货通知',
      enabled: false,
      missing_variables: 2,
      has_draft: false,
    },
  ],
}

/** 建站库永远算连上，所以这一份源表里没有 `site` 那一行也照样有数（`withOwnSources`）。 */
const ctx = queryContext({
  role_id: 'site.shopify-build',
  site: SITE,
  sources: [...SOURCES, { id: 'site', label: '建站', connected: true }],
})

describe('59 §3 建站面板五块', () => {
  it('建站库在"永远算连上"那张表里——它就在这台机器上', () => {
    expect(ALWAYS_CONNECTED).toContain('site')
  })

  it('五块的命名查询都在注册表里', () => {
    const names = queryNames()
    for (const q of [
      'site.launch_checklist',
      'site.theme_copies',
      'site.installed_apps',
      'site.email_templates',
    ])
      expect(names, q).toContain(q)
  })

  it('检查单：过了 / 缺（分两档） / 没读到 —— 三种说法各不相同', () => {
    const out = runQuery('site.launch_checklist', ctx, 'yesterday')
    expect(out.status).toBe('ok')
    const rows = rowsOf(out.status === 'ok' ? out.data : undefined)
    expect(rows.map((r) => r.state)).toEqual(['缺（买不成）', '没读到', '过了'])
    // 补不了的那两项照实写"去后台"，不给一个点不动的"去补"
    expect(String(rows[0]?.fix)).toContain('后台')
  })

  it('主题：没有预览链接的副本要看得出来（12 §2「预览链接就是审批材料」）', () => {
    const out = runQuery('site.theme_copies', ctx, 'yesterday')
    const rows = rowsOf(out.status === 'ok' ? out.data : undefined)
    expect(rows.map((r) => r.role)).toEqual(['线上', '副本', '副本'])
    expect(rows[1]?.preview).toBe('https://shop/?preview')
    expect(rows[2]?.preview).toBe('')
  })

  it('已装 App：目录里没有的那条照样列出来，并且带一句提醒', () => {
    const out = runQuery('site.installed_apps', ctx, 'yesterday')
    const rows = rowsOf(out.status === 'ok' ? out.data : undefined)
    expect(rows).toHaveLength(3)
    expect(String(rows[0]?.note)).toContain('还没连上它的 API')
    expect(String(rows[2]?.note)).toContain('不在我们的目录里')
    expect(rows[1]?.note).toBe('')
  })

  it('邮件模板：只报"缺几个"，不报"缺哪几个"（那在卡里面）', () => {
    const out = runQuery('site.email_templates', ctx, 'yesterday')
    const rows = rowsOf(out.status === 'ok' ? out.data : undefined)
    expect(rows[0]).toMatchObject({ enabled: '在用', missing: 0, draft: '有一份等你点' })
    expect(rows[1]).toMatchObject({ enabled: '出厂那一份', missing: 2, draft: '' })
  })

  it('一个数据都没有也不崩：那几块是空表，不是"还没连"', () => {
    const bare = queryContext({
      role_id: 'site.shopify-build',
      sources: [...SOURCES, { id: 'site', label: '建站', connected: true }],
    })
    const out = runQuery('site.launch_checklist', bare, 'yesterday')
    expect(out.status).toBe('ok')
    expect(rowsOf(out.status === 'ok' ? out.data : undefined)).toEqual([])
  })
})

describe('59 §3 待审三条车道', () => {
  const lanes = ['theme_publish', 'email_enable', 'app_install']
  const queueCtx = queryContext({
    role_id: 'site.shopify-theme',
    approvals: [
      storeChangeItem('publish_theme'),
      storeChangeItem('theme_install'),
      storeChangeItem('email_template_edit'),
      storeChangeItem('app_install'),
      storeChangeItem('app_config'),
      // 别的岗位的卡不该混进来
      storeChangeItem('price_change'),
    ],
  })

  it('三条都在车道表与查询注册表里', () => {
    for (const lane of lanes) {
      expect(
        PENDING_LANES.map((l) => l.lane),
        lane,
      ).toContain(lane)
      expect(queryNames(), lane).toContain(`changes.pending_${lane}`)
    }
  })

  it('各收各的：主题那条不会把装 App 的卡收进来', () => {
    const titlesOf = (lane: string): string[] => {
      const out = runQuery(`changes.pending_${lane}`, queueCtx, 'yesterday')
      return rowsOf(out.status === 'ok' ? out.data : undefined).map((r) => String(r.kind))
    }
    expect(titlesOf('theme_publish').sort()).toEqual(['publish_theme', 'theme_install'])
    expect(titlesOf('email_enable')).toEqual(['email_template_edit'])
    expect(titlesOf('app_install').sort()).toEqual(['app_config', 'app_install'])
  })
})

describe('59 §3 四条职责各看自己那几块', () => {
  const idsOf = (role: string): string[] => blocksForRole(role as never).map((b) => b.id)

  it('整站搭建看检查单；网页模板看副本与待发布；邮件看模板与待启用；插件看已装与待装', () => {
    expect(idsOf('site.shopify-build')).toEqual(['site.checklist', 'site.themes', 'site.apps'])
    expect(idsOf('site.shopify-theme')).toEqual(['site.theme.copies', 'site.theme.pending'])
    expect(idsOf('site.shopify-email')).toEqual(['site.email.templates', 'site.email.pending'])
    expect(idsOf('site.shopify-apps')).toEqual(['site.apps.installed', 'site.apps.pending'])
  })

  it('一块店铺后台的积木都没有——建站那四条的 scopes 里订单与商品是只读的（19 §3）', () => {
    for (const role of [
      'site.shopify-build',
      'site.shopify-theme',
      'site.shopify-email',
      'site.shopify-apps',
    ]) {
      const sources = blocksForRole(role as never).map((b) => b.source)
      expect(
        sources.every((s) => s === 'site' || s === 'approvals'),
        role,
      ).toBe(true)
    }
  })

  it('旧 id `site.builder` 走兜底（它已经改名了，面板按新 id 认）', () => {
    // 改名之后旧 id 在积木表里没有一行——职责加载器会先把它解析成新 id，
    // 所以面板拿到的永远是 `site.shopify-theme`（`ROLE_ID_ALIASES`）。
    expect(idsOf('site.builder')).not.toEqual(idsOf('site.shopify-theme'))
  })
})
