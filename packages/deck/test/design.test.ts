/**
 * WP76（58 §3）：设计面板的五块积木与四张卡。
 *
 * 三件事钉在这里：
 * 1. **一条职责只看得见自己那条**（五条职责共用一份投影，面板这层筛）；
 * 2. 设计岗位**一个渠道源都没有**——出图走模型网关的图片槽，那不是一条连接，
 *    所以五块全走 `design` 这一个永远算连上的源；
 * 3. 四张卡上的芯片全从结构化字段来，一个字不编；`picked_by` 那一格是
 *    04 §6「视觉决定永远是人」在界面上唯一看得见的地方。
 */
import type { ApprovalItem } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import {
  ALL_DATA_SOURCES,
  assembleView,
  blocksForRole,
  computeBlock,
  type DesignDeckData,
  highlightsOf,
  type QueryContext,
  runQuery,
  SOURCE_LABELS,
} from '../src/index.js'

const NOW = '2026-09-17T09:00:00.000Z'

const DESIGN: DesignDeckData = {
  request_queue: [
    {
      request_id: 'r1',
      duty: 'dtc',
      from: 'dtc.store',
      title: '产品页主视觉',
      excerpt: '下周上新，想要一张横版主图',
      due_at: '2026-09-21T00:00:00.000Z',
      overdue: false,
      created_at: '2026-09-16T09:00:00.000Z',
    },
    {
      request_id: 'r2',
      duty: 'amazon',
      from: 'amz.listing',
      title: '主图重做',
      excerpt: '旧图是三年前拍的',
      due_at: '2026-09-10T00:00:00.000Z',
      overdue: true,
      created_at: '2026-09-09T09:00:00.000Z',
    },
  ],
  in_progress: [
    {
      request_id: 'r3',
      duty: 'dtc',
      from: 'dtc.content',
      title: '活动 Banner',
      status: 'generating',
      brief_id: 'b3',
      planned: 6,
      generated: 2,
    },
    {
      request_id: 'r4',
      duty: 'social',
      from: 'social.meta',
      title: 'IG 配图',
      status: 'briefed',
      planned: 4,
      generated: 0,
    },
  ],
  awaiting_pick: [
    {
      asset_id: 'a1',
      duty: 'dtc',
      spec: '首页主视觉（桌面）',
      stage: 'waiting_pick',
      brief_id: 'b3',
      goal: '看懂它能塞进背包',
      created_at: '2026-09-17T08:00:00.000Z',
    },
    {
      asset_id: 'a2',
      duty: 'dtc',
      spec: '活动 Banner',
      stage: 'waiting_publish',
      created_at: '2026-09-17T08:30:00.000Z',
    },
    {
      asset_id: 'a3',
      duty: 'amazon',
      spec: 'Amazon 主图',
      stage: 'waiting_pick',
      created_at: '2026-09-17T08:40:00.000Z',
    },
  ],
  library: [
    { use: 'hero', count: 4, final: 4 },
    { use: '没打标', count: 2, final: 1 },
  ],
  weekly: {
    since: '2026-09-10T09:00:00.000Z',
    final: 3,
    variants: 21,
    by_use: [{ use: 'hero', count: 3 }],
  },
}

/**
 * 设计岗位的 ctx。`design` 那一格永远是 true——它是我们自己的库
 * （`ALWAYS_CONNECTED`），宿主那一侧永远这么报。
 */
const ctxFor = (role_id: string, connected: string[] = []): QueryContext =>
  ({
    now: NOW,
    tz_offset_minutes: 480,
    base_currency: 'CNY',
    role_id,
    position_id: 'asg_1',
    orders: [],
    approvals: [],
    sources: ALL_DATA_SOURCES.map((id) => ({
      id,
      label: SOURCE_LABELS[id],
      connected: id === 'design' || connected.includes(id),
    })),
    design: DESIGN,
  }) as unknown as QueryContext

