/**
 * 48 v2 L2 垂直包：parity guard + 行为。
 *
 * parity guard 照 KefuAgent 的做法：**两个包的字段集合必须一致，且不许有空字符串**。
 * 少一个键，那一处 prompt 就插值成 `undefined`；空一个串，AI 那一段就什么都没被告知。
 * 这两种坏法都不会抛错，只会安静地少一条边界——所以只能靠 guard 盯。
 */
import { describe, expect, it } from 'vitest'
import {
  classifyText,
  deriveNeeds,
  digitalPack,
  draftReply,
  extractRiskTerms,
  gateChange,
  getVerticalPack,
  goodsPack,
  isVertical,
  normalizeVertical,
  renderChatRules,
  renderReplyBody,
  staticPrefixText,
  VERTICALS,
  type VerticalPack,
  verticalChoices,
} from '../src/index.js'

const NOW = '2026-09-14T09:00:00.000Z'
const PACKS: VerticalPack[] = [goodsPack, digitalPack]

/**
 * 内容表：键本身就是内容（类目名、意图名、语言码），两个包本来就不一样。
 * 比到这一层为止——它们的**完整性**由下面各自的用例盯（每一类都有词条、每个意图都有标签）。
 */
const CONTENT_MAPS = new Set([
  'intents.labelsZh',
  'intents.guideOpeningStrategies',
  'l3Denylist.t2',
  'l3Denylist.t3',
  'l3Denylist.emailIntentMap',
  'l3Denylist.chatIntentMap',
  'l3Denylist.riskGatedChatIntents',
  'changeGate.governing',
])

/** 递归收集"路径 → 值的形状"，用来比两个包的字段面。 */
function shapeOf(value: unknown, path = ''): string[] {
  // 数组长度不比（两个包本来就不一样长），只比"这个路径上是个数组"
  if (Array.isArray(value)) return [`${path}: array`]
  if (value instanceof RegExp) return [`${path}: regexp`]
  if (CONTENT_MAPS.has(path)) return [`${path}: map`]
  if (value !== null && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .flatMap(([k, v]) => shapeOf(v, path === '' ? k : `${path}.${k}`))
      .sort()
  }
  return [`${path}: ${typeof value}`]
}

/** 所有字符串叶子（连同它的路径），用来查空串。 */
function strings(value: unknown, path = ''): { path: string; text: string }[] {
  if (typeof value === 'string') return [{ path, text: value }]
  if (value instanceof RegExp) return []
  if (Array.isArray(value)) return value.flatMap((v, i) => strings(v, `${path}[${i}]`))
  if (value !== null && typeof value === 'object')
    return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) =>
      strings(v, path === '' ? k : `${path}.${k}`),
    )
  return []
}

describe('垂直包 registry（48 v2 L2）', () => {
  it('非法值、缺省、null 一律回落实物——存量工作区零变化', () => {
    expect(getVerticalPack(undefined).key).toBe('goods')
    expect(getVerticalPack(null).key).toBe('goods')
    expect(getVerticalPack('').key).toBe('goods')
    expect(getVerticalPack('GOODS').key).toBe('goods')
    expect(getVerticalPack('physical').key).toBe('goods')
    expect(getVerticalPack('digital').key).toBe('digital')
    expect(normalizeVertical('digital')).toBe('digital')
    expect(normalizeVertical('physical')).toBeUndefined()
    expect(isVertical('goods')).toBe(true)
    expect(isVertical(7)).toBe(false)
    expect(VERTICALS).toEqual(['goods', 'digital'])
  })

  it('首次设置那一步的两个选项各有中文名与一句人话', () => {
    const choices = verticalChoices()
    expect(choices.map((c) => c.key)).toEqual(['goods', 'digital'])
    expect(choices[0]?.label).toBe('实物商品')
    expect(choices[1]?.label).toBe('虚拟产品与服务')
    for (const c of choices) expect(c.hint.length).toBeGreaterThan(8)
  })
})

