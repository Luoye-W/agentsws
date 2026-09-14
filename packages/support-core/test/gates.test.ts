import { describe, expect, it } from 'vitest'
import {
  AUTONOMY_GATE_IDS,
  type AutonomyGateInput,
  buildCanonicalGateRuleset,
  evaluateAutonomyGates,
  formatL3Rule,
  GATE_RULESET_HASH,
  gateCommitmentScan,
  gateDraftOrigin,
  gateL3Denylist,
  L3_CATEGORIES,
  L3_LANGS,
  scanInboundBackstop,
  scanOutboundCommitment,
} from '../src/index.js'

const base = (over: Partial<AutonomyGateInput> = {}): AutonomyGateInput => ({
  channel: 'email',
  classification: {
    intent: 'order_tracking',
    source: 'email_classification',
    risk_level: 'normal',
  },
  inbound_text: 'Where is my parcel? Order 1001.',
  proposed_reply_text: 'Your parcel is on the way, tracking SF123.',
  draft: { generated_by: 'ai' },
  ...over,
})

describe('规则集哈希：只可加行（48 §4 L3 #3）', () => {
  it('九类六语一个不少', () => {
    expect(L3_CATEGORIES).toHaveLength(9)
    expect(L3_LANGS).toEqual(['en', 'zh', 'es', 'fr', 'de', 'ja'])
  })

  /**
   * 这条是**反向哨兵**：删一条 pattern、改一个键名、弱化一个正则，哈希就变，这条
   * 当场红。加一条也会变——那时候改这里的期望值，并在提交信息里说清加了什么。
   */
  it('规则集哈希钉死（快照）', () => {
    expect(GATE_RULESET_HASH).toBe(
      'b057f8af4ff14964f90f4e4d0d75a3f9783037a184a187ca397ea496e263ac13',
    )
  })

  it('序列化的形状钉死：键名与顺序是契约的一部分', () => {
    const canonical = buildCanonicalGateRuleset() as Record<string, unknown>
    expect(Object.keys(canonical)).toEqual([
      'categories',
      'langs',
      'emailIntentMap',
      'chatIntentMap',
      'firstPersonCommitment',
      'policyCommitment',
      't2',
      't3',
    ])
    // 每一类在 t2 / t3 里都有位置（哪怕某几语是空的）
    const t2 = canonical.t2 as Record<string, unknown>
    for (const category of L3_CATEGORIES) expect(t2).toHaveProperty(category)
  })

  it('rule id 格式：t1 不带语言，t2 / t3 带', () => {
    expect(formatL3Rule('refund', 't1')).toBe('l3:refund#t1')
    expect(formatL3Rule('refund', 't3', 'zh')).toBe('l3:refund#t3:zh')
  })
})

describe('门一 l3_denylist（G04：永不自动发送的九类六语）', () => {
  it('Tier-1：分类器说了话就查表，命中即不自主', () => {
    const r = gateL3Denylist(
      base({
        classification: {
          intent: 'returns_refunds',
          source: 'email_classification',
          risk_level: 'normal',
        },
      }),
    )
    expect(r.status).toBe('fail')
    expect(r.reason).toBe('l3_intent:refund')
    expect(r.evidence?.matched_rules).toEqual(['l3:refund#t1'])
  })

  it('Tier-1：聊天的 product_issue 只在高风险时落 product_safety', () => {
    const normal = gateL3Denylist(
      base({
        channel: 'chat',
        classification: {
          intent: 'product_issue',
          source: 'chat_classification',
          risk_level: 'normal',
        },
      }),
    )
    expect(normal.status).toBe('pass')
    const high = gateL3Denylist(
      base({
        channel: 'chat',
        classification: {
          intent: 'product_issue',
          source: 'chat_classification',
          risk_level: 'high',
        },
      }),
    )
    expect(high.reason).toBe('l3_intent:product_safety')
  })

  it('Tier-2 盲扫只在分类器没说话时跑；裸名词不算命中', () => {
    const none = { intent: null, source: 'none', risk_level: 'normal' } as const
    expect(
      gateL3Denylist(base({ classification: none, inbound_text: 'I want a refund now' })).status,
    ).toBe('fail')
    // 裸名词：不构成请求形态
    expect(
      gateL3Denylist(
        base({ classification: none, inbound_text: 'Your refund policy page is helpful.' }),
      ).status,
    ).toBe('pass')
    // 分类器说了话（且不在表里）→ 盲扫根本不跑，哪怕正文里写满了退款诉求
    expect(
      gateL3Denylist(
        base({
          classification: {
            intent: 'order_tracking',
            source: 'email_classification',
            risk_level: 'normal',
          },
          inbound_text: 'I want a refund now',
        }),
      ).status,
    ).toBe('pass')
  })

  it('Tier-2 多语言都跑：中文、德语、日语各命中一次', () => {
    expect(scanInboundBackstop('我要退款').some((h) => h.lang === 'zh')).toBe(true)
    expect(scanInboundBackstop('Ich will eine Rückerstattung').some((h) => h.lang === 'de')).toBe(
      true,
    )
    expect(scanInboundBackstop('返金してください').some((h) => h.lang === 'ja')).toBe(true)
  })

  it('法律威胁 / 安全事故 / 平台投诉都在九类里', () => {
    expect(scanInboundBackstop('I will take legal action').map((h) => h.category)).toContain(
      'legal_threat',
    )
    expect(scanInboundBackstop('The charger caught fire').map((h) => h.category)).toContain(
      'product_safety',
    )
    expect(scanInboundBackstop('I filed an A-to-Z claim').map((h) => h.category)).toContain(
      'platform_complaint',
    )
  })
})

