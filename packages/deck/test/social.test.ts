/**
 * WP72（56 §2 / §4）：社媒面板的九块积木与五张卡。
 *
 * 三件事钉在这里：
 * 1. **一条职责只看得见自己那条渠道**（九条职责共用一份投影，面板这层筛）；
 * 2. **我们自己库里那几块与平台那一侧分得开**——TikTok 没连时"近 30 天表现"出
 *    「去连接」，内容日历照样有数（那是我们自己排的）；
 * 3. 五张卡上的芯片全从结构化字段来，一个字不编；群发那两格与 `campaign_send`
 *    是同一段代码。
 */
import type { ApprovalItem } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import {
  ALL_DATA_SOURCES,
  assembleView,
  blocksForRole,
  computeBlock,
  highlightsOf,
  type QueryContext,
  runQuery,
  SOCIAL_SOURCE_BY_CHANNEL,
  SOURCE_LABELS,
  type SocialDeckData,
} from '../src/index.js'

const NOW = '2026-09-16T09:00:00.000Z'

const SOCIAL: SocialDeckData = {
  calendar: [
    {
      post_id: 'p1',
      channel: 'meta',
      account: 'Nordvolt 主页',
      kind: 'image',
      status: 'scheduled',
      scheduled_at: '2026-09-18T12:00:00.000Z',
      excerpt: '周四直播',
    },
    {
      post_id: 'p9',
      channel: 'discord',
      account: 'Nordvolt 桌面党',
      kind: 'post',
      status: 'scheduled',
      excerpt: '群公告',
    },
    {
      post_id: 'p3',
      channel: 'meta',
      account: 'Nordvolt 主页',
      kind: 'image',
      status: 'failed',
      excerpt: '九宫格',
      failure_reason: '图片比例不符合要求',
    },
  ],
  queue: [
    {
      post_id: 'p1',
      channel: 'meta',
      account: 'Nordvolt 主页',
      status: 'scheduled',
      excerpt: '周四直播',
    },
  ],
  performance: [
    {
      post_id: 'p0',
      channel: 'meta',
      account: 'Nordvolt 主页',
      published_at: '2026-09-13T09:00:00.000Z',
      excerpt: '上新',
      impressions: 18_200,
      likes: 412,
      observed_at: NOW,
    },
  ],
  pending_comments: [
    {
      thread_id: 't1',
      channel: 'meta',
      account: 'Nordvolt 主页',
      surface: 'comment',
      author: 'mikez',
      excerpt: '能满速充吗',
      created_at: NOW,
    },
  ],
  pending_threads: [
    {
      thread_id: 't4',
      channel: 'discord',
      account: 'Nordvolt 桌面党',
      surface: 'thread',
      author: 'cheap_cables_24h',
      excerpt: '低价线材批发',
      created_at: NOW,
      triage: 'spam',
    },
  ],
  pending_members: [
    {
      member_id: 'm1',
      channel: 'discord',
      account: 'Nordvolt 桌面党',
      handle: 'deskhero',
      display_name: 'Desk Hero',
      answers: 2,
    },
  ],
  activity: [
    {
      account_id: 'a2',
      channel: 'discord',
      account: 'Nordvolt 桌面党',
      member_count: 860,
      active_7d: 1,
      pending_members: 2,
      open_threads: 1,
      observed_at: NOW,
    },
  ],
  broadcasts: [
    {
      post_id: 'p4',
      channel: 'discord',
      account: 'Nordvolt 桌面党',
      excerpt: '群公告',
      audience: 860,
    },
  ],
  handoffs: [
    {
      thread_id: 't3',
      channel: 'discord',
      account: 'Nordvolt 桌面党',
      surface: 'thread',
      author: 'linaw',
      excerpt: '单号 #10231 还没发货',
      created_at: NOW,
      triage: 'customer_question',
      status: 'routed_to_support',
    },
  ],
}