describe('parity guard：两个包必须同形', () => {
  it('字段面（递归到叶子的路径集合）逐条相同', () => {
    const [goods, digital] = PACKS.map((p) => shapeOf({ ...p, key: '' }))
    expect(digital).toEqual(goods)
  })

  it('没有空字符串——空的那一段等于 AI 什么都没被告知', () => {
    for (const pack of PACKS) {
      const empty = strings(pack).filter((s) => s.text.trim() === '')
      expect(empty, `${pack.key} 有空串：${empty.map((e) => e.path).join(', ')}`).toEqual([])
    }
  })

  it('人设 20 个站点两边都齐（少一个就有一处 prompt 插值成 undefined）', () => {
    expect(Object.keys(digitalPack.persona).sort()).toEqual(Object.keys(goodsPack.persona).sort())
    expect(Object.keys(goodsPack.persona)).toHaveLength(20)
  })

  it('两边的意图枚举、标签表、引导策略互相对得上', () => {
    for (const pack of PACKS) {
      // 标签表覆盖每一个意图值
      for (const v of pack.intents.values) expect(pack.intents.labelsZh[v]).toBeTruthy()
      // 引导类目是意图值的真子集，兜底类排最后
      expect(pack.intents.values).toEqual(expect.arrayContaining([...pack.intents.guideCategories]))
      expect(pack.intents.guideCategories.length).toBeLessThan(pack.intents.values.length)
      expect(pack.intents.guideCategories.at(-1)).toBe('general_support')
      // 每个引导类目都有一句开场策略
      for (const c of pack.intents.guideCategories)
        expect(pack.intents.guideOpeningStrategies[c]).toBeTruthy()
      // 分类器最后一条是无 terms 的兜底
      expect(pack.intents.classifierRules.at(-1)?.terms).toEqual([])
      // 售前意图必须在意图值域里
      expect(pack.intents.values).toContain(pack.presales.intent)
      // 计划里引用到的意图也都在值域里
      for (const rule of pack.chatPlan.missingInfo)
        for (const i of rule.intents) expect(pack.intents.values).toContain(i)
      for (const i of [...pack.chatPlan.nonBlockingIntents, ...pack.chatPlan.mustReviewIntents])
        expect(pack.intents.values).toContain(i)
      expect(pack.intents.values).toContain(pack.chatPlan.handoffIntent)
    }
  })

  it('L3 词表：每一类都有词条，意图映射指向存在的类目', () => {
    for (const pack of PACKS) {
      const cats = new Set(pack.l3Denylist.categories)
      for (const c of pack.l3Denylist.categories) {
        expect(
          Object.keys(pack.l3Denylist.t2[c] ?? {}).length,
          `${pack.key} t2 ${c}`,
        ).toBeGreaterThan(0)
        expect(
          Object.keys(pack.l3Denylist.t3[c] ?? {}).length,
          `${pack.key} t3 ${c}`,
        ).toBeGreaterThan(0)
      }
      for (const c of Object.values(pack.l3Denylist.emailIntentMap)) expect(cats.has(c)).toBe(true)
      for (const c of Object.values(pack.l3Denylist.chatIntentMap)) expect(cats.has(c)).toBe(true)
      for (const g of Object.values(pack.l3Denylist.riskGatedChatIntents))
        expect(cats.has(g.category)).toBe(true)
    }
  })

  it('业务边界：id 不重复，enforced 的都有触发面，管着变更的那几条都在册', () => {
    for (const pack of PACKS) {
      const ids = pack.boundaries.map((b) => b.id)
      expect(new Set(ids).size).toBe(ids.length)
      for (const b of pack.boundaries) {
        expect(b.options.length, `${pack.key} ${b.id}`).toBeGreaterThan(1)
        if (b.wiring !== 'enforced') continue
        expect(
          Object.keys(b.applies_when).length,
          `${pack.key} ${b.id} 没有触发面`,
        ).toBeGreaterThan(0)
      }
      for (const required of Object.values(pack.changeGate.governing))
        for (const id of required ?? []) expect(ids).toContain(id)
      expect(ids).toContain(pack.changeGate.window.boundaryId)
      for (const extra of pack.changeGate.extra) expect(ids).toContain(extra.boundaryId)
    }
  })

  it('分流表：规则顺序稳定，兜底不是客服邮件，缺料措辞非空', () => {
    for (const pack of PACKS) {
      expect(pack.triage.rules.length).toBeGreaterThan(3)
      expect(pack.triage.fallback.is_customer_service).toBe(false)
      for (const r of pack.triage.rules) expect(r.terms.length).toBeGreaterThan(0)
      for (const n of pack.triage.needs) expect(n.terms.length).toBeGreaterThan(0)
    }
  })

  it('起草纪律两边条数相同、编号一一对应', () => {
    expect(digitalPack.draft.rules).toHaveLength(goodsPack.draft.rules.length)
    const numbers = (rules: readonly string[]) => rules.map((r) => r.slice(0, r.indexOf('.')))
    expect(numbers(digitalPack.draft.rules)).toEqual(numbers(goodsPack.draft.rules))
  })
})