describe('门二 draft_origin（G06：谁写的、缺不缺料）', () => {
  it('AI 写的、没缺料 → pass', () => {
    const r = gateDraftOrigin(base({ draft: { generated_by: 'ai', version_no: 2, model: 'x' } }))
    expect(r.status).toBe('pass')
    expect(r.evidence).toMatchObject({ generated_by: 'ai', draft_version_no: 2 })
  })

  it('人写的 → 不自主（谁写的谁按发送）', () => {
    const r = gateDraftOrigin(base({ draft: { generated_by: 'human' } }))
    expect(r.status).toBe('fail')
    expect(r.reason).toBe('draft_not_ai')
  })

  it('AI 自标缺料 → 不自主，且证据里只有"有没有"，没有缺料原文', () => {
    const r = gateDraftOrigin(
      base({ draft: { generated_by: 'ai', missing_info: '不知道客户的订单号' } }),
    )
    expect(r.status).toBe('fail')
    expect(r.reason).toBe('needs_info')
    expect(JSON.stringify(r.evidence)).not.toContain('订单号')
  })
})

describe('门三 commitment_scan（G10：第一人称承诺 + 无依据让步）', () => {
  it('普通查单回复放行', () => {
    expect(gateCommitmentScan(base()).status).toBe('pass')
  })

  it('第一人称承诺退款 → 不自主', () => {
    const r = gateCommitmentScan(
      base({ proposed_reply_text: 'We will refund you the full amount today.' }),
    )
    expect(r.status).toBe('fail')
    expect(r.reason).toBe('l3_commitment:refund')
  })

  it('子句级否定守卫：「我做不到 X」不算承诺 X，但要留痕', () => {
    const r = gateCommitmentScan(
      base({ proposed_reply_text: "I'm not able to issue a refund for this order." }),
    )
    expect(r.status).toBe('pass')
    expect(r.evidence?.negated_rules).toBeDefined()
  })

  it('否定守卫是收紧方向：破折号切断子句后仍然阻断', () => {
    const r = gateCommitmentScan(
      base({ proposed_reply_text: "We can't wait to help — we will refund you in full." }),
    )
    expect(r.status).toBe('fail')
  })

  it('无依据让步是**句内**共现：政策援引与承诺分在两句不误判', () => {
    const safe = gateCommitmentScan(
      base({
        proposed_reply_text:
          'Our return policy allows returns within 30 days. I can check the status for you.',
      }),
    )
    expect(safe.status).toBe('pass')
    const bad = gateCommitmentScan(
      base({ proposed_reply_text: 'As an apology I will send you a $80 credit.' }),
    )
    expect(bad.status).toBe('fail')
  })

  it('证据里只有句序号与长度，绝不抄句子原文', () => {
    const r = gateCommitmentScan(
      base({ proposed_reply_text: 'As a gesture we will give you 20% off your next order.' }),
    )
    expect(r.status).toBe('fail')
    expect(JSON.stringify(r.evidence ?? {})).not.toContain('20%')
    const scan = scanOutboundCommitment('As a gesture we will give you 20% off your next order.')
    expect(scan.unsourced_concession || scan.hits.length > 0).toBe(true)
  })
})

describe('编排：三条都跑完、fail-closed、只记录不改状态', () => {
  it('三条全 pass = 可以自主发', () => {
    const d = evaluateAutonomyGates(base())
    expect(d.autonomous).toBe(true)
    expect(d.results.map((r) => r.gate)).toEqual([...AUTONOMY_GATE_IDS])
    expect(d.ruleset_hash).toBe(GATE_RULESET_HASH)
  })

  it('不短路：第一条 fail 之后另外两条照样有结论（审计行要完整）', () => {
    const d = evaluateAutonomyGates(
      base({
        classification: {
          intent: 'returns_refunds',
          source: 'email_classification',
          risk_level: 'normal',
        },
        draft: { generated_by: 'human' },
      }),
    )
    expect(d.autonomous).toBe(false)
    expect(d.blocking_gate).toBe('l3_denylist')
    expect(d.results).toHaveLength(3)
    expect(d.results.map((r) => r.status)).toEqual(['fail', 'fail', 'pass'])
  })

  it('fail-closed：门内报错 = 不自主，且能与"确实命中"分得开', () => {
    const exploding = base()
    // 让 Tier-2 盲扫拿到一个会炸的输入：`inbound_text` 的 getter 抛异常
    Object.defineProperty(exploding, 'inbound_text', {
      get() {
        throw new Error('boom')
      },
    })
    Object.assign(exploding.classification, { source: 'none' })
    const d = evaluateAutonomyGates(exploding)
    expect(d.autonomous).toBe(false)
    const gate = d.results.find((r) => r.gate === 'l3_denylist')
    expect(gate?.status).toBe('gate_error')
    expect(gate?.reason).toContain('boom')
  })

  it('每条结论都印规则集哈希（自主发送审计链的锚）', () => {
    for (const r of evaluateAutonomyGates(base()).results) {
      expect(r.ruleset_hash).toBe(GATE_RULESET_HASH)
    }
  })
})
