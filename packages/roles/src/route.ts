/**
 * 路由判据（06 §2.4「职责分类表就是路由词典」、41 §1.2 第三行、54 §2 岗位内路由）。
 *
 * **这一份是判据的唯一真源。** WP69 之前它长在 `@agentsws/secretary` 里，因为那时候
 * 只有一个用处：秘书问"这条属于哪个职责"。54 之后同一套判据有了第二个用处——
 * 岗位内路由（"交给网站运营一件事，它自己判断走哪条职责"）。两处各写一套的下场是
 * 同一句话在秘书那里进售后、在岗位页里进店铺管理，而且谁也说不清哪边对。
 * 所以判据搬到职责包里：**判据全部来自职责定义本身**，它本来就该和职责定义住在一起。
 *
 * 判据一个字没改（`packages/secretary` 那套测试原样钉着）：名字、`description` 里
 * 那串"管什么"、`grounding` 的意图词、`actions` 的动作 id、`scopes` 的数据域。
 * 所以公司改了职责定义，路由跟着变，不用改代码。
 *
 * 纯函数：不碰存储、不碰时钟、不碰随机。
 */
import type { PersonId, RoleId } from '@agentsws/contracts'

/** 判据词的权重：动作 id 与意图词最硬，数据域最软。 */
export const ROUTE_WEIGHT = {
  name: 1.5,
  description: 1.2,
  grounding: 1.6,
  action: 2,
  domain: 0.6,
} as const

/** 单字判据词（`退`）只算半分——它太容易撞上。 */
export const SHORT_TERM_PENALTY = 0.4

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
 * 通用职责不参与路由竞争：`common.member` 的"管什么"是"个人任务"，
 * 任何一件活都能算进去，让它参赛等于没有路由。
 */
export const GENERIC_ROLES: readonly RoleId[] = ['common.member', 'common.owner']

/**
 * 结构类型：路由不 import 完整的 `RoleDefinitionFull`——判据只用得上这五样，
 * 把口子开小一点，调用方（秘书、岗位页、模拟层）递什么都行。
 */
export interface RouteRoleLike {
  id: string
  name?: { zh?: string; en?: string } | undefined
  description?: string | undefined
  grounding?: readonly { intent_terms?: readonly string[]; cue_terms?: readonly string[] }[]
  actions?: readonly { id: string }[]
  scopes?: readonly { domain: string }[]
}

export interface RouteTerm {
  text: string
  /** 从哪来的（解释用："因为你说了『退款』，那是售后的 stage_refund"） */
  from: 'name' | 'description' | 'grounding' | 'action' | 'domain'
  weight: number
}

/** 参赛的一条职责：判据词 + 它现在有哪几条分配（谁在做）。 */
export interface RouteRoleProfile {
  role_id: RoleId
  role_name: string
  terms: RouteTerm[]
  positions: { position_id: string; person_id: PersonId }[]
}

export interface RouteRoleScore {
  role_id: RoleId
  role_name: string
  score: number
  matched: string[]
}

/* ── 文本判断（刻意简单、确定、可解释：没有模型也要能跑）────────────────── */

/** 归一：小写、去掉空白与常见标点之间的差异。中文不分词——按整词包含判。 */
export function normalizeRouteText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\s　]+/g, '')
    .replace(/[，,、；;：:]/g, '、')
}

