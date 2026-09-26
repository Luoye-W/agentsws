/**
 * WP157：**界面减字守卫第二轮**——岗位页与职责面板（连接页、消息渠道、聊天窗在
 * `less-text-pages.test.tsx`）。量法与上限同 `less-text-guard.ts`。
 *
 * 量这几处（WP157 之前都超过或贴着上限）：
 *
 * 1. 岗位页「还没分配范围」那张卡（店主看时带「给我自己挂上」那颗按钮）、在线客服的两扇门；
 * 2. 岗位页「连上这 N 个就能开工」（还没做的那几条带着连接目录里 94 字的那句话）；
 * 3. 职责页顶上那一句（建站那几条模板的 description 80 字上下、带 **粗体**）；
 * 4. 报表块与告警块的小节头；
 * 5. 社媒群发（WhatsApp 那两道闸摆在明处，但压成一句）。
 */
import { screen, waitFor } from '@testing-library/react'
import { Route, Routes } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { PositionConnections } from '@/components/connections/position-connections'
import { AlertBlocks, ReportBlocks } from '@/components/deck/panel-blocks'
import { SocialBroadcast } from '@/components/social/social-broadcast'
import type { PositionConnectionItem, PositionSummary, RoleDetailView } from '@/lib/api'
import { DutyPage } from '@/pages/duty'
import { PositionPage } from '@/pages/position'
import { draftCard } from './fixtures'
import { renderWithProviders } from './helpers'
import { CARD_TEXT_LIMIT, type CardReport, reportCard } from './less-text-guard'

// ── 夹具 ────────────────────────────────────────────────────────────

const summary = (over: Partial<PositionSummary>): PositionSummary => ({
  position_id: 'asg_1',
  role_id: 'dtc.live-chat',
  role_name: '网站在线客服',
  ranges: [],
  ready: true,
  missing_connectors: [],
  tile_ids: [],
  range: 'yesterday',
  show_tiles: false,
  ...over,
})

/** 连接目录里最长的那几句（`packages/contracts/src/connection-directory.ts`）。 */
const PRESS_NOTE =
  '把稿子一次发给一批媒体的那类服务（美通社 / 商业资讯这一派）。它们要合同、要企业账号、按条收费——现在给一张表单是骗人。在接上之前，分发那一跳出的是一张卡 + 一份可以直接复制的稿件正文，你自己发出去；**不假装已经发出去了**。'
const X_ADS_NOTE =
  '申请制：要先有广告账户、提交 Ads API 申请、说明用途、等人工审核。社媒那条买的 X API **付费档管不到这一侧**——两套授权。没接上之前排计划、攒提案、看额度照常。'

const item = (kind: string, over: Partial<PositionConnectionItem>): PositionConnectionItem =>
  ({
    kind,
    name: { zh: kind, en: kind },
    required: false,
    connected: false,
    needed_by: ['新闻稿', '媒体关系', '论坛与社区', '舆情监控'],
    status: 'available',
    ...over,
  }) as PositionConnectionItem

/** 建站模板那种长 description（`packages/roles/roles/site/shopify-build.yml`）。 */
const LONG_DESCRIPTION =
  '从零搭一家 Shopify 店：**先出一版可以点的草稿站**，你看过、改过、点头了才上线。主题、导航、首页分区、政策页一次配齐；商品与集合按公司档案里的品类先建骨架，价格与库存留给店铺管理那条职责。上线前跑一遍检查单，缺什么照实说。'

const ROLE: RoleDetailView = {
  id: 'site.shopify-build',
  name: '搭一家 Shopify 店',
  name_en: 'Build a Shopify store',
  description: LONG_DESCRIPTION,
  domain: 'site',
  version: '1.0.0',
  source: 'bundled',
  editable: false,
  holders: 1,
  home_blocks: [],
  actions: [],
  automation: [],
  connectors: [{ kind: 'shopify_admin', required: true }],
  scopes: [
    { domain: 'site', ops: ['read', 'stage'], range: 'assigned', max_sensitivity: 'internal' },
  ],
  skills: [{ name: 'shopify-build', tier: 'package', load: 'always' }],
}

vi.mock('@/components/kol/kol-panel', async () => {
  const actual = await vi.importActual<typeof import('@/components/kol/kol-panel')>(
    '@/components/kol/kol-panel',
  )
  return { ...actual, KolPanel: () => <div data-testid="kol-panel" /> }
})

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    // 岗位页：店主本人看自己的在线客服岗位，范围是空的
    getPositions: async () => ({
      positions: [
        summary({}),
        summary({ position_id: 'asg_owner', role_id: 'common.owner', role_name: '店主' }),
      ],
      tile_library: [],
      max_tiles: 6,
    }),
    getPositionView: async () => ({
      position_id: 'asg_1',
      range: 'yesterday',
      sections: [{ source: 'shop', label: '店铺后台', connected: true, blocks: [] }],
    }),
    getPositionRecords: async () => ({ payload: { rows: [] } }),
    getPositionCards: async () => ({ position: summary({}), cards: [], counts: {} }),
    currentSession: async () => ({
      person: { id: 'p_owner', email: 'owner@example.com', name: '店主' },
      workspace: { id: 'ws_1', name: 'default' },
      assignments: [],
    }),
    getPositionConnections: async () => ({
      position_id: 'pr',
      position_name: '公共关系',
      ready: false,
      missing_required: ['email'],
      items: [
        item('email', { required: true, connect_service: 'imap_smtp' }),
        item('press_distribution', { status: 'planned', note: { zh: PRESS_NOTE, en: PRESS_NOTE } }),
        item('x_ads', { status: 'planned', note: { zh: X_ADS_NOTE, en: X_ADS_NOTE } }),
      ],
    }),
    // 职责页
    getPosition: async () => ({
      position_id: 'site',
      workspace_id: 'ws_1',
      name: { zh: '建站', en: 'Site' },
      template_version: '1.0.0',
      holders: ['p_owner'],
      roles: [
        {
          role_id: 'site.shopify-build',
          role_name: '搭一家 Shopify 店',
          default: true,
          assignment_ids: ['asg_site'],
          my_assignment_id: 'asg_site',
        },
      ],
      open_matters: 0,
      pending_cards: 0,
      memory_summary: '',
    }),
    getRoleDefinition: async () => ROLE,
    // 社媒群发：WhatsApp 有一个号
    getSocialAccounts: async () => ({
      rows: [{ id: 'acc_1', channel: 'whatsapp', handle: '+1 555 0100' }],
    }),
  }
})

