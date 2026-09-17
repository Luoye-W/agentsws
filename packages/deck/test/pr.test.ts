/**
 * WP78（60 §1 / §3）：公关面板的五块积木与五张卡上的芯片。
 *
 * 三件事钉在这里：
 *
 * 1. **我们自己库里那几块与外面那一侧分得开**（36 §3）——没连 Google Alerts
 *    时提及流出「去连接」，而负面预警与待发新闻稿照样有数：一条预警是
 *    我们自己开的卡，一篇稿子是我们自己写的。
 * 2. **数字有几个、几个有出处是两列**，不合成一个"合规"钩子——两个数不等的
 *    稿子根本提不上去，而合了之后人看不出差在哪儿。
 * 3. 芯片全从结构化字段来，一个字不编；**转客服卡两边的结论代号都认**
 *    （社媒叫 `customer_question`、公关叫 `customer_issue`，同一件事）。
 */
import type { ApprovalItem } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import {
  ALL_DATA_SOURCES,
  assembleView,
  blocksForRole,
  computeBlock,
  dataSourcesFromConnections,
  highlightsOf,
  type PrDeckData,
  type QueryContext,
  runQuery,
  SOURCE_LABELS,
} from '../src/index.js'

const NOW = '2026-09-17T09:00:00.000Z'

const PR: PrDeckData = {
  mentions: [
    {
      mention_id: 'mn1',
      source: 'reddit',
      origin: 'r/gadgets',
      url: 'https://www.reddit.com/r/gadgets/mn1',
      excerpt: '这个牌子的电源用两周就漏电，避雷',
      author: 'linaw',
      published_at: '2026-09-16T01:00:00.000Z',
      sentiment: 'negative',
      triage: 'reputation',
      status: 'triaged',
    },
    {
      mention_id: 'mn2',
      source: 'news',
      origin: 'geekpower.invalid',
      url: 'https://geekpower.invalid/a',
      excerpt: '实测比上一代多撑了一晚',
      published_at: '2026-09-15T01:00:00.000Z',
      sentiment: 'positive',
      triage: 'praise',
      status: 'triaged',
    },
  ],
  negative_alerts: [
    {
      mention_id: 'mn1',
      source: 'reddit',
      origin: 'r/gadgets',
      url: 'https://www.reddit.com/r/gadgets/mn1',
      excerpt: '这个牌子的电源用两周就漏电，避雷',
      author: 'linaw',
      published_at: '2026-09-16T01:00:00.000Z',
      sentiment: 'negative',
      triage: 'reputation',
      status: 'triaged',
      seen_count: 7,
    },
  ],
  releases: [
    {
      release_id: 'prl1',
      status: 'draft',
      headline: 'Nordvolt 发布第二代户外电源',
      figures: 3,
      facts_cited: 3,
      updated_at: '2026-09-16T09:00:00.000Z',
    },
    {
      release_id: 'prl2',
      status: 'draft',
      headline: 'Nordvolt 用户数破十万',
      // 少一个出处：两个数不等（面板上看得出来，提上去会被 guardrail 拦）
      figures: 2,
      facts_cited: 1,
      updated_at: '2026-09-14T09:00:00.000Z',
    },
  ],
  pitch_funnel: [
    { stage: 'new', label: '还没发过', count: 1 },
    { stage: 'pitched', label: '发过了，等回音', count: 1 },
    { stage: 'replied', label: '回了，在谈', count: 0 },
    { stage: 'covered', label: '写了我们', count: 1 },
    { stage: 'declined', label: '明说不写', count: 0 },
    { stage: 'suppressed', label: '别再找他', count: 0 },
  ],
  external_posts: [
    {
      post_id: 'ep1',
      platform: 'reddit',
      venue: 'BuyItForLife',
      status: 'blocked',
      excerpt: '三年后拆开我们自己的一代产品',
      rules_ok: false,
      rules_reasons: 'no_self_promotion',
    },
    {
      post_id: 'ep2',
      platform: 'quora',
      venue: 'outdoor-power',
      status: 'published',
      excerpt: '选户外电源先看电芯类型',
      rules_ok: true,
      published_at: '2026-09-11T09:00:00.000Z',
      score: 34,
      replies: 5,
      removed: false,
    },
  ],
  handoffs: [
    {
      mention_id: 'mn3',
      source: 'forum',
      origin: 'quora.com',
      url: 'https://quora.com/mn3',
      excerpt: '我的订单还没发货',
      author: 'mikec',
      published_at: '2026-09-16T01:00:00.000Z',
      sentiment: 'neutral',
      triage: 'customer_issue',
      status: 'routed_to_support',
      approval_id: 'ap_1',
    },
  ],
}

