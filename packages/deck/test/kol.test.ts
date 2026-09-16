import type { ApprovalItem } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import {
  ALWAYS_CONNECTED,
  blocksForRole,
  dataSourcesFromConnections,
  PLANNED_SOURCE_NOTES,
  projectCard,
  runQuery,
} from '../src/index.js'
import type { KolDeckData, QueryContext } from '../src/types.js'
import { item, queryContext } from './fixtures.js'

const KOL_DATA: KolDeckData = {
  discovery: [
    {
      creator_id: 'cre_1',
      display_name: 'Gadget Jonas',
      channel: 'youtube',
      handle: 'gadgetjonas',
      followers: 48_000,
      score: 91,
    },
    {
      creator_id: 'cre_2',
      display_name: 'Fake Big',
      channel: 'youtube',
      handle: 'fakebig',
      followers: 900_000,
      score: 40,
      blocked: '粉丝数与互动率对不上，先人工看一眼是不是刷的。',
    },
  ],
  funnel: [
    { stage: 'sourced', label: '已找到', count: 4 },
    { stage: 'contacted', label: '已建联', count: 2 },
    { stage: 'replied', label: '已回复', count: 0 },
  ],
  collaborations: [
    {
      collaboration_id: 'col_1',
      display_name: 'Gadget Jonas',
      channel: 'youtube',
      stage: 'agreed',
      stage_label: '已签定',
      budget: 400,
      currency: 'USD',
    },
  ],
  pending_deliverables: [
    {
      deliverable_id: 'dlv_2',
      display_name: 'Desk Rosa',
      channel: 'instagram',
      kind: 'reel',
      due_at: '2026-10-20T00:00:00Z',
    },
    {
      deliverable_id: 'dlv_1',
      display_name: 'Gadget Jonas',
      channel: 'youtube',
      kind: 'video',
      due_at: '2026-10-01T00:00:00Z',
      url: 'https://youtu.be/abc',
    },
  ],
  attribution: [
    {
      tracked_link_id: 'tl_2',
      display_name: 'Desk Rosa',
      channel: 'instagram',
      clicks: 40,
      orders: 1,
      revenue: 59,
      currency: 'USD',
    },
    {
      tracked_link_id: 'tl_1',
      display_name: 'Gadget Jonas',
      channel: 'youtube',
      clicks: 320,
      orders: 5,
      revenue: 645.5,
      currency: 'USD',
    },
  ],
}

const withKol = (kol?: KolDeckData): QueryContext =>
  queryContext({
    role_id: 'kol.youtube',
    // 红人库永远算连上（`ALWAYS_CONNECTED`），所以这里用真算出来的那份连接状态
    sources: dataSourcesFromConnections([]),
    ...(kol === undefined ? {} : { kol }),
  })

const table = (
  name: string,
  ctx: QueryContext,
): { rows: Record<string, unknown>[]; columns: unknown[] } => {
  const r = runQuery(name, ctx, 'last_7d')
  if (r.status !== 'ok') throw new Error(`${name}: expected ok, got ${r.status}`)
  return r.data as { rows: Record<string, unknown>[]; columns: unknown[] }
}

describe('WP67 红人面板五个分块（48 §5.1）', () => {
  it('五条渠道职责的面板骨架相同，而且全走自己的红人库', () => {
    for (const role of ['kol.youtube', 'kol.facebook', 'kol.instagram', 'kol.tiktok', 'kol.x']) {
      const blocks = blocksForRole(role)
      expect(
        blocks.map((b) => b.query),
        role,
      ).toEqual([
        'kol.discovery',
        'kol.outreach_funnel',
        'kol.collaborations',
        'kol.pending_deliverables',
        'kol.attribution',
      ])
      expect(
        blocks.every((b) => b.source === 'kol'),
        role,
      ).toBe(true)
    }
  })

  it('红人库永远算连上；渠道那一侧连上哪条就亮哪条（WP68 起五张卡可连）', () => {
    expect([...ALWAYS_CONNECTED]).toContain('kol')
    const rows = dataSourcesFromConnections([])
    expect(rows.find((r) => r.id === 'kol')?.connected).toBe(true)
    const channel = rows.find((r) => r.id === 'kol_channel')
    expect(channel?.connected).toBe(false)
    // WP68：它不再是"还没做"，而是"你还没连"——所以没有 planned 那句话，
    // 界面照常给「去连接」按钮（"还没做"的那一档才不给，见 PLANNED_SOURCE_NOTES）
    expect(PLANNED_SOURCE_NOTES.kol_channel).toBeUndefined()
    expect(channel?.note).toBeUndefined()
    // 连上任意一条渠道，这一块就亮
    const connected = dataSourcesFromConnections([{ service: 'tiktok_research' }])
    expect(connected.find((r) => r.id === 'kol_channel')?.connected).toBe(true)
  })

  it('找人清单按分排序，刷粉那条的理由写在清单上（不悄悄拿掉）', () => {
    const rows = table('kol.discovery', withKol(KOL_DATA)).rows
    expect(rows).toHaveLength(2)
    expect(rows[0]?.name).toBe('Gadget Jonas')
    expect(String(rows[1]?.note)).toContain('刷')
  })

  it('建联漏斗空的格子也出（形状不随数据变）', () => {
    const rows = table('kol.outreach_funnel', withKol(KOL_DATA)).rows
    expect(rows.map((r) => r.stage)).toEqual(['已找到', '已建联', '已回复'])
    expect(rows[2]?.count).toBe(0)
  })

  it('待审交付物按期限正序：最急的在最上面', () => {
    const rows = table('kol.pending_deliverables', withKol(KOL_DATA)).rows
    expect(rows.map((r) => r.name)).toEqual(['Gadget Jonas', 'Desk Rosa'])
  })

  it('归因按收入倒序，数字原样端出去（不在渲染时现算）', () => {
    const rows = table('kol.attribution', withKol(KOL_DATA)).rows
    expect(rows[0]).toMatchObject({ name: 'Gadget Jonas', orders: 5, revenue: 645.5 })
  })

  it('没有红人库的机器上五块是空表——这与"还没连"不是一回事', () => {
    for (const q of [
      'kol.discovery',
      'kol.outreach_funnel',
      'kol.collaborations',
      'kol.pending_deliverables',
      'kol.attribution',
    ]) {
      const out = table(q, withKol())
      expect(out.rows, q).toEqual([])
      // 列还在：空表与"这一块不存在"在界面上是两回事
      expect(out.columns.length, q).toBeGreaterThan(0)
    }
  })
})