describe('digital 的红线', () => {
  it('聊天规则、邮件规则、起草纪律里不许出现「订单 / 物流 / Shopify」', () => {
    const text = [
      ...renderChatRules(digitalPack.chatRules, ['30 天无理由']),
      ...digitalPack.emailRules.emailAgent,
      ...digitalPack.emailRules.emailRewrite,
      ...digitalPack.draft.rules,
      digitalPack.draft.persona,
    ].join('\n')
    expect(text).not.toContain('订单')
    expect(text).not.toContain('物流')
    expect(text).not.toContain('Shopify')
  })

  it('缺料措辞与回信模板里不许出现「订单号 / order number」', () => {
    const text = [
      ...digitalPack.chatPlan.missingInfo.flatMap((m) => [m.label, m.labelEn]),
      digitalPack.chatPlan.handoffReplyEn,
      ...Object.values(digitalPack.draft.template).map(String),
      ...digitalPack.triage.needs.map((n) => n.need),
    ].join('\n')
    expect(text).not.toContain('订单号')
    expect(text.toLowerCase()).not.toContain('order number')
  })

  it('意图词表里不许出现实物侧的高频误伤词', () => {
    const terms = digitalPack.intents.classifierRules
      .flatMap((r) => [
        ...r.terms,
        ...(r.subIntent?.terms ?? []),
        ...(r.riskEscalation?.terms ?? []),
      ])
      .join('|')
    for (const bad of ['package', 'delivery', 'track', 'shipment', 'parcel', 'my order'])
      expect(terms, bad).not.toContain(bad)
  })

  it('不跑商品枚举，但文档站的探测路径要在', () => {
    expect(digitalPack.knowledge.enumerateCatalog).toBe(false)
    expect(goodsPack.knowledge.enumerateCatalog).toBe(true)
    expect(digitalPack.knowledge.supportSubdomains).toContain('docs')
    expect(digitalPack.knowledge.wellKnownPaths).toContain('/docs')
    // goods 的七条一条不删
    for (const p of goodsPack.knowledge.wellKnownPaths)
      expect(digitalPack.knowledge.wellKnownPaths).toContain(p)
  })
})

describe('聊天规则 11 的条件语义（渲染纯函数）', () => {
  it('没配额外边界 → 那一行是空串（不是不存在）', () => {
    const lines = renderChatRules(goodsPack.chatRules)
    expect(lines[goodsPack.chatRules.boundaryRuleIndex]).toBe('')
    expect(lines).toHaveLength(goodsPack.chatRules.numbered.length + 1)
  })

  it('配了就填进模板，插在规则 10 后面', () => {
    const lines = renderChatRules(goodsPack.chatRules, ['30 天无理由', '运费买家承担'])
    expect(lines[goodsPack.chatRules.boundaryRuleIndex]).toBe(
      '11. 商家额外边界：30 天无理由；运费买家承担',
    )
    expect(lines[goodsPack.chatRules.boundaryRuleIndex - 1]?.startsWith('10. ')).toBe(true)
    expect(lines[goodsPack.chatRules.boundaryRuleIndex + 1]?.startsWith('12. ')).toBe(true)
  })

  it('digital 少一条 6a，所以插入位是 11 不是 12', () => {
    expect(goodsPack.chatRules.boundaryRuleIndex).toBe(12)
    expect(digitalPack.chatRules.boundaryRuleIndex).toBe(11)
    expect(goodsPack.chatRules.numbered.some((r) => r.startsWith('6a. '))).toBe(true)
    expect(digitalPack.chatRules.numbered.some((r) => r.startsWith('6a. '))).toBe(false)
  })
})

