/**
 * 任务路由（41 §1.2 第三行、06 §2.4「职责分类表就是路由词典」）。
 *
 * 秘书不问"这条给谁"，问"**这条属于哪个职责**"，然后查分配表找持有人。判据全部来自
 * 04 / 05 的职责定义本身：名字、`description` 里那串"管什么"、`grounding` 的意图词、
 * `actions` 的动作 id、`scopes` 的数据域。所以公司改了职责定义，路由跟着变，不用改代码。
 *
 * 两条纪律：
 * - **秘书不执行专业动作**：路由结果是提议，认领才成立（06 §2、31 I13）。
 * - **分不清就当成一件活**：出一张等人认领的卡，比替人回答一个专业问题安全。
 */
import type { PersonId, RoleId } from '@agentsws/contracts'
import { containsTerm, looksLikeQuestion, normalize, splitPhrases } from './text.js'
import type { RoleProfile, RoleTerm, RouteScore, RouteVerdict } from './types.js'

/** 判据词的权重：动作 id 与意图词最硬，数据域最软。 */
const WEIGHT = { name: 1.5, description: 1.2, grounding: 1.6, action: 2, domain: 0.6 } as const

/** 单字判据词（`退`）只算半分——它太容易撞上。 */
const SHORT_TERM_PENALTY = 0.4

/** 置信度低于它就不下判断，进"没有主人"的车道（06 §2.4 最后一行）。 */
export const MIN_CONFIDENCE = 0.25

/**
 * 数据域 → 人话词。
 *
 * 职责定义里写的是 `order` / `shipment` 这种机器词，人说的是"订单""物流"。
 * 这张表小而稳，只覆盖 04 已经定下来的域；不认识的域就用它自己的英文名当判据词。
 */
export const DOMAIN_TERMS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  order: ['订单', '下单', 'order'],
  shipment: ['物流', '快递', '包裹', '运单', '发货', 'shipment', 'tracking'],
  customer: ['客户', '顾客', '买家', '投诉', 'customer'],
  product: ['商品', '产品', '详情页', '上架', '下架', 'product', 'listing'],
  content: ['文案', '内容', '素材', 'content'],
  discount: ['折扣', '优惠', '促销', '券', 'discount', 'coupon'],
  campaign: ['广告', '计划', '投放', 'campaign'],
  ad_account: ['广告账户', '投放', 'ads'],
  finance: ['财务', '对账', '发票', '付款', 'finance'],
  analytics: ['报表', '数据', '转化', 'analytics'],
  knowledge: [],
  approval: [],
  skill: [],
  event_log: [],
  policy: [],
})

/**
 * 动作 id → 人话词。同样只覆盖 27 首批职责模板里的那几个；不认识的按 `_` 拆成英文词。
 */
export const ACTION_TERMS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  reply_customer: ['回复', '回信', '答复', '客户'],
  // 中文的并列缩略（"退换货"）按字面切不出"退货"，所以这些常用说法要显式列出来
  stage_refund: ['退款', '退钱', '退货', '退换', '换货', 'refund', 'return'],
  stage_reship: ['补发', '重发', '再发一件', 'reship'],
  stage_address_change: ['改地址', '地址', 'address'],
  draft_chargeback_evidence: ['拒付', '争议', 'chargeback', 'dispute'],
  stage_listing_edit: ['详情页', '上架', '下架', '改标题', 'listing'],
  stage_price_change: ['价格', '改价', '调价', 'price'],
  stage_promotion: ['促销', '活动', '优惠', 'promotion'],
  stage_pause_ad: ['暂停广告', '关广告', 'pause'],
  stage_negative_keyword: ['否词', '否定关键词', 'negative'],
  stage_budget_change: ['预算', '加预算', 'budget'],
})

/**
 * 结构类型：本包不 import `@agentsws/roles`（它依赖 core 与 casbin，路由用不着）。
 * 装配方把职责定义按这个形状递过来即可。
 */
export interface RoleLike {
  id: string
  name?: { zh?: string; en?: string } | undefined
  description?: string | undefined
  grounding?: readonly { intent_terms?: readonly string[]; cue_terms?: readonly string[] }[]
  actions?: readonly { id: string }[]
  scopes?: readonly { domain: string }[]
}

