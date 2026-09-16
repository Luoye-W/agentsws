/**
 * WP72（56 §1 / §2）：社媒库、连接目录那八张卡、记录源那两类对象。
 *
 * 三组断言分别钉住三件事：
 * 1. 库按渠道切得开（九条渠道是九个真账号，串了就是发错号）；
 * 2. 投影里**没有**编出来的数（拿不到的一律没有那一格，不补 0）；
 * 3. 目录里那八张卡与契约那张渠道表一个字不差，且准备说明里先说代价。
 */
import { SOCIAL_CHANNELS } from '@agentsws/contracts'
import { ALL_DATA_SOURCES, ALWAYS_CONNECTED, dataSourcesOfService } from '@agentsws/deck'
import { describe, expect, it } from 'vitest'
import { CATALOG, catalogEntry, ROLE_CONNECTOR_KIND } from '../src/catalog.js'
import { createSocialStore, seedDemoSocial, socialDeckData } from '../src/social.js'

const NOW = '2026-09-16T09:00:00.000Z'
const store = () => {
  const s = createSocialStore({ workspace_id: 'ws_test' })
  seedDemoSocial(s, NOW)
  return s
}

describe('56 §2 社媒库（四类对象）', () => {
  it('按渠道切得开：Meta 那条职责看不见 Discord 的帖子', () => {
    const s = store()
    expect(s.accounts({ channel: 'meta' }).map((a) => a.id)).toEqual(['sa_demo_meta'])
    expect(s.posts({ channel: 'meta' }).every((p) => p.channel === 'meta')).toBe(true)
    expect(s.posts({ channel: 'discord' }).length).toBeGreaterThan(0)
    // 九条渠道之间零共享：两边加起来才是全部
    expect(s.posts({ channel: 'meta' }).length + s.posts({ channel: 'discord' }).length).toBe(
      s.posts().length,
    )
  })

  it('待审入群只回 pending；转给客服的线程不算"还开着"', () => {
    const s = store()
    expect(s.members({ pending: true }).every((m) => m.status === 'pending')).toBe(true)
    const open = s.threads({ open: true })
    // 56 边界行：判成客户问题、已经转出去的那条，球在客服那边
    expect(open.some((t) => t.triage === 'customer_question')).toBe(false)
    expect(s.threads().some((t) => t.triage === 'customer_question')).toBe(true)
  })

  it('回填表现：帖子不在就什么也不做（不凭空建一条只有数字的帖子）', () => {
    const s = store()
    s.recordMetrics({ post_id: 'sp_nope', metrics: { likes: 9 }, observed_at: NOW })
    expect(s.post('sp_nope')).toBeUndefined()
    s.recordMetrics({ post_id: 'sp_demo_2', metrics: { impressions: 10 }, observed_at: NOW })
    expect(s.post('sp_demo_2')?.metrics?.impressions).toBe(10)
    expect(s.post('sp_demo_2')?.metrics_observed_at).toBe(NOW)
  })

  it('分类写回线程：带了卡 id 才算转客服（`routed_to_support`）', () => {
    const s = store()
    s.recordTriage({ thread_id: 'ct_demo_1', triage: 'customer_question' })
    // 只判了类、还没出卡：线程还开着，社媒运营那边还看得见它
    expect(s.thread('ct_demo_1')?.status).toBe('open')
    s.recordTriage({
      thread_id: 'ct_demo_1',
      triage: 'customer_question',
      routed_approval_id: 'ap_1',
    })
    expect(s.thread('ct_demo_1')?.status).toBe('routed_to_support')
    expect(s.thread('ct_demo_1')?.routed_approval_id).toBe('ap_1')
  })
})