/** 一份上下文：`connected` 里写哪几个源算连上（其余一律「去连接」）。 */
function ctxFor(role_id: string, connected: readonly string[]): QueryContext {
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
    social: SOCIAL,
  }
}

describe('56 §2 面板：一条职责只看得见自己那条渠道', () => {
  it('Meta 那条职责的内容日历里没有 Discord 的行', () => {
    const out = runQuery('social.content_calendar', ctxFor('social.meta', ['social']), 'last_7d')
    expect(out.status).toBe('ok')
    const rows = out.status === 'ok' ? (out.data as { rows: Record<string, unknown>[] }).rows : []
    expect(rows.map((r) => r.body)).toEqual([
      '周四直播',
      // 平台退回来的原话跟着那一行走——混进"排期中"里就再也没人发现它没发出去
      '九宫格（图片比例不符合要求）',
    ])
  })

  it('不是社媒职责就一行不出——**不是**把九条渠道全端出来', () => {
    const out = runQuery('social.content_calendar', ctxFor('dtc.store', ['social']), 'last_7d')
    const rows = out.status === 'ok' ? (out.data as { rows: unknown[] }).rows : ['x']
    expect(rows).toEqual([])
  })

  it('入群申请的答案只报条数，原文不上面板', () => {
    const out = runQuery('social.pending_members', ctxFor('social.discord', ['social']), 'last_7d')
    const rows = out.status === 'ok' ? (out.data as { rows: Record<string, unknown>[] }).rows : []
    expect(rows[0]).toMatchObject({ handle: 'Desk Hero（deskhero）', answers: 2 })
  })
})

describe('56 §2 面板：我们自己的库与平台那一侧分得开（36 §3）', () => {
  it('一个平台都没连：内容日历有数，近 30 天表现出「去连接」', () => {
    const ctx = ctxFor('social.meta', ['social'])
    expect(computeBlock('social.meta.calendar', ctx, 'last_7d').status).toBe('ok')
    expect(computeBlock('social.meta.performance', ctx, 'last_7d').status).toBe('not_connected')
  })

  it('连上 Discord **不会**把 TikTok 那一块也点亮', () => {
    const discord = ctxFor('social.discord', ['social', 'social_discord'])
    expect(computeBlock('social.discord.activity', discord, 'last_7d').status).toBe('ok')
    const tiktok = ctxFor('social.tiktok', ['social', 'social_discord'])
    expect(computeBlock('social.tiktok.performance', tiktok, 'last_7d').status).toBe(
      'not_connected',
    )
  })

  it('Facebook 群组没有活跃度那一块——它没有连接器，不出一块永远空的表', () => {
    const ids = blocksForRole('social.facebook-group').map((b) => b.id)
    expect(ids).not.toContain('social.facebook_group.activity')
    expect(ids).toContain('social.facebook_group.pending_members')
    expect(ids).toContain('social.facebook_group.broadcasts')
    // 别的四条社群渠道都有
    expect(blocksForRole('social.discord').map((b) => b.id)).toContain('social.discord.activity')
    expect(SOCIAL_SOURCE_BY_CHANNEL.facebook_group).toBeUndefined()
    // Telegram 群组那条职责读的源叫 `social_telegram`（不是拼出来的 `social_telegram_group`）
    expect(SOCIAL_SOURCE_BY_CHANNEL.telegram_group).toBe('social_telegram')
  })

  it('面板按数据源分块：自己的库一块、渠道一块', () => {
    const sections = assembleView('social.meta', ctxFor('social.meta', ['social']))
    expect(sections.map((s) => s.source)).toEqual(['social', 'social_meta'])
    expect(sections[0]?.connected).toBe(true)
    expect(sections[1]?.connected).toBe(false)
    expect(sections[1]?.label).toBe('Meta（FB 主页 + IG）')
  })

  it('社媒运营的面板里一块店铺后台都没有（19 §3：无权的源连「去连接」都不出）', () => {
    for (const role of ['social.meta', 'social.discord'])
      expect(
        blocksForRole(role).every((b) => b.source.startsWith('social')),
        role,
      ).toBe(true)
  })

  it('客服的社群管理：第一块是转客服，后面是店铺后台（答订单离不开它）', () => {
    const blocks = blocksForRole('dtc.community-support')
    expect(blocks[0]?.id).toBe('community_support.handoffs')
    expect(blocks.some((b) => b.source === 'shop')).toBe(true)
    // 56 边界行：内容日历、群发队列、待审入群不是它的事
    expect(blocks.some((b) => b.id.includes('calendar'))).toBe(false)
    expect(blocks.some((b) => b.id.includes('broadcast'))).toBe(false)
    expect(blocks.some((b) => b.id.includes('pending_members'))).toBe(false)
  })
})