/** 从一份职责定义里抽出全部判据词（去重，保留来源与权重）。 */
export function roleTermsOf(role: RoleLike): RoleTerm[] {
  const out = new Map<string, RoleTerm>()
  const add = (text: string, from: RoleTerm['from']): void => {
    const t = text.trim()
    if (t === '') return
    const weight = WEIGHT[from] * ([...t].length <= 1 ? SHORT_TERM_PENALTY : 1)
    const key = normalize(t)
    if (key === '') return
    const prev = out.get(key)
    if (prev === undefined || prev.weight < weight) out.set(key, { text: t, from, weight })
  }
  if (role.name?.zh !== undefined) add(role.name.zh, 'name')
  if (role.name?.en !== undefined) add(role.name.en, 'name')
  for (const phrase of splitPhrases(role.description ?? '')) add(phrase, 'description')
  for (const g of role.grounding ?? []) {
    for (const t of g.intent_terms ?? []) add(t, 'grounding')
    for (const t of g.cue_terms ?? []) add(t, 'grounding')
  }
  for (const a of role.actions ?? []) {
    const known = ACTION_TERMS[a.id]
    if (known === undefined) for (const t of a.id.split('_')) add(t, 'action')
    else for (const t of known) add(t, 'action')
  }
  for (const s of role.scopes ?? [])
    for (const t of DOMAIN_TERMS[s.domain] ?? [s.domain]) add(t, 'domain')
  return [...out.values()]
}

/**
 * 通用职责不参与路由竞争：`common.member` 的"管什么"是"个人任务"，
 * 任何一件活都能算进去，让它参赛等于没有路由。
 */
export const GENERIC_ROLES: readonly RoleId[] = ['common.member', 'common.owner']

export interface RouteInput {
  text: string
  roles: readonly RoleProfile[]
  /** 秘书是谁的（他自己持有的岗位优先命中时不算"路由给别人"，只用于解释） */
  me?: PersonId
}

/** 给每个职责打分：命中的判据词权重之和，按该职责判据词总量做一次弱归一。 */
export function scoreRoles(text: string, roles: readonly RoleProfile[]): RouteScore[] {
  const n = normalize(text)
  const scored = roles
    .filter((r) => !GENERIC_ROLES.includes(r.role_id))
    .map((role) => {
      let score = 0
      const matched: string[] = []
      for (const term of role.terms) {
        if (!containsTerm(n, term.text)) continue
        score += term.weight
        matched.push(term.text)
      }
      return { role_id: role.role_id, role_name: role.role_name, score, matched }
    })
    .filter((s) => s.score > 0)
  scored.sort((a, b) => b.score - a.score || (a.role_id < b.role_id ? -1 : 1))
  return scored
}

/**
 * 判断这件事该谁做。
 *
 * `confidence` = 第一名的分数占前两名之和的比例（一骑绝尘 → 接近 1；两个职责难分 → 接近 0.5），
 * 再乘一个"命中够不够多"的系数。低于 {@link MIN_CONFIDENCE} 就不指名——06 §2.4 说得清楚：
 * 置信度不够时进"未认领"车道，而不是猜。
 */
export function routeTask(input: RouteInput): RouteVerdict {
  const kind = looksLikeQuestion(input.text) ? 'question' : 'task'
  const scores = scoreRoles(input.text, input.roles)
  const first = scores[0]
  if (first === undefined)
    return {
      kind,
      confidence: 0,
      reason: '代理判断：看不出这属于哪个岗位，先进"没人认领"的车道',
      scores,
    }
  const second = scores[1]?.score ?? 0
  const separation = first.score / (first.score + second)
  // 命中一个硬判据词（动作 id 那一档，权重 2）就够"有把握"了；再多只是更有把握
  const strength = Math.min(1, first.score / 3)
  const confidence = Math.round(separation * strength * 100) / 100
  const role = input.roles.find((r) => r.role_id === first.role_id)
  const holder = role?.positions[0]
  const why = first.matched
    .slice(0, 3)
    .map((m) => `「${m}」`)
    .join('、')
  if (confidence < MIN_CONFIDENCE)
    return {
      kind,
      confidence,
      reason: `代理判断：像是${first.role_name}的活（${why}），但不够有把握，先进"没人认领"的车道`,
      scores,
    }
  return {
    kind,
    role_id: first.role_id,
    role_name: first.role_name,
    confidence,
    reason:
      kind === 'question'
        ? `代理判断：这是${first.role_name}的专业问题（${why}），代理不答，转给岗位`
        : `代理判断：${first.role_name}，因为你说了${why}`,
    scores,
    ...(holder === undefined ? {} : { position_id: holder.position_id, owner: holder.person_id }),
  }
}