function ctxFor(role_id: string, connected: string[]): QueryContext {
  return {
    now: NOW,
    tz_offset_minutes: 480,
    base_currency: 'USD',
    role_id,
    position_id: 'asg_1',
    orders: [],
    approvals: [],
    sources: ALL_DATA_SOURCES.map((id) => ({
      id,
      label: SOURCE_LABELS[id],
      connected: connected.includes(id),
    })),
    pr: PR,
  }
}

const rowsOf = (name: string, ctx: QueryContext): Record<string, unknown>[] => {
  const out = runQuery(name, ctx, 'last_7d')
  return out.status === 'ok' ? (out.data as { rows: Record<string, unknown>[] }).rows : []
}

describe('60 §3 面板：我们自己的库与外面那一侧分得开（36 §3）', () => {
  it('没连 Google Alerts：提及流出「去连接」，负面预警与待发新闻稿照样有数', () => {
    const ctx = ctxFor('pr.monitoring', ['pr'])
    expect(computeBlock('pr.monitoring.mentions', ctx, 'last_7d').status).toBe('not_connected')
    expect(computeBlock('pr.monitoring.alerts', ctx, 'last_7d').status).toBe('ok')
    expect(computeBlock('pr.press.releases', ctxFor('pr.press', ['pr']), 'last_7d').status).toBe(
      'ok',
    )
  })

  it('连上了提及流才有数', () => {
    const ctx = ctxFor('pr.monitoring', ['pr', 'google_alerts'])
    expect(computeBlock('pr.monitoring.mentions', ctx, 'last_7d').status).toBe('ok')
    expect(rowsOf('pr.mentions', ctx)).toHaveLength(2)
  })

  it('公关库永远算连上（`ALWAYS_CONNECTED`），外面那一侧要真连', () => {
    // 一条连接都没有时 `pr` 仍然是连上的——它就在这台机器上（见 `sources.ts`）
    const rows = dataSourcesFromConnections([])
    expect(rows.find((s) => s.id === 'pr')?.connected).toBe(true)
    expect(rows.find((s) => s.id === 'google_alerts')?.connected).toBe(false)
    // 连上那张卡之后外面那一侧才亮
    const live = dataSourcesFromConnections([{ service: 'google_alerts', status: 'active' }])
    expect(live.find((s) => s.id === 'google_alerts')?.connected).toBe(true)
    const view = assembleView('pr.press', ctxFor('pr.press', ['pr']))
    expect(view.find((s) => s.source === 'pr')?.connected).toBe(true)
    expect(view.find((s) => s.source === 'google_alerts')?.connected).toBe(false)
  })

  it('四条职责各挑自己那几块；Reddit 与论坛的面板一模一样', () => {
    expect(blocksForRole('pr.press').map((b) => b.id)).toEqual([
      'pr.press.releases',
      'pr.press.funnel',
      'pr.press.mentions',
    ])
    expect(blocksForRole('pr.reddit').map((b) => b.id)).toEqual(
      blocksForRole('pr.forums').map((b) => b.id),
    )
    expect(blocksForRole('pr.monitoring').map((b) => b.id)).toContain('pr.monitoring.handoffs')
  })

  it('一块店铺后台的积木都不放（公关的 scopes 里没有 order / customer）', () => {
    for (const role of ['pr.press', 'pr.reddit', 'pr.forums', 'pr.monitoring']) {
      expect(
        blocksForRole(role).every((b) => b.source === 'pr' || b.source === 'google_alerts'),
        role,
      ).toBe(true)
    }
  })
})

describe('60 §2 面板：数字有几个、几个有出处是两列', () => {
  it('齐的稿子两个数相等；少一个出处的一眼看得出来', () => {
    const rows = rowsOf('pr.release_queue', ctxFor('pr.press', ['pr']))
    expect(rows[0]).toMatchObject({ figures: 3, cited: 3 })
    expect(rows[1]).toMatchObject({ figures: 2, cited: 1 })
  })

  it('pitch 漏斗六档都出一行，没有人的那一档也是 0', () => {
    const rows = rowsOf('pr.pitch_funnel', ctxFor('pr.press', ['pr']))
    expect(rows).toHaveLength(6)
    expect(rows.find((r) => r.label === '回了，在谈')).toMatchObject({ count: 0 })
  })
})

