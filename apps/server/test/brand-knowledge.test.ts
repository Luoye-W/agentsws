/**
 * 确认档案卡那一刻建的首批知识条目（70 §3.5，WP121b）。
 *
 * 四件：
 *
 * 1. 建的是**政策要点与商品卡**，别的字段（品牌名、主色、社媒）一条都不建——
 *    那些进工作区档案，不进知识库；
 * 2. 每条都带出处，`locator` 是「自动分析，待核」——人一眼看得出这不是同事写的；
 * 3. 说不出出处的（没有 url 的政策、没有价的商品）**直接跳过**，不建一条编的；
 * 4. 真塞进 `packages/knowledge` 之后，状态是 `proposed`、把握度是 `unverified`，
 *    而且政策那条是 `policy` 层（承诺类永不自动激活）。
 */
import type { BrandIntakeProfile } from '@agentsws/contracts'
import { createKnowledge } from '@agentsws/knowledge'
import { describe, expect, it } from 'vitest'
import { BRAND_INTAKE_LOCATOR, brandKnowledgeCards } from '../src/brand-knowledge.js'

const AT = '2026-09-19T09:00:00.000Z'
const WS = 'ws_test'
const OWNER = 'p_1'

const ev = (url: string) => [{ url, locator: 'selector:main' }]

const PROFILE: BrandIntakeProfile = {
  brand_name: { value: 'Nordvik Supply', confidence: 'high', evidence: ev('https://n.example/') },
  primary_color: { value: '#123456', confidence: 'medium', evidence: ev('https://n.example/') },
  social_links: {
    value: [{ platform: 'instagram', url: 'https://instagram.com/nordvik' }],
    confidence: 'medium',
    evidence: ev('https://n.example/'),
  },
  policies: {
    value: [
      {
        kind: 'refund',
        summary: '收到后 30 天内可退，运费买家承担。',
        url: 'https://n.example/policies/refund-policy',
      },
      { kind: 'shipping', summary: '48 小时内发出。', url: 'https://n.example/policies/shipping' },
    ],
    confidence: 'medium',
    evidence: ev('https://n.example/policies/refund-policy'),
  },
  products: {
    value: [
      {
        title: 'Granite Wallet',
        price_snapshot: '$49.00',
        currency: 'USD',
        url: 'https://n.example/products/granite-wallet',
      },
      // 抓到了名字但没抓到价：这一条建不出一句有用的话
      { title: 'Fjord Tote', url: 'https://n.example/products/fjord-tote' },
    ],
    confidence: 'high',
    evidence: ev('https://n.example/'),
  },
}

describe('WP121b 首批知识条目 · 翻译', () => {
  it('只建政策与商品；品牌名、主色、社媒一条都不建', () => {
    const cards = brandKnowledgeCards(PROFILE, { workspace_id: WS, at: AT, owner: OWNER })
    expect(cards.map((c) => c.subject.key)).toEqual([
      'policy:refund',
      'policy:shipping',
      'product:Granite Wallet',
    ])
    expect(cards.some((c) => c.statement.includes('#123456'))).toBe(false)
    expect(cards.some((c) => c.statement.includes('instagram'))).toBe(false)
  })

  it('每条都带出处，来源标成「自动分析，待核」', () => {
    const cards = brandKnowledgeCards(PROFILE, { workspace_id: WS, at: AT, owner: OWNER })
    for (const card of cards) {
      expect(card.provenance).toHaveLength(1)
      expect(card.provenance[0]?.source).toBe('web')
      expect(card.provenance[0]?.locator).toBe(BRAND_INTAKE_LOCATOR)
      expect(card.provenance[0]?.ref).toContain('https://n.example/')
      expect(card.created_by).toEqual({ kind: 'agent', id: 'brand-intake' })
    }
    // 退款那条的原文在 quote 里：人核对时要能在页面上搜到这串字
    expect(cards[0]?.provenance[0]?.quote).toContain('30 天内可退')
  })

  it('政策进 policy 层，商品价进 fact 层', () => {
    const cards = brandKnowledgeCards(PROFILE, { workspace_id: WS, at: AT, owner: OWNER })
    expect(cards[0]?.layer).toBe('policy')
    expect(cards[2]?.layer).toBe('fact')
    // 价格是天天变的，它不该跟着政策的审批节奏走
    expect(cards[2]?.structured).toMatchObject({ price_snapshot: '$49.00', currency: 'USD' })
  })

  it('没抓到价的商品、没有网址的政策：**不建**，不编一条', () => {
    const cards = brandKnowledgeCards(PROFILE, { workspace_id: WS, at: AT, owner: OWNER })
    expect(cards.some((c) => c.subject.key === 'product:Fjord Tote')).toBe(false)
    expect(brandKnowledgeCards({}, { workspace_id: WS, at: AT, owner: OWNER })).toEqual([])
  })
})

describe('WP121b 首批知识条目 · 真塞进知识库', () => {
  it('落地的是 proposed / unverified：人点头之前没有 Agent 会把它当口径', async () => {
    const knowledge = createKnowledge({ workspace_id: WS })
    try {
      const cards = brandKnowledgeCards(PROFILE, { workspace_id: WS, at: AT, owner: OWNER })
      for (const card of cards) await knowledge.store.propose(card)

      // 一把能看见公司级知识的钥匙（19 §3：无权的数据域根本不进候选集）
      const listed = await knowledge.store.list(
        { workspace_id: WS },
        {
          person_id: OWNER,
          workspace_id: WS,
          grants: [
            {
              domain: 'knowledge',
              ops: ['read'],
              range: 'workspace',
              max_sensitivity: 'restricted',
            },
          ],
        },
      )
      expect(listed).toHaveLength(3)
      for (const card of listed) {
        expect(card.status).toBe('proposed')
        expect(card.confidence.state).toBe('unverified')
      }
      expect(listed.filter((c) => c.layer === 'policy')).toHaveLength(2)
    } finally {
      knowledge.close()
    }
  })
})