// ── 量 ──────────────────────────────────────────────────────────────

const found: { name: string; report: CardReport }[] = []

function check(name: string, card: Element): void {
  const report = reportCard(card)
  found.push({ name, report })
  expect(
    report.weight,
    `「${name}」可见说明 ${report.weight} 字 > ${CARD_TEXT_LIMIT}：${report.text}`,
  ).toBeLessThanOrEqual(CARD_TEXT_LIMIT)
  expect(report.ordered, `「${name}」里还有步骤清单 <ol>`).toBe(0)
  expect(
    report.externalLinks.length,
    `「${name}」外链 ${report.externalLinks.join(' ')}`,
  ).toBeLessThanOrEqual(1)
  expect(report.longSafety, `「${name}」安全承诺没压到一句`).toEqual([])
}

describe('岗位页', () => {
  it('还没分配范围（店主看）与在线客服的两扇门：不超', async () => {
    renderWithProviders(
      <Routes>
        <Route path="/positions/:id" element={<PositionPage />} />
      </Routes>,
      '/positions/asg_1?tab=view',
    )
    const card = await screen.findByTestId('no-range-card')
    await screen.findByTestId('no-range-self-assign')
    check('岗位 · 还没分配范围', card)
    check('岗位 · 聊天窗入口', await screen.findByTestId('chat-window-entry'))
    check('岗位 · 试聊入口', await screen.findByTestId('chat-sandbox-entry'))
  })

  it('「连上这 N 个就能开工」：还没做的那几条的长句进了问号', async () => {
    renderWithProviders(<PositionConnections id="pr" />)
    const card = await screen.findByTestId('position-connections')
    check('岗位 · 连上这 N 个', card)
    for (const row of screen.getAllByTestId('position-connection-item'))
      check(`岗位 · 连接一行 · ${row.getAttribute('data-kind') ?? ''}`, row)
    // 问号里的字不露 markdown 星号，一个字也不少
    const notes = screen.getAllByTestId('position-connection-note')
    expect(notes[0]?.getAttribute('data-hint')).toContain('不假装已经发出去了')
    expect(notes[0]?.getAttribute('data-hint')).not.toContain('**')
  })
})

describe('职责页', () => {
  it('顶上只留 description 的第一句（认粗体、不露星号），整段在问号里', async () => {
    renderWithProviders(
      <Routes>
        <Route path="/positions/:assignment/duties/:role_id" element={<DutyPage />} />
      </Routes>,
      '/positions/asg_site/duties/site.shopify-build',
      'asg_site',
    )
    const line = await screen.findByTestId('duty-line')
    const overview = screen.getByTestId('duty-overview')
    check('职责页 · 概览顶上', line)
    expect(line.textContent).toBe('从零搭一家 Shopify 店')
    expect(overview.textContent).not.toContain('**')
    expect(screen.getByTestId('duty-description').getAttribute('data-hint')).toContain(
      '上线前跑一遍检查单',
    )
  })
})

describe('职责面板的小块', () => {
  it('报表块、告警块的小节头：说明进问号', () => {
    const report = draftCard({ id: 'r1', kind: 'daily_report', layout: 'aftermath', title: '昨天' })
    const alert = draftCard({ id: 'a1', kind: 'system_alert', layout: 'aftermath', title: '像素' })
    renderWithProviders(
      <>
        <ReportBlocks reports={[report]} onOpen={() => {}} />
        <AlertBlocks alerts={[alert]} onOpen={() => {}} />
      </>,
    )
    const reports = screen.getByTestId('panel-reports')
    const alerts = screen.getByTestId('alerts')
    check('报表块 · 小节头', reports.firstElementChild as Element)
    check('告警块 · 小节头', alerts.firstElementChild as Element)
    expect(screen.getByTestId('panel-reports-hint').getAttribute('data-hint')).not.toBe('')
  })

  it('社媒群发（WhatsApp）：两道闸是一行风险提示，「永远要人点一下」是一行安全承诺', async () => {
    const { container } = renderWithProviders(
      <SocialBroadcast assignment="asg_social" channel="whatsapp" />,
    )
    await waitFor(() => {
      expect(container.querySelector('[data-slot="warning"]')).not.toBeNull()
    })
    check('社媒群发 · WhatsApp', screen.getByTestId('social-broadcast'))
  })
})

describe('量出来的数（给下一轮看的）', () => {
  it('打一张表到控制台（不断言）', () => {
    for (const { name, report } of found)
      console.info(`[less-text] ${String(report.weight).padStart(3)} 字  ${name}`)
    expect(true).toBe(true)
  })
})