/* ── 五张卡（36 §2：卡是审批项的投影，不是五个新 kind）──────────────── */

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

describe('56 §2 五张卡：芯片全从结构化字段来', () => {
  it('发布卡：渠道 + **排期时刻**（批了之后它会在那个时刻自己出去）', () => {
    const out = typesOf(
      card({
        kind: 'social_post',
        after: {
          channel_label: 'Meta（FB 主页 + IG）',
          scheduled_at: '2026-09-18T12:00:00.000Z',
          body: '周四直播',
        },
      }),
    )
    expect(out).toContain('channel:Meta（FB 主页 + IG）')
    expect(out).toContain('scheduled:2026-09-18T12:00:00.000Z')
  })

  it('群发卡：受众数与抑制剔除数与 `campaign_send` 是同一段代码', () => {
    const out = typesOf(
      card({
        kind: 'community_broadcast',
        after: {
          channel: 'discord',
          audience_size: 860,
          suppression_checked: true,
          suppressed: ['u_1'],
          scheduled_at: '2026-09-17T12:00:00.000Z',
        },
      }),
    )
    expect(out).toContain('audience:860')
    expect(out).toContain('suppressed:1')
    expect(out).toContain('scheduled:2026-09-17T12:00:00.000Z')
  })

  it('群发卡：查过名单就报一个数，**哪怕是 0**（没查与查了没人是两回事）', () => {
    const out = typesOf(
      card({
        kind: 'community_broadcast',
        after: { channel: 'discord', audience_size: 860, suppression_checked: true },
      }),
    )
    expect(out).toContain('suppressed:0')
    // 没报"查过了"的那张卡根本进不了队列（guardrail 当场 block），所以这里没有这一格
    const never = typesOf(
      card({ kind: 'community_broadcast', after: { channel: 'discord', audience_size: 860 } }),
    )
    expect(never.some((h) => h.startsWith('suppressed:'))).toBe(false)
  })

  it('入群审核卡：一次一个人，所以芯片上是名字不是数', () => {
    const out = typesOf(
      card({
        kind: 'community_membership',
        after: { channel: 'discord', decision: 'approve', member_handle: 'deskhero' },
      }),
    )
    expect(out).toContain('member:deskhero')
  })

  it('管理动作卡：删帖 / 禁言 / 封禁写清是哪一种', () => {
    const out = typesOf(
      card({
        kind: 'community_moderation',
        after: { channel: 'discord', action: 'ban', action_label: '封禁' },
      }),
    )
    expect(out).toContain('stage:封禁')
  })

  it('转客服卡：芯片写的是**那条职责的名字**，不是分类器的结论代号', () => {
    const out = typesOf(
      card({
        kind: 'outbound_message',
        after: {
          triage: 'customer_question',
          route_to_label: '社群管理',
          route_to_role: 'dtc.community-support',
        },
      }),
    )
    expect(out).toContain('handoff:社群管理')
    expect(out.join('|')).not.toContain('customer_question')
  })

  it('不是社媒那几条 kind 的卡，一个社媒芯片都不多出来', () => {
    const out = typesOf(card({ kind: 'price_change', after: { channel: 'meta' } }))
    expect(out.some((h) => h.startsWith('channel:'))).toBe(false)
  })
})