describe('60 §1 面板：版规结论原样显示', () => {
  it('被版规拦下的那一条带着理由；过了的那一条写"过了"', () => {
    const rows = rowsOf('pr.external_posts', ctxFor('pr.reddit', ['pr']))
    expect(rows[0]).toMatchObject({ venue: 'reddit／BuyItForLife', rules: 'no_self_promotion' })
    expect(rows[1]).toMatchObject({ venue: 'quora／outdoor-power', rules: '过了', score: 34 })
  })

  it('状态念成人话，不是把枚举值印上去', () => {
    const rows = rowsOf('pr.external_posts', ctxFor('pr.reddit', ['pr']))
    expect(rows[0]?.status).toBe('版规不让')
    const handoffs = rowsOf('pr.support_handoffs', ctxFor('pr.monitoring', ['pr']))
    expect(handoffs[0]?.status).toBe('转给客服了')
  })

  it('转客服那一条只在「转客服」块里，不在提及流里（60 分界行）', () => {
    const ctx = ctxFor('pr.monitoring', ['pr', 'google_alerts'])
    expect(rowsOf('pr.mentions', ctx).map((r) => r.body)).not.toContain('我的订单还没发货')
    expect(rowsOf('pr.support_handoffs', ctx)).toHaveLength(1)
  })

  it('没判过情绪的行空着，**不写"中性"**', () => {
    const ctx = ctxFor('pr.monitoring', ['pr', 'google_alerts'])
    const plain: PrDeckData = {
      ...PR,
      mentions: [{ ...(PR.mentions[0] as (typeof PR.mentions)[number]), sentiment: undefined }],
    }
    const out = runQuery('pr.mentions', { ...ctx, pr: plain }, 'last_7d')
    const rows = out.status === 'ok' ? (out.data as { rows: Record<string, unknown>[] }).rows : []
    expect(rows[0]?.sentiment).toBe('')
  })
})

describe('60 §3 卡：三个新芯片全从结构化字段来', () => {
  const item = (payload: Record<string, unknown>): ApprovalItem =>
    ({
      id: 'ap_1',
      title: 't',
      summary: 's',
      payload,
      subject: { object: { type: 'mention', id: 'mn_1' } },
      automation: { mandate_check: { caps_hit: [] } },
    }) as unknown as ApprovalItem

  it('外部发帖卡：版名 + 版规结论', () => {
    const chips = highlightsOf(
      item({
        kind: 'community_post',
        after: { venue_label: 'reddit／BuyItForLife', rules_summary: '版规明写着禁自我推广' },
      }),
      { now: NOW, position_id: 'asg_1' },
    )
    expect(chips).toContainEqual({ type: 'channel', text: 'reddit／BuyItForLife' })
    expect(chips).toContainEqual({ type: 'venue_rules', text: '版规明写着禁自我推广' })
  })

  it('新闻稿卡：几个数、几个有出处（提得上来的稿子这两个数永远相等）', () => {
    const chips = highlightsOf(
      item({ kind: 'press_release', after: { figure_count: 3, cited_count: 3 } }),
      { now: NOW, position_id: 'asg_1' },
    )
    expect(chips).toContainEqual({ type: 'facts_cited', text: '3 个数字，3 个有出处' })
  })

  it('负面预警卡：情绪 + 被转了几次', () => {
    const chips = highlightsOf(
      item({
        kind: 'mention_triage',
        after: { sentiment_label: '负面', seen_count: 7, origin: 'r/gadgets' },
      }),
      { now: NOW, position_id: 'asg_1' },
    )
    expect(chips).toContainEqual({ type: 'sentiment', text: '负面 · 被转了 7 次' })
    expect(chips).toContainEqual({ type: 'channel', text: 'r/gadgets' })
  })

  it('转客服卡：公关那一侧的 `customer_issue` 也认（与社媒那一侧同一件事）', () => {
    const chips = highlightsOf(
      item({
        kind: 'mention_triage',
        after: { triage: 'customer_issue', route_to_label: '客服', sentiment: 'neutral' },
      }),
      { now: NOW, position_id: 'asg_1' },
    )
    expect(chips).toContainEqual({ type: 'handoff', text: '客服' })
  })

  it('不是公关那三条 kind 就一个芯片都不加', () => {
    const chips = highlightsOf(item({ kind: 'refund', after: { venue: 'x' } }), {
      now: NOW,
      position_id: 'asg_1',
    })
    expect(chips.some((c) => c.type === 'venue_rules')).toBe(false)
  })
})
