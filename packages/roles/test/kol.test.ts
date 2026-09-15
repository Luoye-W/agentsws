import { KOL_CHANNEL_IDS } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import { loadBundledPosition, loadBundledRole } from '../src/index.js'

const ROLES = KOL_CHANNEL_IDS.map((c) => loadBundledRole(`kol.${c}`))

describe('48 §5.1 五条渠道职责（WP67）', () => {
  it('五条都在，domain 都是 kol', () => {
    expect(ROLES.map((r) => r.id)).toEqual([
      'kol.youtube',
      'kol.facebook',
      'kol.instagram',
      'kol.tiktok',
      'kol.x',
    ])
    expect(ROLES.every((r) => r.domain === 'kol')).toBe(true)
  })

  it('骨架完全相同：六个对象域 + 知识读 + 订单读（归因要）', () => {
    for (const role of ROLES) {
      const domains = role.scopes.map((s) => s.domain)
      for (const d of [
        'creator',
        'platform_account',
        'creator_contact',
        'collaboration',
        'deliverable',
        'tracked_link',
      ])
        expect(domains, role.id).toContain(d)
      // 19 §3：scopes 里缺一个域，那一块会被静默拿掉。归因读订单、起草读知识。
      expect(domains, role.id).toContain('order')
      expect(domains, role.id).toContain('knowledge')
      // 订单**只读**：红人这条职责一辈子不该改一张订单
      expect(role.scopes.find((s) => s.domain === 'order')?.ops).toEqual(['read'])
      // 联系方式那条域的敏感级要高一档
      expect(role.scopes.find((s) => s.domain === 'creator_contact')?.max_sensitivity).toBe(
        'confidential',
      )
    }
  })

  it('五个写动作与额度（48 §5.1 那几个数）', () => {
    for (const role of ROLES) {
      const byId = new Map(role.actions.map((a) => [a.id, a]))
      expect([...byId.keys()].sort(), role.id).toEqual([
        'stage_affiliate_code',
        'stage_collaboration',
        'stage_deliverable_review',
        'stage_outreach',
        'stage_tracked_link',
      ])
      expect(byId.get('stage_outreach')?.mandate.caps.max_outreach_per_day).toBe(30)
      expect(byId.get('stage_collaboration')?.mandate.caps.max_collab_budget).toBe(500)
      expect(byId.get('stage_affiliate_code')?.mandate.caps.max_affiliate_discount_pct).toBe(20)
      expect(
        byId.get('stage_deliverable_review')?.mandate.caps.max_deliverable_reviews_per_day,
      ).toBe(20)
    }
  })

  it('开发信 L2 起可升 L3；建合作永远 L1 且 hard_ceiling', () => {
    for (const role of ROLES) {
      expect(role.automation.stage_outreach, role.id).toMatchObject({
        initial: 'L2',
        ceiling: 'L3',
      })
      expect(role.automation.stage_collaboration, role.id).toMatchObject({
        initial: 'L1',
        ceiling: 'L1',
        hard_ceiling: true,
      })
    }
  })

  it('渠道连接器一条一个 kind，而且**都不是必须**——没连也能用', () => {
    const kinds = ROLES.map((r) => r.connectors[0]?.kind)
    expect(kinds).toEqual([
      'youtube_data',
      'facebook_graph',
      'instagram_graph',
      'tiktok_research',
      'x_api',
    ])
    for (const role of ROLES)
      expect(
        role.connectors.every((c) => !c.required),
        role.id,
      ).toBe(true)
  })

  it('面板五个分块：找人 / 建联 / 合作 / 审核 / 归因', () => {
    for (const role of ROLES) {
      expect(
        role.home_blocks.map((b) => b.query),
        role.id,
      ).toEqual([
        'kol.discovery',
        'kol.outreach_funnel',
        'kol.collaborations',
        'kol.pending_deliverables',
        'kol.attribution',
      ])
      // 分块 id 带渠道：两条职责同时挂在一个人身上时面板上分得开
      expect(
        role.home_blocks.every((b) => b.id.startsWith(`${role.id}.`)),
        role.id,
      ).toBe(true)
    }
  })

  it('54 §2 岗位路由：五条的动作 id 与数据域一模一样，**意图词是唯一分得开它们的东西**', () => {
    const intents = ROLES.map(
      (r) => r.grounding?.find((g) => g.name.endsWith('_intent'))?.intent_terms ?? [],
    )
    for (const [i, terms] of intents.entries())
      expect(terms.length, ROLES[i]?.id).toBeGreaterThanOrEqual(8)
    // 每条都有只属于自己的词：任意两条之间不能互相是子集
    for (let i = 0; i < intents.length; i += 1)
      for (let j = 0; j < intents.length; j += 1) {
        if (i === j) continue
        const a = intents[i] ?? []
        const b = new Set(intents[j] ?? [])
        expect(
          a.some((t) => !b.has(t)),
          `${ROLES[i]?.id} vs ${ROLES[j]?.id}`,
        ).toBe(true)
      }
    // 48 §5.1 点名的那几个词在位（写不足 = 路由不到）
    const of = (id: string) => ROLES.find((r) => r.id === id)?.grounding?.[0]?.intent_terms ?? []
    expect(of('kol.youtube')).toEqual(expect.arrayContaining(['频道', '视频', '订阅', '播放']))
    expect(of('kol.tiktok')).toEqual(expect.arrayContaining(['抖', '短视频', '带货']))
    expect(of('kol.x')).toEqual(expect.arrayContaining(['推', '帖子', '长文', '转发']))
  })

  it('起草开发信之前先查事实卡（19：承诺类知识永不自动发布）', () => {
    for (const role of ROLES) {
      const g = role.grounding?.find((x) => x.name === 'facts_before_outreach')
      expect(g?.prefetch, role.id).toBe(true)
      expect(g?.cue_terms, role.id).toEqual(expect.arrayContaining(['佣金', '样品', '条款']))
    }
  })

  it('交接兜底到范围负责人，且带走队列车道', () => {
    for (const role of ROLES) {
      expect(role.handover.fallback, role.id).toBe('scope_manager')
      expect(role.handover.transfers, role.id).toContain('queue_lane')
    }
  })
})

describe('红人营销岗位模板（48 §5.1 / 54）', () => {
  it('五条职责，默认只勾 YouTube 与 Instagram', () => {
    const position = loadBundledPosition('kol-marketing')
    expect(position.id).toBe('kol-marketing')
    expect(position.name.zh).toBe('红人营销')
    expect(position.roles).toHaveLength(5)
    expect(position.roles.filter((r) => r.default).map((r) => r.role)).toEqual([
      'kol.youtube',
      'kol.instagram',
    ])
    expect(position.roles.filter((r) => !r.default).map((r) => r.role)).toEqual([
      'kol.tiktok',
      'kol.facebook',
      'kol.x',
    ])
  })
})
