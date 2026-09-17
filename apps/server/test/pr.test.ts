/**
 * WP78（60 §1 / §5）：公关库、那两张连接卡、记录源那三类对象。
 *
 * 三组断言分别钉住三件事：
 *
 * 1. **库按去重键合并**——"今天有几条负面"这句话只有去过重之后才是真的；
 * 2. **投影里没有编出来的数**——"几个数 / 几个有出处"用的是 guardrail 那一份代码，
 *    面板说的与门拦下来时说的必须是同一个数；
 * 3. **目录里那两张卡**：Reddit **不新建**（社媒那张一把 key 管两条职责），
 *    新闻稿分发照实登记成"待增加"。
 */
import { connectionDirectoryEntry, PR_ROLE_IDS, prRoleSpec } from '@agentsws/contracts'
import { ALL_DATA_SOURCES, ALWAYS_CONNECTED, dataSourcesOfService } from '@agentsws/deck'
import { describe, expect, it } from 'vitest'
import { catalogEntry, plannedConnector, ROLE_CONNECTOR_KIND } from '../src/catalog.js'
import { createPrStore, prDeckData, seedDemoPr } from '../src/pr.js'

const NOW = '2026-09-17T09:00:00.000Z'
const store = () => {
  const s = createPrStore({ workspace_id: 'ws_test' })
  seedDemoPr(s, NOW)
  return s
}

describe('60 §5 公关库（四类对象）', () => {
  it('提及按 `dedupe_key` 合并：同一条被转几次只落一行，`seen_count` 加上去', () => {
    const s = store()
    const recall = s.mentions().find((m) => m.id === 'mn_recall')
    expect(recall?.seen_count).toBe(7)
    // 去重之后一条就是一条——"今天有 N 条负面"才说得出口
    expect(s.mentions().filter((m) => m.id === 'mn_recall')).toHaveLength(1)
  })

  it('再落一次同一条：判类结论与卡 id 一个字不动', () => {
    const s = store()
    const before = s.mention('mn_recall')
    s.saveMention({
      id: 'mn_recall_dup',
      workspace_id: 'ws_test',
      source: 'reddit',
      origin: 'r/gadgets',
      url: before?.url ?? '',
      text: '转载',
      published_at: '2026-09-01T00:00:00.000Z',
      observed_at: NOW,
      status: 'new',
      dedupe_key: before?.dedupe_key ?? '',
    })
    const after = s.mention('mn_recall')
    expect(after?.seen_count).toBe((before?.seen_count ?? 0) + 1)
    expect(after?.triage).toBe(before?.triage)
    // 原发那一条的时刻更早，取早的
    expect(after?.published_at).toBe('2026-09-01T00:00:00.000Z')
  })

  it('转给客服的那条不算公关的待处理：球在客服那边（60 分界行）', () => {
    const s = store()
    const open = s.mentions({ open: true })
    expect(open.some((m) => m.triage === 'customer_issue')).toBe(false)
    expect(s.mentions().some((m) => m.triage === 'customer_issue')).toBe(true)
    expect(s.mention('mn_order')?.status).toBe('routed_to_support')
  })

  it('回填反馈：帖子不在就什么也不做；被删了照实改状态', () => {
    const s = store()
    s.recordFeedback({ post_id: 'ep_nope', feedback: { score: 9, observed_at: NOW } })
    expect(s.post('ep_nope')).toBeUndefined()
    s.recordFeedback({ post_id: 'ep_quora', feedback: { removed: true, observed_at: NOW } })
    expect(s.post('ep_quora')?.status).toBe('removed')
  })

  it('媒体名单里一个明文邮箱都没有', () => {
    const s = store()
    const json = JSON.stringify(s.contacts())
    expect(json).not.toContain('@nordvolt')
    expect(json).toContain('***')
  })
})