describe('WP67 五张卡（36 §2：卡是审批项的投影，不是五个新 kind）', () => {
  const now = '2026-09-15T09:00:00Z'
  const card = (payload: Record<string, unknown>, over: Partial<ApprovalItem> = {}) =>
    projectCard(item({ kind: 'staged_change', role_id: 'kol.youtube', payload, ...over }), {
      now,
      locale: 'zh',
    })
  const chip = (c: ReturnType<typeof card>, type: string) =>
    c.highlights.find((h) => h.type === type)

  it('开发信草稿卡：是谁 + 多少分 + 名单剔了几个（哪怕是 0）', () => {
    const c = card({
      kind: 'kol_outreach',
      target: { type: 'creator', id: 'cre_1' },
      after: {
        creator_name: 'Gadget Jonas',
        creator_score: 91,
        suppression_checked: true,
        suppressed: [],
        body: '你好，想聊聊合作。',
      },
    })
    expect(chip(c, 'creator')?.text).toBe('Gadget Jonas · 91')
    // "没人被剔"与"没查"在卡面上必须分得开
    expect(chip(c, 'suppressed')?.text).toBe('0')
  })

  it('没查过名单的开发信卡上没有那一格（不报一个假的 0）', () => {
    const c = card({
      kind: 'kol_outreach',
      target: { type: 'creator', id: 'cre_1' },
      after: { creator_name: 'Gadget Jonas' },
    })
    expect(chip(c, 'suppressed')).toBeUndefined()
  })

  it('合作审批卡：谁 + 走到哪一步 + 多少钱', () => {
    const c = card({
      kind: 'kol_collaboration',
      target: { type: 'collaboration', id: 'col_1' },
      after: {
        creator_name: 'Gadget Jonas',
        stage: 'agreed',
        stage_label: '已签定',
        budget: 400,
        amount: 400,
        currency: 'USD',
      },
    })
    expect(chip(c, 'creator')?.text).toBe('Gadget Jonas')
    expect(chip(c, 'stage')?.text).toBe('已签定')
    expect(chip(c, 'amount')?.text).toBe('400 USD')
  })

  it('交付物审核卡：谁交的 + 现在是什么结论', () => {
    const c = card({
      kind: 'kol_deliverable_review',
      target: { type: 'deliverable', id: 'dlv_1' },
      after: { creator_name: 'Gadget Jonas', review: 'approved', review_label: '已通过' },
    })
    expect(chip(c, 'stage')?.text).toBe('已通过')
  })

  it('归因卡：带回来多少单多少钱（归不上的不算进来）', () => {
    const c = card({
      kind: 'kol_tracked_link',
      target: { type: 'tracked_link', id: 'tl_1' },
      after: { orders: 5, revenue: 645.5, currency: 'USD' },
    })
    expect(chip(c, 'attribution')?.text).toBe('5 单 · 645.5 USD')
  })

  it('合并建议卡与陌生来信卡走同一条：别的 kind 的审批项，芯片上带红人是谁', () => {
    const merge = card({
      kind: 'knowledge_update',
      creator_name: 'Gadget Jonas',
      creator_score: 91,
    })
    expect(chip(merge, 'creator')?.text).toBe('Gadget Jonas · 91')
  })
})