describe('58 §3 五块积木', () => {
  it('五条职责各自五块，块 id 带自己那条职责', () => {
    for (const duty of ['dtc', 'amazon', 'social', 'ads', 'exhibition']) {
      const ids = blocksForRole(`design.${duty}`).map((b) => b.id)
      expect(ids).toEqual([
        `design.${duty}.requests`,
        `design.${duty}.in_progress`,
        `design.${duty}.awaiting_pick`,
        `design.${duty}.library`,
        `design.${duty}.weekly`,
      ])
    }
  })

  it('**一个渠道源都没有**：五块全走 `design`（它永远算连上）', () => {
    const sources = new Set(blocksForRole('design.amazon').map((b) => b.source))
    expect([...sources]).toEqual(['design'])
    // 一条连接都没有，五块照样出得了数——出图走模型网关的图片槽，那不是一条连接
    const ctx = ctxFor('design.amazon', [])
    for (const b of blocksForRole('design.amazon'))
      expect(computeBlock(b.id, ctx, 'last_7d').status, b.id).toBe('ok')
  })

  it('面板上只有一个分块（设计库），不出任何「去连接」', () => {
    const view = assembleView('design.dtc', ctxFor('design.dtc', []))
    expect(view).toHaveLength(1)
    expect(view[0]?.source).toBe('design')
    expect(view[0]?.connected).toBe(true)
    expect(view[0]?.blocks).toHaveLength(5)
  })

  it('一条职责只看得见自己那条：独立站看不到 Amazon 那张单', () => {
    const ctx = ctxFor('design.dtc', [])
    const queue = runQuery('design.request_queue', ctx, 'last_7d')
    expect(queue.status).toBe('ok')
    const rows = queue.status === 'ok' ? (queue.data as { rows: { from: string }[] }).rows : []
    expect(rows.map((r) => r.from)).toEqual(['dtc.store'])
  })

  it('认不出职责（不是设计职责）就**一行不出**，不是把五条全端出来', () => {
    const ctx = ctxFor('social.meta', [])
    const queue = runQuery('design.request_queue', ctx, 'last_7d')
    const rows = queue.status === 'ok' ? (queue.data as { rows: unknown[] }).rows : []
    expect(rows).toEqual([])
  })

  it('过期那一行把话说出来（不靠颜色表达）', () => {
    const ctx = ctxFor('design.amazon', [])
    const queue = runQuery('design.request_queue', ctx, 'last_7d')
    const rows = queue.status === 'ok' ? (queue.data as { rows: { due_at: string }[] }).rows : []
    expect(rows[0]?.due_at).toBe('2026-09-10（已经过了）')
  })

  it('进行中：「出了几张 / 计划几张」两个数都在，不合成一个百分比', () => {
    const ctx = ctxFor('design.dtc', [])
    const q = runQuery('design.in_progress', ctx, 'last_7d')
    const rows =
      q.status === 'ok' ? (q.data as { rows: { progress: string; status: string }[] }).rows : []
    expect(rows[0]?.progress).toBe('2 / 6')
    // 状态翻成人话：`generating` 对用户是一个谜
    expect(rows[0]?.status).toBe('正在出图')
  })

  it('**待挑与待定稿分得开**：球在谁那儿写成两句不同的话', () => {
    const ctx = ctxFor('design.dtc', [])
    const q = runQuery('design.awaiting_pick', ctx, 'last_7d')
    const rows = q.status === 'ok' ? (q.data as { rows: { stage: string }[] }).rows : []
    expect(rows.map((r) => r.stage)).toEqual(['等你挑一张', '你挑好了，等你点入库'])
  })

  it('**本周产出 = 定稿**；出图张数只是分母，两行都在', () => {
    const ctx = ctxFor('design.dtc', [])
    const q = runQuery('design.weekly_output', ctx, 'last_7d')
    const rows =
      q.status === 'ok' ? (q.data as { rows: { metric: string; value: number }[] }).rows : []
    expect(rows[0]).toEqual({ metric: '定稿（真能用的）', value: 3 })
    expect(rows[1]).toEqual({ metric: '出了多少张变体', value: 21 })
  })

  it('素材库把「没打标」那一格也列出来，不藏起来', () => {
    const ctx = ctxFor('design.dtc', [])
    const q = runQuery('design.asset_library', ctx, 'last_7d')
    const rows = q.status === 'ok' ? (q.data as { rows: { use: string }[] }).rows : []
    expect(rows.map((r) => r.use)).toEqual(['hero', '没打标'])
  })
})