describe('按垂直取：分类 / 缺料 / 风险词 / 边界 / 起草', () => {
  it('同一封「登录不上」的来信：实物判不出、虚拟产品判成账号与登录', () => {
    const inbound = { text: 'I cannot log in, the password reset link never arrives.' }
    const goods = classifyText(inbound, { now: NOW })
    expect(goods.intent).toBe('other')
    expect(goods.is_customer_service).toBe(false)

    const digital = classifyText(inbound, { now: NOW, vertical: 'digital' })
    expect(digital.intent).toBe('account_access')
    expect(digital.is_customer_service).toBe(true)
  })

  it('同一封「我为什么被扣了两次费」：虚拟产品判成账单，不当成平台通知', () => {
    const inbound = { text: 'I was charged twice this month, please check the invoice.' }
    expect(classifyText(inbound, { now: NOW, vertical: 'digital' }).intent).toBe('billing')
  })

  it('第三方服务商发来的通知按发件域排除，不当客户来信', () => {
    const c = classifyText(
      { text: 'Your invoice is available.', from: 'billing@stripe.com' },
      { now: NOW, vertical: 'digital' },
    )
    expect(c.intent).toBe('platform_notification')
    expect(c.is_customer_service).toBe(false)
  })

  it('缺料措辞：实物要订单号 / 照片，虚拟产品要注册邮箱 / 复现信息', () => {
    expect(deriveNeeds('I want a refund')).toEqual(['order_ref'])
    expect(deriveNeeds('the item arrived damaged')).toEqual(['photos'])
    expect(deriveNeeds('I want a refund', 'digital')).toEqual(['registered_email'])
    expect(deriveNeeds('the app keeps crashing', 'digital')).toEqual(['repro_steps'])
  })

  it('风险词按垂直取：实物认 damaged / tracking，虚拟产品只认那四个', () => {
    expect(extractRiskTerms('the parcel is damaged')).toEqual(['damaged'])
    expect(extractRiskTerms('the parcel is damaged', 'digital')).toEqual([])
    expect(extractRiskTerms('I want a refund or a chargeback', 'digital')).toEqual([
      'refund',
      'chargeback',
    ])
  })

  it('变更门：两个垂直问的是两条不同的边界', () => {
    const classification = classifyText({ text: 'I want a refund' }, { now: NOW })
    const goods = gateChange({ change_kind: 'refund', classification, policies: [] })
    expect(goods.missing.map((b) => b.id)).toEqual(['policy.refund_window'])

    const digital = gateChange({
      change_kind: 'refund',
      classification,
      policies: [],
      vertical: 'digital',
    })
    expect(digital.missing.map((b) => b.id)).toEqual(['policy.subscription_refund'])
    expect(digital.missing[0]?.question).toBe('订阅费的退款口径是什么？')
  })

  it('丢件那道额外的门只在实物侧存在', () => {
    const text = 'The tracking page shows delivered but I never received the package.'
    const classification = classifyText({ text }, { now: NOW })
    expect(
      gateChange({ change_kind: 'refund', classification, policies: [], text }).missing.map(
        (b) => b.id,
      ),
    ).toContain('policy.lost_package_liability')
    expect(
      gateChange({
        change_kind: 'refund',
        classification,
        policies: [],
        text,
        vertical: 'digital',
      }).missing.map((b) => b.id),
    ).not.toContain('policy.lost_package_liability')
  })

  it('回信模板：实物开口背退货窗口，虚拟产品读不到条款时不背，改问注册邮箱', () => {
    const goods = renderReplyBody({
      windowDays: 14,
      withinWindow: false,
      windowFromFact: false,
      signature: 'Care',
      customer: 'there',
    })
    expect(goods).toContain('Our return policy allows returns within 14 days of delivery.')
    expect(goods).toContain('Tell us the order number and we will check what applies.')

    const digital = renderReplyBody({
      windowDays: 14,
      withinWindow: false,
      windowFromFact: false,
      signature: 'Care',
      customer: 'there',
      vertical: 'digital',
    })
    expect(digital).not.toContain('refund policy')
    expect(digital).toContain(
      'Tell us the email address your account is registered with and we will check what applies.',
    )
  })

  it('真读到条款数值时，虚拟产品照印那一句', () => {
    const body = renderReplyBody({
      windowDays: 7,
      withinWindow: false,
      windowFromFact: true,
      signature: 'Care',
      customer: 'there',
      vertical: 'digital',
    })
    expect(body).toContain('Our refund policy covers subscriptions within 7 days of the charge.')
  })

  it('起草一整封：虚拟产品的账号问题不提订单、追问注册邮箱', () => {
    const inbound = { text: 'I cannot log in to my account, the reset link never arrives.' }
    const drafted = draftReply({
      inbound,
      classification: classifyText(inbound, { now: NOW, vertical: 'digital' }),
      policies: [],
      knowledge_hits: [],
      persona: { signature: 'Care' },
      locale: 'en',
      now: NOW,
      vertical: 'digital',
    })
    expect(drafted.body.toLowerCase()).not.toContain('order')
    expect(drafted.body).toContain('the email address your account is registered with')
    expect(drafted.needs).toEqual(['registered_email'])
    expect(drafted.subject).toBe('Re: your message')
  })

  it('起草提示词：人设与纪律按垂直换，实物那一档字节不变', () => {
    expect(staticPrefixText()).toBe(staticPrefixText('goods'))
    expect(staticPrefixText('goods')).toContain('订单事实')
    expect(staticPrefixText('digital')).toContain('账户事实')
    expect(staticPrefixText('digital')).not.toContain('订单事实')
  })
})