describe('56 §2 面板投影：数字不编、边界不混', () => {
  const deck = () => socialDeckData(store(), { now: NOW })

  it('拿不到的数就没有那一格——不补 0', () => {
    const row = deck().performance.find((r) => r.post_id === 'sp_demo_1')
    expect(row?.impressions).toBe(18_200)
    // Meta 不给单条帖子的"播放"：这一格不该出现，更不该是 0
    expect(row).not.toHaveProperty('views')
    expect(row?.observed_at).toBe(NOW)
  })

  it('近 30 天表现只算已发的；排期中的与被退回的不混进来', () => {
    const d = deck()
    expect(d.performance.map((r) => r.post_id)).toEqual(['sp_demo_1'])
    // 被平台退回来的那条要在日历上看得见，而且带着平台原话
    const failed = d.calendar.find((r) => r.post_id === 'sp_demo_3')
    expect(failed?.status).toBe('failed')
    expect(failed?.failure_reason).toContain('比例')
  })

  it('转客服的线程只出现在「转客服」那一块（56 边界行）', () => {
    const d = deck()
    expect(d.handoffs.map((r) => r.thread_id)).toEqual(['ct_demo_3'])
    expect(d.pending_threads.map((r) => r.thread_id)).not.toContain('ct_demo_3')
    expect(d.pending_comments.map((r) => r.thread_id)).not.toContain('ct_demo_3')
  })

  it('入群申请的答案只报条数，原文不上面板（外部文本，21 §1）', () => {
    const row = deck().pending_members.find((r) => r.member_id === 'cm_demo_1')
    expect(row?.answers).toBe(2)
    expect(JSON.stringify(deck().pending_members)).not.toContain('cheap cables')
  })

  it('活跃度三个数各是各的，不合成一个"健康分"', () => {
    const row = deck().activity.find((r) => r.channel === 'discord')
    expect(row?.member_count).toBe(860)
    expect(row?.pending_members).toBe(2)
    expect(row?.active_7d).toBe(1)
    expect(row?.observed_at).toBe(NOW)
    expect(row).not.toHaveProperty('score')
  })

  it('每一行都带 `channel`：九条职责共用一份投影，面板那层自己筛', () => {
    const d = deck()
    const rows = [...d.calendar, ...d.queue, ...d.performance, ...d.pending_threads, ...d.handoffs]
    for (const r of rows) expect(typeof r.channel, JSON.stringify(r)).toBe('string')
  })
})

describe('56 §1 连接目录：八张卡', () => {
  it('八条渠道各有一张卡；Facebook 群组一张都没有（Groups API 已停）', () => {
    for (const spec of SOCIAL_CHANNELS) {
      if (spec.connector_kind === undefined) {
        expect(spec.id).toBe('facebook_group')
        expect(CATALOG.some((e) => e.service.includes('facebook_group'))).toBe(false)
        continue
      }
      // 职责 yml 问的 kind → 连接目录里的 service（`ROLE_CONNECTOR_KIND` 反过来那一步）
      const service = Object.entries(ROLE_CONNECTOR_KIND).find(
        ([, kind]) => kind === spec.connector_kind,
      )?.[0]
      expect(service, spec.id).toBeDefined()
      expect(catalogEntry(service as string), spec.id).toBeDefined()
    }
  })

  it('YouTube 与 X 是**红人那两张卡**，不新建（一把 key 管两条职责）', () => {
    expect(CATALOG.filter((e) => e.service === 'youtube_data')).toHaveLength(1)
    expect(CATALOG.filter((e) => e.service === 'x_api')).toHaveLength(1)
    // 同一张卡喂两个数据源：红人那一侧与社媒那一侧
    expect(catalogEntry('youtube_data')?.data_sources).toEqual(['kol_channel', 'social_youtube'])
    expect(dataSourcesOfService('youtube_data')).toEqual(['kol_channel', 'social_youtube'])
  })

  it('准备说明里先说代价（56 §1 末行），不让人填完再撞墙', () => {
    expect(catalogEntry('meta_graph')?.setup_guide.summary).toContain('App Review')
    expect(catalogEntry('tiktok_content')?.setup_guide.summary).toContain('申请制')
    expect(catalogEntry('reddit')?.setup_guide.summary).toContain('User-Agent')
    const wa = catalogEntry('whatsapp_business')?.setup_guide.summary ?? ''
    expect(wa).toContain('模板')
    expect(wa).toContain('opt-in')
    expect(wa).toContain('24 小时')
  })

  it('凭据只进本机加密库；还没接的三张明着标出来、点不动', () => {
    for (const service of [
      'meta_graph',
      'tiktok_content',
      'reddit',
      'discord_bot',
      'telegram_bot',
      'whatsapp_business',
    ]) {
      const entry = catalogEntry(service)
      expect(entry?.store, service).toBe('local_vault')
      expect(entry?.upstream, service).toBe('local')
    }
    // ② 里有真适配器的三张是可连的，另外三张照实说"还没接"
    for (const s of ['meta_graph', 'discord_bot', 'telegram_bot'])
      expect(catalogEntry(s)?.planned, s).toBeUndefined()
    for (const s of ['tiktok_content', 'reddit', 'whatsapp_business'])
      expect(catalogEntry(s)?.planned, s).toBeDefined()
  })

  it('数据源：社媒库永远算连上；渠道那八个各连各的', () => {
    expect(ALWAYS_CONNECTED).toContain('social')
    for (const id of [
      'social_meta',
      'social_tiktok',
      'social_x',
      'social_youtube',
      'social_reddit',
      'social_discord',
      'social_telegram',
      'social_whatsapp',
    ])
      expect(ALL_DATA_SOURCES, id).toContain(id)
    // 连上 Discord **不会**把 TikTok 那一块也点亮（36 §3 最忌讳的那种空图）
    expect(dataSourcesOfService('discord_bot')).toEqual(['social_discord'])
    expect(dataSourcesOfService('tiktok_content')).toEqual(['social_tiktok'])
  })
})