const card = (payload: Record<string, unknown>): ApprovalItem =>
  ({
    id: 'ap_1',
    workspace_id: 'ws_1',
    kind: 'staged_change',
    state: 'pending',
    title: '一张卡',
    summary: '',
    created_at: NOW,
    revision: 1,
    subject: {},
    payload,
    evidence: { precheck: {}, provenance: { seen: [], outputs: [] } },
    automation: {
      level_at_creation: 'L1',
      auto_approved: false,
      mandate_check: { caps_hit: [] },
    },
    recipients: [],
  }) as unknown as ApprovalItem

const typesOf = (item: ApprovalItem): string[] =>
  highlightsOf(item, { now: NOW }).map((h) => `${h.type}:${h.text}`)

describe('58 §3 四张卡：芯片全从结构化字段来', () => {
  it('brief 卡：规格那一格（五条职责的卡唯一分得开的东西）', () => {
    expect(typesOf(card({ kind: 'design_brief', after: { spec_label: 'Amazon 主图' } }))).toContain(
      'spec:Amazon 主图',
    )
  })

  it('变体卡：出几张 + 规格', () => {
    const out = typesOf(
      card({ kind: 'design_variant', after: { spec_label: '首页主视觉（桌面）', n: 4 } }),
    )
    expect(out).toContain('variants:4')
    expect(out).toContain('spec:首页主视觉（桌面）')
  })

  it('变体卡：没有图片模型时那句**人话**进卡面（不是"生成失败"）', () => {
    const out = typesOf(
      card({
        kind: 'design_variant',
        after: { n: 0, no_image_model_reason: '默认的 DeepSeek 不出图。' },
      }),
    )
    expect(out).toContain('no_image_model:默认的 DeepSeek 不出图。')
  })

  it('入库卡：**谁挑的**那一格在（没有它 guardrail 会当场 block）', () => {
    expect(
      typesOf(
        card({ kind: 'asset_publish', after: { picked_by_label: '罗晔', spec_id: '易拉宝' } }),
      ),
    ).toEqual(['spec:易拉宝', 'picked_by:罗晔'])
  })

  it('别的 kind 一个设计芯片都不长出来', () => {
    expect(typesOf(card({ kind: 'social_post', after: { spec_label: '不该出现' } }))).not.toContain(
      'spec:不该出现',
    )
  })

  /*
   * WP122（71 §5）：规范自检那一行。挑图卡与入库卡都要看得见它——
   * 定稿是另一次请求，那一跳手上只有这张素材，所以这句话得跟着素材走。
   */
  it('变体卡：不合规范的那一行进卡面（**只提示，不拦人**）', () => {
    const out = typesOf(
      card({ kind: 'design_variant', after: { n: 3, design_note: '#ff7a00 不在品牌色板里' } }),
    )
    expect(out).toContain('design_note:#ff7a00 不在品牌色板里')
  })

  it('入库卡：同一行还在（当初提过什么，定稿的人要看得见）', () => {
    expect(
      typesOf(
        card({
          kind: 'asset_publish',
          after: { picked_by_label: '罗晔', design_note: '#ff7a00 不在品牌色板里' },
        }),
      ),
    ).toContain('design_note:#ff7a00 不在品牌色板里')
  })

  it('全都合规范：这一格不出现（卡面上不画一行空白）', () => {
    expect(typesOf(card({ kind: 'design_variant', after: { n: 3 } }))).not.toContain('design_note:')
    expect(
      typesOf(card({ kind: 'design_variant', after: { n: 3 } })).some((s) =>
        s.startsWith('design_note'),
      ),
    ).toBe(false)
  })

  it('别的设计卡（brief / 需求单）不长这一行——它说的是**产出物**合不合规范', () => {
    expect(
      typesOf(card({ kind: 'design_brief', after: { design_note: '#ff7a00 不在品牌色板里' } })),
    ).not.toContain('design_note:#ff7a00 不在品牌色板里')
  })
})