/** 把一句描述切成短语（职责的 `description` 就是用顿号连起来的一串"管什么"）。 */
export function splitRoutePhrases(text: string): string[] {
  return text
    .split(/[、，,;；。/|]|\s+|与|和|及/g)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

/** 判据词命中：长度 ≥ 2 的按整词包含；单字词（`退`）只在显式声明时用，权重由调用方压低。 */
export function containsRouteTerm(normalizedText: string, term: string): boolean {
  const t = normalizeRouteText(term)
  return t.length > 0 && normalizedText.includes(t)
}

/* ── 判据抽取与打分 ──────────────────────────────────────────────────── */

/** 从一份职责定义里抽出全部判据词（去重，保留来源与权重）。 */
export function roleRouteTerms(role: RouteRoleLike): RouteTerm[] {
  const out = new Map<string, RouteTerm>()
  const add = (text: string, from: RouteTerm['from']): void => {
    const t = text.trim()
    if (t === '') return
    const weight = ROUTE_WEIGHT[from] * ([...t].length <= 1 ? SHORT_TERM_PENALTY : 1)
    const key = normalizeRouteText(t)
    if (key === '') return
    const prev = out.get(key)
    if (prev === undefined || prev.weight < weight) out.set(key, { text: t, from, weight })
  }
  if (role.name?.zh !== undefined) add(role.name.zh, 'name')
  if (role.name?.en !== undefined) add(role.name.en, 'name')
  for (const phrase of splitRoutePhrases(role.description ?? '')) add(phrase, 'description')
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

/** 给每个职责打分：命中的判据词权重之和，按该职责判据词总量做一次弱归一。 */
export function scoreRouteRoles(
  text: string,
  roles: readonly RouteRoleProfile[],
): RouteRoleScore[] {
  const n = normalizeRouteText(text)
  const scored = roles
    .filter((r) => !GENERIC_ROLES.includes(r.role_id))
    .map((role) => {
      let score = 0
      const matched: string[] = []
      for (const term of role.terms) {
        if (!containsRouteTerm(n, term.text)) continue
        score += term.weight
        matched.push(term.text)
      }
      return {
        role_id: role.role_id,
        role_name: role.role_name,
        score,
        matched,
        held: role.positions.length > 0,
      }
    })
    .filter((s) => s.score > 0)
  // 分数相同时**先看有没有人在做**（WP54）：客服拆成三条职责之后，一句"退款、投诉、
  // 包裹"对网站客服与 Amazon 客服打一样的分，而工作区里可能只有一个人做网站客服。
  // 判给一条没人持有的职责，出来的是一张没人能认领的卡——那比判错更糟。
  // 再相同才按 id 字典序，保证同一句话在两台机器上路由到同一条。
  scored.sort(
    (a, b) =>
      b.score - a.score || Number(b.held) - Number(a.held) || (a.role_id < b.role_id ? -1 : 1),
  )
  return scored.map(({ held: _held, ...rest }) => rest)
}

/* ── 54 §2 岗位内路由 ────────────────────────────────────────────────── */

/**
 * 拿不准的两条线（54 §2「拿不准就问一句，不猜」）。
 *
 * 分数是**归一之后**的份额（这一条的分 ÷ 参赛各条分之和），所以两条阈值都读得懂：
 *
 * - `MIN_SEPARATION`：第一名与第二名的份额差。0.15 大概是"六四开还算分得开、
 *   五五开就别猜了"——`0.575 : 0.425` 正好卡在线上。
 * - `MIN_PICKED_SCORE`：第一名自己的份额。四条职责平分（各 0.25）时谁也不像，
 *   0.3 把这种"哪条都沾一点"的情形挡在外面。
 *
 * 岗位里只有一条职责时两条都不看——没得选就是它（见 {@link routeWithinPosition}）。
 */
export const MIN_SEPARATION = 0.15
export const MIN_PICKED_SCORE = 0.3

export interface RouteCandidate {
  role_id: RoleId
  role_name: string
  /** 归一后的份额 0..1（两位小数） */
  score: number
  /** 为什么是它：命中的判据词（最多 3 个，界面上直接显示） */
  why: string[]
}

export interface RouteWithinPositionResult {
  /** 判得准才有；拿不准时没有它——由调用方出一张选择卡 */
  picked?: RoleId
  candidates: RouteCandidate[]
  /** 拿不准（前两名太接近，或者谁都不太像） */
  ambiguous: boolean
  /** 一句人话，直接进事项时间线 */
  reason: string
}

/**
 * **岗位内路由**：一句话 + 这个岗位展开的那几条职责 → 该走哪一条。
 *
 * 它不是权限并集（05 §4）：出来的只是"这件事像哪条职责的活"，真正跑的时候仍然
 * 只在那一条职责的 Assignment 下跑，额度与动作面都是那一条的。
 *
 * 三种结局：
 * 1. 岗位里只有一条职责 → 直接是它（`picked`，`ambiguous: false`）；
 * 2. 判得准 → `picked`；
 * 3. 拿不准 → 没有 `picked`、`ambiguous: true`，候选按分排好递出去，调用方出选择卡。
 *
 * 一个判据词都没命中也算拿不准（`candidates` 是空的）——空手猜一条比问一句糟。
 *
 * WP117b（66 复测 #17）：`options.duty_count` 是**这个岗位模板上有几条职责**
 * （WP125 滤掉 `common.member` 之后的那个数，与岗位页标题上写的是同一个）。
 * 给了它，"只有一条"那句话才说得准——`roles` 递进来的是**本人持有**的那几条，
 * 岗位有 5 条而本人只持有 1 条时，原来那句「这个岗位下只有一条职责」与岗位页上的
 * 「5 条职责」当场打架。不给就退回原来的说法（老调用方一个字不用改）。
 */
export function routeWithinPosition(
  text: string,
  roles: readonly RouteRoleProfile[],
  options: { duty_count?: number } = {},
): RouteWithinPositionResult {
  const eligible = roles.filter((r) => !GENERIC_ROLES.includes(r.role_id))
  // 岗位里只有一条职责：没得选就是它，两条阈值都不看
  const only = eligible[0]
  if (eligible.length === 1 && only !== undefined) {
    const duties = options.duty_count
    return {
      picked: only.role_id,
      candidates: [
        { role_id: only.role_id, role_name: only.role_name, score: 1, why: ['唯一职责'] },
      ],
      ambiguous: false,
      reason:
        duties === undefined || duties <= 1
          ? `这个岗位下只有「${only.role_name}」一条职责，直接交给它`
          : `这个岗位有 ${duties} 条职责，你名下只有「${only.role_name}」这一条，直接交给它`,
    }
  }

  const scores = scoreRouteRoles(text, eligible)
  const total = scores.reduce((n, s) => n + s.score, 0)
  const candidates: RouteCandidate[] = scores.map((s) => ({
    role_id: s.role_id,
    role_name: s.role_name,
    score: total === 0 ? 0 : Math.round((s.score / total) * 100) / 100,
    why: s.matched.slice(0, 3),
  }))

  const first = candidates[0]
  if (first === undefined) {
    return {
      candidates,
      ambiguous: true,
      reason: '看不出这件事像这个岗位下的哪条职责，先问一句',
    }
  }
  const second = candidates[1]?.score ?? 0
  const separation = first.score - second
  const why = first.why.map((m) => `「${m}」`).join('、')
  if (first.score < MIN_PICKED_SCORE || separation < MIN_SEPARATION) {
    const alt = candidates[1]
    return {
      candidates,
      ambiguous: true,
      reason:
        alt === undefined
          ? `像是「${first.role_name}」的活${why === '' ? '' : `（${why}）`}，但不够有把握，先问一句`
          : `这件事像「${first.role_name}」也像「${alt.role_name}」，你定`,
    }
  }
  return {
    picked: first.role_id,
    candidates,
    ambiguous: false,
    reason: `路由到「${first.role_name}」${why === '' ? '' : `，因为你说了${why}`}`,
  }
}