describe('60 §3 面板投影', () => {
  it('稿子那两个数当场算，用的是 guardrail 那一份代码', () => {
    const deck = prDeckData(store())
    const full = deck.releases.find((r) => r.release_id === 'prl_launch')
    expect(full).toMatchObject({ figures: 3, facts_cited: 3 })
    // 第二篇故意少一个出处（"复购率 41%"）——两个数不等
    const short = deck.releases.find((r) => r.release_id === 'prl_milestone')
    expect(short?.figures).toBe(2)
    expect(short?.facts_cited).toBe(1)
  })

  it('负面预警按传播量排，而不是按时间', () => {
    const deck = prDeckData(store())
    expect(deck.negative_alerts[0]?.mention_id).toBe('mn_recall')
    expect(deck.negative_alerts[0]?.seen_count).toBe(7)
  })

  it('转客服那条只在「转客服」块里，不在提及流里', () => {
    const deck = prDeckData(store())
    expect(deck.mentions.some((m) => m.mention_id === 'mn_order')).toBe(false)
    expect(deck.handoffs.map((h) => h.mention_id)).toEqual(['mn_order'])
    expect(deck.handoffs[0]?.approval_id).toBe('ap_demo_handoff')
  })

  it('外部露出带着版规结论；拿不到的数一律没有那一格（不补 0）', () => {
    const deck = prDeckData(store())
    const blocked = deck.external_posts.find((p) => p.post_id === 'ep_bifl')
    expect(blocked).toMatchObject({ rules_ok: false, rules_reasons: 'no_self_promotion' })
    expect(blocked?.score).toBeUndefined()
    const live = deck.external_posts.find((p) => p.post_id === 'ep_quora')
    expect(live).toMatchObject({ rules_ok: true, score: 34, replies: 5 })
  })

  it('pitch 漏斗六档都出一行', () => {
    const deck = prDeckData(store())
    expect(deck.pitch_funnel).toHaveLength(6)
    expect(deck.pitch_funnel.find((r) => r.stage === 'covered')?.count).toBe(1)
  })

  it('空库不报错，也不编一行出来', () => {
    const deck = prDeckData(createPrStore({ workspace_id: 'ws_empty' }))
    expect(deck.mentions).toEqual([])
    expect(deck.releases).toEqual([])
    // 漏斗照样出六行（0 也是一句话）
    expect(deck.pitch_funnel).toHaveLength(6)
  })

  it('种两遍不会种出两份（demo 只种一次）', () => {
    const s = store()
    const n = s.mentions().length
    seedDemoPr(s, NOW)
    expect(s.mentions().length).toBe(n)
  })
})

describe('60 §5 连接目录与数据源', () => {
  it('Reddit **不新建一张卡**：社媒那张一把 key 管两条职责', () => {
    // `pr.reddit` 与 `social.reddit` 问的是同一个 kind
    expect(prRoleSpec('pr.reddit')?.connector_kind).toBe('reddit')
    expect(ROLE_CONNECTOR_KIND.reddit).toBe('reddit')
    expect(connectionDirectoryEntry('reddit')?.category).toBe('social')
  })

  it('Google Alerts 是一张能连的卡，字段只有 feed 地址（免费、不用申请）', () => {
    const entry = catalogEntry('google_alerts')
    expect(entry?.fields.map((f) => f.name)).toContain('feed_url')
    expect(entry?.planned).toBeUndefined()
    expect(connectionDirectoryEntry('google_alerts')?.status).toBe('available')
    // 只读一条 feed，不改外面任何东西
    expect(connectionDirectoryEntry('google_alerts')?.side_effect).toBe('read_external')
  })

  it('新闻稿分发照实登记成"待增加"：没有表单，也不假装发得出去', () => {
    expect(plannedConnector('press_distribution')?.kind).toBe('press_distribution')
    expect(connectionDirectoryEntry('press_distribution')?.status).toBe('planned')
    expect(connectionDirectoryEntry('press_distribution')?.fields).toEqual([])
  })

  it('论坛一张卡都没有（没有公开写接口，走浏览器）', () => {
    expect(prRoleSpec('pr.forums')?.connector_kind).toBeUndefined()
    expect(prRoleSpec('pr.forums')?.mode).toBe('browser')
  })

  it('公关库永远算连上；外面那一侧由那张卡点亮', () => {
    expect(ALWAYS_CONNECTED).toContain('pr')
    expect(ALL_DATA_SOURCES).toContain('google_alerts')
    expect(dataSourcesOfService('google_alerts')).toEqual(['google_alerts'])
  })

  it('四条职责的清单只有契约那一份', () => {
    expect(PR_ROLE_IDS).toEqual(['pr.press', 'pr.reddit', 'pr.forums', 'pr.monitoring'])
  })
})
