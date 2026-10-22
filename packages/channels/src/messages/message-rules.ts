/**
 * WP441（docs/108 §5.1）：**消息规则**的纯函数——判一封信命不命中、多条命中怎么合、命中之后分拣结论怎么改、
 * 试跑、一句话转规则（没有模型时的确定性兜底）、stub 剧本。
 *
 * 思路借自 Inbox Zero 的产品说明（一句话写规则、先写死后 AI、试跑），**未参考其源码**。
 *
 * 几条纪律：
 * - **先写死、后 AI**：写死条件命中就不再为它问模型；AI 条件塞进分拣第 ④ 层那**一次**调用里顺带判
 *   （宿主把 {@link aiRulePrompts} 递给模型），不为规则多调一次模型。
 * - **去向只认排最前的那一条**（清单顺序 = 优先级）；其余动作全做，标签取并集，同一处只记一次
 *   （{@link resolveRuleActions}）。
 * - **AI 条件要过把握线**：去向、记录、告诉我、起草要 ≥ 0.6；打标签、进简报 ≥ 0.5。
 * - **动作全集里没有往外发的**（`MESSAGE_RULE_ACTION_TYPES`）：{@link sanitizeRuleDraft} 把不认得的动作一律丢掉。
 *
 * 这个文件不碰库、不调模型。
 */
import type {
  Iso8601,
  MessageKind,
  MessagePositionOption,
  MessageRecord,
  MessageRoute,
  MessageRule,
  MessageRuleAction,
  MessageRuleCondition,
  MessageRuleDraft,
  MessageRuleHit,
  MessageRuleHitRow,
  MessageRuleScope,
  MessageRuleTrial,
  MessageRuleTrialChange,
  MessageRuleWhen,
  MessageSource,
  MessageTriage,
} from '@agentsws/contracts'
import {
  MESSAGE_KINDS,
  MESSAGE_RULE_ACTION_TYPES,
  MESSAGE_RULE_AI_FLOOR,
  MESSAGE_RULE_AI_SOFT_FLOOR,
  MESSAGE_RULE_TRIAL_AI_LIMIT,
  MESSAGE_RULE_TRIAL_DAYS,
} from '@agentsws/contracts'
import { isMessageKind, POSITION_OF_ROUTE, routeOfPosition } from './kind.js'

/* ── 一封信在规则眼里的样子 ─────────────────────────────────────────── */

/** 判规则要看的那几样（分拣入参的子集 + 类型）。 */
export interface RuleMail {
  from_email: string
  from_name?: string | undefined
  subject: string
  text: string
  /** 收信邮箱。 */
  account?: string | undefined
  source?: MessageSource | undefined
  has_attachments: boolean
  /** 分拣判出来的类型；还没判出来时不给（类型条件就先不比）。 */
  kind?: MessageKind | undefined
}

const lower = (s: string): string => s.trim().toLowerCase()

/** `a@b.com` / `@b.com` / `b.com`（当成整个域）→ 统一写法。 */
export function normalizeSenderPattern(raw: string): string {
  const s = lower(raw)
  if (s === '') return s
  if (s.includes('@')) return s.startsWith('@') ? s : s
  return `@${s}`
}

/** 发件人对不对得上：整地址相等，或 `@域` 与地址的域相等（子域也算：`@shopify.com` 认 `mail.shopify.com`）。 */
export function senderMatches(pattern: string, email: string): boolean {
  const p = normalizeSenderPattern(pattern)
  const addr = lower(email)
  if (p === '' || addr === '') return false
  if (!p.startsWith('@')) return p === addr
  const at = addr.lastIndexOf('@')
  if (at < 0) return false
  const domain = addr.slice(at + 1)
  const want = p.slice(1)
  return domain === want || domain.endsWith(`.${want}`)
}

/** 一个写死条件的真假；`undefined` = 现在判不了（类型还没判出来 / AI 条件）。 */
function staticTruth(cond: MessageRuleCondition, mail: RuleMail): boolean | undefined {
  switch (cond.type) {
    case 'from':
      return senderMatches(cond.value, mail.from_email)
    case 'to_account':
      return mail.account !== undefined && lower(mail.account) === lower(cond.value)
    case 'subject_has':
      return lower(cond.value) !== '' && lower(mail.subject).includes(lower(cond.value))
    case 'body_has':
      return lower(cond.value) !== '' && lower(mail.text).includes(lower(cond.value))
    case 'kind':
      return mail.kind === undefined ? undefined : mail.kind === cond.value
    case 'source':
      return (mail.source ?? 'email') === cond.value
    case 'has_attachment':
      return mail.has_attachments === cond.value
    case 'ai':
      return undefined
  }
}

/** 这条规则有没有 AI 条件。 */
export function hasAiCondition(rule: Pick<MessageRule, 'when'>): boolean {
  return rule.when.conditions.some((c) => c.type === 'ai')
}

/** 这条规则管不管这封信（范围、排除名单）。 */
export function ruleInScope(
  rule: Pick<MessageRule, 'scope' | 'when'>,
  mail: Pick<RuleMail, 'account' | 'from_email'>,
): boolean {
  if ((rule.when.except ?? []).some((p) => senderMatches(p, mail.from_email))) return false
  const scope = rule.scope
  if (scope.kind === 'brand' || scope.account === undefined) return true
  return mail.account !== undefined && lower(mail.account) === lower(scope.account)
}

/**
 * 判一条规则：命中了吗、怎么命中的。
 *
 * - `ai`：这条规则的 AI 条件模型给的把握（没问过就不给）。AI 条件过 {@link MESSAGE_RULE_AI_SOFT_FLOOR} 才算真；
 *   去向等动作还要过 {@link MESSAGE_RULE_AI_FLOOR}（在 {@link resolveRuleActions} 里判）。
 * - 「都满足」里有判不了的条件（类型没判出来、AI 没问过）→ 不算命中；「满足一个」里判不了的那几个当没有。
 * - 一个条件都没有的规则不命中任何信（防止一条空规则吞掉整只邮箱）。
 */
export function evaluateRule(
  rule: Pick<MessageRule, 'scope' | 'when'>,
  mail: RuleMail,
  ai?: number | undefined,
): { hit: false } | { hit: true; by: 'static' | 'ai'; confidence?: number } {
  const conds = rule.when.conditions
  if (conds.length === 0 || !ruleInScope(rule, mail)) return { hit: false }
  const aiTrue = ai !== undefined && ai >= MESSAGE_RULE_AI_SOFT_FLOOR
  let usedAi = false
  if (rule.when.match === 'all') {
    for (const c of conds) {
      if (c.type === 'ai') {
        if (!aiTrue) return { hit: false }
        usedAi = true
        continue
      }
      if (staticTruth(c, mail) !== true) return { hit: false }
    }
  } else {
    const staticHit = conds.some((c) => c.type !== 'ai' && staticTruth(c, mail) === true)
    if (!staticHit) {
      if (!aiTrue || !conds.some((c) => c.type === 'ai')) return { hit: false }
      usedAi = true
    }
  }
  return usedAi
    ? { hit: true, by: 'ai', ...(ai === undefined ? {} : { confidence: ai }) }
    : { hit: true, by: 'static' }
}

/**
 * 这条规则要不要请模型顺带判一下：有 AI 条件、写死的部分没把它排除掉（类型还没判出来的当「可能」）、
 * 「满足一个」时写死条件里还没有一个已经为真（那就不用问了）。
 */
export function needsAi(rule: Pick<MessageRule, 'scope' | 'when'>, mail: RuleMail): boolean {
  if (!hasAiCondition(rule) || !ruleInScope(rule, mail)) return false
  const statics = rule.when.conditions.filter((c) => c.type !== 'ai')
  if (rule.when.match === 'all') return statics.every((c) => staticTruth(c, mail) !== false)
  return !statics.some((c) => staticTruth(c, mail) === true)
}

/** 递给模型的那一行：编号 + 一句描述（只有 AI 条件那几句；写死的部分不用它判）。 */
export function aiRulePrompts(
  rules: readonly Pick<MessageRule, 'id' | 'when'>[],
): { id: string; text: string }[] {
  return rules.map((r) => ({
    id: r.id,
    text: r.when.conditions
      .filter((c): c is Extract<MessageRuleCondition, { type: 'ai' }> => c.type === 'ai')
      .map((c) => c.value)
      .join('；'),
  }))
}

/** 这条规则现在能不能管这封信：开着、不是系统规则、信是规则建好之后来的。 */
export function ruleApplies(
  rule: Pick<MessageRule, 'enabled' | 'system' | 'created_at'>,
  mailDate?: Iso8601,
): boolean {
  if (!rule.enabled || rule.system !== undefined) return false
  if (mailDate === undefined) return true
  const d = Date.parse(mailDate)
  const c = Date.parse(rule.created_at)
  // 「生效只管以后进来的」：信上的日期早于建规则那一刻（留 5 分钟的钟差）的不管
  return !Number.isFinite(d) || !Number.isFinite(c) || d >= c - 5 * 60_000
}

/** 按清单顺序排（小的在前；同号按建的先后）。 */
export function sortRules<T extends Pick<MessageRule, 'order' | 'created_at'>>(
  rules: readonly T[],
): T[] {
  return [...rules].sort((a, b) => a.order - b.order || a.created_at.localeCompare(b.created_at))
}

/* ── 多条命中怎么合 ──────────────────────────────────────────────────── */

/** 一次命中：哪条规则、怎么命中的。 */
export interface RuleMatch {
  rule: Pick<MessageRule, 'id' | 'name' | 'actions' | 'by' | 'order' | 'created_at'>
  by: 'static' | 'ai'
  confidence?: number | undefined
}

/** 命中之后要做的事（合好之后的）。 */
export interface ResolvedRuleActions {
  /** 去向（只认排最前、带去向动作、过了把握线的那一条）。 */
  destination?: {
    rule_id: string
    name: string
    action: Extract<MessageRuleAction, { type: 'hand_to' } | { type: 'notice' }>
  }
  /** 标签（并集）。 */
  labels: string[]
  /** 记到哪（同一处只记一次）。 */
  records: { rule_id: string; sink_id?: string; sink_name?: string }[]
  /** 告诉谁（同一个人只告诉一次）。 */
  notifies: { rule_id: string; name: string; person_id: string }[]
  /** 进简报（命中的规则）。 */
  digest: { rule_id: string; name: string }[]
  /** 起草回复（一封信只起一张，认排最前的那一条）。 */
  draft?: { rule_id: string; name: string; instruction?: string }
  /** 命中记录（按清单顺序）。 */
  hits: MessageRuleHit[]
}

/** 这一动作这次命中够不够格（写死命中一律够；AI 命中按动作分两条线）。 */
function passes(m: RuleMatch, action: MessageRuleAction['type']): boolean {
  if (m.by === 'static') return true
  const c = m.confidence ?? 0
  return action === 'label' || action === 'digest'
    ? c >= MESSAGE_RULE_AI_SOFT_FLOOR
    : c >= MESSAGE_RULE_AI_FLOOR
}

/**
 * 多条命中合成一份要做的事（docs/108 §5.1.4）：去向只认第一条；其余动作全做，标签取并集，
 * 同一处只记一次、同一个人只告诉一次，起草只起一张。`allowDestination = false`（发件人规则已经定了去向）时不给去向。
 */
export function resolveRuleActions(
  matches: readonly RuleMatch[],
  allowDestination = true,
): ResolvedRuleActions {
  const ordered = [...matches].sort(
    (a, b) => a.rule.order - b.rule.order || a.rule.created_at.localeCompare(b.rule.created_at),
  )
  const out: ResolvedRuleActions = { labels: [], records: [], notifies: [], digest: [], hits: [] }
  const sinks = new Set<string>()
  const people = new Set<string>()
  for (const m of ordered) {
    out.hits.push({
      rule_id: m.rule.id,
      by: m.by,
      ...(m.confidence === undefined ? {} : { confidence: m.confidence }),
      name: m.rule.name,
    })
    for (const a of m.rule.actions) {
      if (!passes(m, a.type)) continue
      switch (a.type) {
        case 'hand_to':
        case 'notice':
          if (allowDestination && out.destination === undefined)
            out.destination = { rule_id: m.rule.id, name: m.rule.name, action: a }
          break
        case 'label':
          if (a.label.trim() !== '' && !out.labels.includes(a.label)) out.labels.push(a.label)
          break
        case 'record': {
          const key = a.sink_id ?? `name:${lower(a.sink_name ?? '')}`
          if (sinks.has(key)) break
          sinks.add(key)
          out.records.push({
            rule_id: m.rule.id,
            ...(a.sink_id === undefined ? {} : { sink_id: a.sink_id }),
            ...(a.sink_name === undefined ? {} : { sink_name: a.sink_name }),
          })
          break
        }
        case 'notify': {
          const who = a.person_id ?? m.rule.by
          if (people.has(who)) break
          people.add(who)
          out.notifies.push({ rule_id: m.rule.id, name: m.rule.name, person_id: who })
          break
        }
        case 'digest':
          if (!out.digest.some((d) => d.rule_id === m.rule.id))
            out.digest.push({ rule_id: m.rule.id, name: m.rule.name })
          break
        case 'draft':
          if (out.draft === undefined)
            out.draft = {
              rule_id: m.rule.id,
              name: m.rule.name,
              ...(a.instruction === undefined ? {} : { instruction: a.instruction }),
            }
          break
      }
    }
  }
  return out
}

/** 岗位开没开（分拣只认得那三条路；别的岗位由宿主交的时候再判）。 */
export interface RuleRouteContext {
  support_enabled: boolean
  kol_enabled: boolean
  b2b_enabled?: boolean | undefined
}

function routeOpen(route: 'support' | 'kol' | 'b2b', ctx: RuleRouteContext): boolean {
  if (route === 'support') return ctx.support_enabled
  if (route === 'kol') return ctx.kol_enabled
  return ctx.b2b_enabled === true
}

/**
 * 把合好的动作落到分拣结论上（纯函数）：标签并集；去向「只是通知」= 不用回、不挪信；去向「交给 X」=
 * 63 那三条路的岗位改路由（岗位没开就**不挪信**，退回没人接的、说一句），别的岗位挂主按钮、由宿主交。
 */
export function applyRuleActions(
  verdict: MessageTriage,
  resolved: ResolvedRuleActions,
  ctx: RuleRouteContext,
): MessageTriage {
  if (resolved.hits.length === 0) return verdict
  const labels = [...new Set([...verdict.labels, ...resolved.labels])]
  const reasons = [...verdict.reasons]
  const lead = resolved.destination ?? resolved.hits[0]
  const leadName =
    resolved.destination?.name ?? resolved.hits.find((h) => h.rule_id === lead?.rule_id)?.name
  const others = resolved.hits.length - 1
  reasons.push(
    `消息规则：${leadName ?? ''}${others > 0 ? `（另有 ${others} 条也命中）` : ''}`.trim(),
  )
  let next: MessageTriage = { ...verdict, labels, reasons, rule_hits: resolved.hits }
  const dest = resolved.destination
  if (dest === undefined) return next
  next = { ...next, rule_route: dest.rule_id }
  if (dest.action.type === 'notice') {
    const { suggested_route: _r, suggested_position: _p, ...rest } = next
    return {
      ...rest,
      route: 'inbox',
      needs_reply: false,
      confidence: Math.max(next.confidence, 0.9),
    }
  }
  const position_id = dest.action.position_id
  const route = routeOfPosition(position_id)
  if (route === undefined) {
    // 63 那三条路之外的岗位：留在收件箱、主按钮就是它；宿主交的时候再看岗位开没开（没开就留在没人接的）
    const { suggested_route: _r, ...rest } = next
    return { ...rest, route: 'inbox', needs_reply: true, suggested_position: position_id }
  }
  if (!routeOpen(route, ctx)) {
    const { suggested_route: _r, ...rest } = next
    return {
      ...rest,
      route: 'inbox',
      needs_reply: true,
      suggested_position: position_id,
      reasons: [...next.reasons, `规则要交给的岗位没开，信不挪、留在没人接的`],
    }
  }
  const { suggested_route: _r, ...rest } = next
  return {
    ...rest,
    route: route as MessageRoute,
    needs_reply: true,
    suggested_position: position_id,
    confidence: Math.max(next.confidence, 0.9),
  }
}

/* ── 命中账（与发件人规则同一本账的口径） ──────────────────────────── */

const DAY_MS = 86_400_000
const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10)

/** 记一次命中（按信的日期，早于 30 天的不记）。回一条新规则。 */
export function recordMessageRuleHit<T extends Pick<MessageRule, 'hit_days' | 'last_hit_at'>>(
  rule: T,
  at: Iso8601,
  now: Iso8601,
): T {
  const nowMs = Date.parse(now)
  const atMs = Math.min(Number.isFinite(Date.parse(at)) ? Date.parse(at) : nowMs, nowMs)
  if (nowMs - atMs >= MESSAGE_RULE_TRIAL_DAYS * DAY_MS) return rule
  const floor = dayOf(nowMs - (MESSAGE_RULE_TRIAL_DAYS - 1) * DAY_MS)
  const days: Record<string, number> = {}
  for (const [d, n] of Object.entries(rule.hit_days ?? {})) if (d >= floor && n > 0) days[d] = n
  const day = dayOf(atMs)
  days[day] = (days[day] ?? 0) + 1
  const last = rule.last_hit_at
  const lastAt = last === undefined || Date.parse(last) < atMs ? new Date(atMs).toISOString() : last
  return { ...rule, hit_days: days, last_hit_at: lastAt }
}

/** 最近 30 天命中几次。 */
export function messageRuleHits30d(rule: Pick<MessageRule, 'hit_days'>, now: Iso8601): number {
  const floor = dayOf(Date.parse(now) - (MESSAGE_RULE_TRIAL_DAYS - 1) * DAY_MS)
  return Object.entries(rule.hit_days ?? {})
    .filter(([d, n]) => d >= floor && n > 0)
    .reduce((a, [, n]) => a + n, 0)
}

/* ── 草案的校验（守卫：规则里不存在外发动作） ────────────────────────── */

/** 规则草案的上下文：这个品牌里有哪些岗位、标签、记录去处。 */
export interface RuleDraftContext {
  positions?: readonly Pick<MessagePositionOption, 'id' | 'name_zh' | 'name_en' | 'open'>[]
  labels?: readonly { id: string; name_zh: string; name_en?: string }[]
  sinks?: readonly { id: string; name: string }[]
}

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined

/** 一个条件过一遍（不认得的丢掉）。 */
function cleanCondition(raw: unknown): MessageRuleCondition | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const o = raw as Record<string, unknown>
  const type = o.type
  switch (type) {
    case 'from': {
      const v = str(o.value)
      return v === undefined ? undefined : { type, value: normalizeSenderPattern(v) }
    }
    case 'to_account':
    case 'subject_has':
    case 'body_has':
    case 'ai': {
      const v = str(o.value)
      return v === undefined ? undefined : { type, value: v.slice(0, 300) }
    }
    case 'kind':
      return isMessageKind(o.value) ? { type, value: o.value } : undefined
    case 'source':
      return o.value === 'email' || o.value === 'chat' ? { type, value: o.value } : undefined
    case 'has_attachment':
      return typeof o.value === 'boolean' ? { type, value: o.value } : undefined
    default:
      return undefined
  }
}

/**
 * 一个动作过一遍：**只认 `MESSAGE_RULE_ACTION_TYPES` 里的七种**（发送、转发、删除、标垃圾……一律丢掉），
 * 交给的岗位要是这个品牌里有的。
 */
export function cleanAction(
  raw: unknown,
  ctx: RuleDraftContext = {},
): MessageRuleAction | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const o = raw as Record<string, unknown>
  const type = o.type
  if (typeof type !== 'string' || !(MESSAGE_RULE_ACTION_TYPES as readonly string[]).includes(type))
    return undefined
  switch (type) {
    case 'hand_to': {
      const id = str(o.position_id)
      if (id === undefined) return undefined
      const known = ctx.positions === undefined || ctx.positions.some((p) => p.id === id)
      return known ? { type, position_id: id } : undefined
    }
    case 'notice':
    case 'digest':
      return { type }
    case 'label': {
      const label = str(o.label)
      return label === undefined ? undefined : { type, label: label.slice(0, 40) }
    }
    case 'record': {
      const sink_id = str(o.sink_id)
      const sink_name = str(o.sink_name)
      if (sink_id === undefined && sink_name === undefined) return { type }
      return {
        type,
        ...(sink_id === undefined ? {} : { sink_id }),
        ...(sink_name === undefined ? {} : { sink_name: sink_name.slice(0, 60) }),
      }
    }
    case 'notify': {
      const person_id = str(o.person_id)
      return person_id === undefined ? { type } : { type, person_id }
    }
    case 'draft': {
      const instruction = str(o.instruction)
      return instruction === undefined ? { type } : { type, instruction: instruction.slice(0, 200) }
    }
    default:
      return undefined
  }
}

/** 规则范围过一遍。 */
function cleanScope(raw: unknown): MessageRuleScope {
  if (typeof raw !== 'object' || raw === null) return { kind: 'brand' }
  const o = raw as Record<string, unknown>
  const account = str(o.account)
  if ((o.kind === 'account' || o.kind === 'personal') && account !== undefined)
    return { kind: o.kind, account }
  return { kind: 'brand' }
}

/** 「什么样的信」过一遍。 */
export function cleanWhen(raw: unknown): MessageRuleWhen {
  const o = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
  const conditions = (Array.isArray(o.conditions) ? o.conditions : [])
    .map(cleanCondition)
    .filter((c): c is MessageRuleCondition => c !== undefined)
    .slice(0, 12)
  const except = (Array.isArray(o.except) ? o.except : [])
    .map((e) => (typeof e === 'string' ? normalizeSenderPattern(e) : ''))
    .filter((e) => e !== '')
  return {
    match: o.match === 'any' ? 'any' : 'all',
    conditions,
    ...(except.length === 0 ? {} : { except: [...new Set(except)] }),
  }
}

/**
 * 草案（模型给的 / 表单给的）过一遍：条件、动作只留认得的；没有条件或没有动作 = 不成规则。
 * 记录去处按名字对上已有的那一个（对不上就只留名字）。
 */
export function sanitizeRuleDraft(
  raw: unknown,
  origin_text: string,
  ctx: RuleDraftContext = {},
): MessageRuleDraft | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const o = raw as Record<string, unknown>
  const when = cleanWhen(o.when ?? { match: o.match, conditions: o.conditions, except: o.except })
  const actions = (Array.isArray(o.actions) ? o.actions : [])
    .map((a) => cleanAction(a, ctx))
    .filter((a): a is MessageRuleAction => a !== undefined)
    .map((a) => (a.type === 'record' ? bindSink(a, ctx) : a))
  // 去向类动作只留一个（一条规则不能既「只是通知」又「交给客服」）
  const seenDest = { v: false }
  const dedup = actions.filter((a) => {
    if (a.type !== 'hand_to' && a.type !== 'notice') return true
    if (seenDest.v) return false
    seenDest.v = true
    return true
  })
  if (when.conditions.length === 0 || dedup.length === 0) return undefined
  const name = str(o.name)?.slice(0, 40) ?? defaultRuleName(when)
  return {
    name,
    scope: cleanScope(o.scope),
    when,
    actions: dedup,
    origin_text: origin_text.trim().slice(0, 1000),
  }
}

/** 记录去处：给了 id 就认 id；只给了名字（或什么都没给）就对上已有的那一个。 */
function bindSink(
  a: Extract<MessageRuleAction, { type: 'record' }>,
  ctx: RuleDraftContext,
): MessageRuleAction {
  const sinks = ctx.sinks ?? []
  if (a.sink_id !== undefined && sinks.some((s) => s.id === a.sink_id)) {
    const s = sinks.find((x) => x.id === a.sink_id)
    return { type: 'record', sink_id: a.sink_id, sink_name: s?.name ?? a.sink_name ?? '' }
  }
  const want = lower(a.sink_name ?? '')
  const byName =
    want === ''
      ? sinks.length === 1
        ? sinks[0]
        : undefined
      : (sinks.find((s) => lower(s.name) === want) ??
        sinks.find((s) => lower(s.name).includes(want) || want.includes(lower(s.name))))
  if (byName !== undefined) return { type: 'record', sink_id: byName.id, sink_name: byName.name }
  return a.sink_name === undefined ? { type: 'record' } : { type: 'record', sink_name: a.sink_name }
}

function defaultRuleName(when: MessageRuleWhen): string {
  const c = when.conditions[0]
  if (c === undefined) return '消息规则'
  if (c.type === 'from') return `${c.value} 的信`
  if (c.type === 'ai') return c.value.slice(0, 20)
  return `含「${String(c.value).slice(0, 12)}」的信`
}

/* ── 一行白话（卡上、清单里） ─────────────────────────────────────────── */

const KIND_ZH: Readonly<Record<MessageKind, string>> = {
  customer_question: '客户问题',
  after_sales: '售后',
  inquiry: '询盘',
  creator_reply: '红人回复',
  partnership: '合作',
  media: '媒体',
  billing_system: '账单与系统通知',
  logistics: '物流',
  marketing: '垃圾与营销',
  personal_other: '个人与其他',
}

function conditionZh(c: MessageRuleCondition): string {
  switch (c.type) {
    case 'from':
      return c.value.startsWith('@') ? `${c.value.slice(1)} 发来` : `${c.value} 发来`
    case 'to_account':
      return `发到 ${c.value}`
    case 'subject_has':
      return `主题含「${c.value}」`
    case 'body_has':
      return `正文含「${c.value}」`
    case 'kind':
      return `类型是「${KIND_ZH[c.value]}」`
    case 'source':
      return c.value === 'chat' ? '网站聊天来的' : '邮件来的'
    case 'has_attachment':
      return c.value ? '带附件' : '不带附件'
    case 'ai':
      return `像是「${c.value}」`
  }
}

/** 一个动作的白话。 */
export function actionZh(
  a: MessageRuleAction,
  ctx: RuleDraftContext & { personName?: (id: string) => string | undefined } = {},
): string {
  switch (a.type) {
    case 'hand_to': {
      const p = ctx.positions?.find((x) => x.id === a.position_id)
      return `交给${p?.name_zh ?? a.position_id}`
    }
    case 'notice':
      return '只是通知、不烦你'
    case 'label': {
      const l = ctx.labels?.find((x) => x.id === a.label)
      return `打标签「${l?.name_zh ?? a.label}」`
    }
    case 'record':
      return a.sink_name === undefined || a.sink_name === '' ? '记下来' : `记到「${a.sink_name}」`
    case 'notify': {
      const who = a.person_id === undefined ? undefined : ctx.personName?.(a.person_id)
      return who === undefined ? '告诉我一声' : `告诉${who}一声`
    }
    case 'digest':
      return '进今天的简报'
    case 'draft':
      return a.instruction === undefined
        ? '起草回复（等你批）'
        : `起草回复：${a.instruction}（等你批）`
  }
}

/** 一行白话：「shopify.com 发来、主题含「payout」 → 打标签「账单与发票」、记到「财务表」、只是通知、不烦你」。 */
export function describeRule(
  rule: Pick<MessageRule, 'when' | 'actions'>,
  ctx: RuleDraftContext & { personName?: (id: string) => string | undefined } = {},
): string {
  const join = rule.when.match === 'all' ? '、' : '，或'
  const cond = rule.when.conditions.map(conditionZh).join(join)
  const acts = rule.actions.map((a) => actionZh(a, ctx)).join('、')
  return `${cond} → ${acts}`
}

/* ── 试跑（不落库、不执行动作） ──────────────────────────────────────── */

/** 一封信现在归哪（试跑「会被改掉去向的」那一列的「原来」）。 */
export function currentDestination(m: MessageRecord): string {
  if (m.handled?.as === 'position' && m.handled.position_id !== undefined)
    return m.handled.position_id
  if (m.handled?.as === 'notice') return 'notice'
  if (m.handled?.as === 'me') return 'me'
  if (m.route === 'support' || m.route === 'kol' || m.route === 'b2b')
    return POSITION_OF_ROUTE[m.route]
  if (m.triage?.needs_reply === false) return 'notice'
  return 'unclaimed'
}

/** 一封来信在规则眼里的样子。 */
export function ruleMailOf(m: MessageRecord): RuleMail {
  return {
    from_email: m.from.email,
    ...(m.from.name === undefined ? {} : { from_name: m.from.name }),
    subject: m.subject,
    text: m.text,
    account: m.account,
    source: m.source,
    has_attachments: m.attachments.some((a) => a.inline !== true),
    ...(m.triage?.kind === undefined ? {} : { kind: m.triage.kind }),
  }
}

const isInboundRecord = (m: MessageRecord): boolean =>
  m.folder_kind !== 'sent' && m.folder_kind !== 'drafts' && m.folder_kind !== 'trash'

/** 试跑要看的那几封：最近 30 天的来信，新的在前。 */
export function trialPool(all: readonly MessageRecord[], now: Iso8601): MessageRecord[] {
  const floor = Date.parse(now) - MESSAGE_RULE_TRIAL_DAYS * DAY_MS
  return all
    .filter(isInboundRecord)
    .filter((m) => {
      const t = Date.parse(m.date)
      return !Number.isFinite(t) || t >= floor
    })
    .sort((a, b) => Date.parse(b.date) - Date.parse(a.date))
}

export function hitRowOf(m: MessageRecord): MessageRuleHitRow {
  return {
    message_id: m.id,
    thread_id: m.thread_id,
    subject: m.subject,
    from: m.from.name ?? m.from.email,
    at: m.date,
  }
}

/**
 * 试跑一条草案（docs/108 §5.1.2）。写死条件跑全部；有 AI 条件的，只拿写死部分没排除掉的最近
 * {@link MESSAGE_RULE_TRIAL_AI_LIMIT} 封去问（`ai` 由宿主给：一批信 → 每封的把握；不给 = 没接模型）。
 */
export async function trialRule(
  draft: Pick<MessageRule, 'when' | 'actions' | 'scope'>,
  all: readonly MessageRecord[],
  opts: {
    now: Iso8601
    ai?: (mails: readonly MessageRecord[]) => Promise<ReadonlyMap<string, number>>
  },
): Promise<MessageRuleTrial> {
  const pool = trialPool(all, opts.now)
  const rule = { scope: draft.scope, when: draft.when }
  const withAi = hasAiCondition(rule)
  const askable = withAi ? pool.filter((m) => needsAi(rule, ruleMailOf(m))) : []
  const asked = askable.slice(0, MESSAGE_RULE_TRIAL_AI_LIMIT)
  let scores: ReadonlyMap<string, number> = new Map()
  if (asked.length > 0 && opts.ai !== undefined) scores = await opts.ai(asked)
  const askedIds = new Set(asked.map((m) => m.id))
  const hits: MessageRecord[] = []
  const changed: MessageRuleTrialChange[] = []
  const resolvedDest = resolveRuleActions([
    {
      rule: { id: 'trial', name: '', actions: draft.actions, by: '', order: 0, created_at: '' },
      by: 'static',
    },
  ]).destination
  for (const m of pool) {
    const score = askedIds.has(m.id) ? scores.get(m.id) : undefined
    const r = evaluateRule(rule, ruleMailOf(m), score)
    if (!r.hit) continue
    hits.push(m)
    if (resolvedDest === undefined) continue
    // AI 命中没过 0.6 的不改去向（与真分拣同一条线）
    if (r.by === 'ai' && (r.confidence ?? 0) < MESSAGE_RULE_AI_FLOOR) continue
    const after = resolvedDest.action.type === 'notice' ? 'notice' : resolvedDest.action.position_id
    const before = currentDestination(m)
    if (before !== after) changed.push({ ...hitRowOf(m), before, after })
  }
  return {
    scanned: pool.length,
    matched: hits.length,
    sample: hits.slice(0, 5).map(hitRowOf),
    changed: changed.slice(0, 20),
    ...(withAi
      ? opts.ai === undefined
        ? { ai_checked: 0, ai_skipped: true }
        : { ai_checked: asked.length }
      : {}),
  }
}

/* ── 一句话 → 规则（没有模型时的确定性兜底，也是 stub 剧本） ──────────── */

/** 常见平台的发件域（只认这几家的名字；别的发件人要人说出地址或域名）。 */
const KNOWN_SENDERS: readonly [RegExp, string, string][] = [
  [/shopify/i, '@shopify.com', 'Shopify'],
  [/paypal/i, '@paypal.com', 'PayPal'],
  [/stripe/i, '@stripe.com', 'Stripe'],
  [/亚马逊|amazon/i, '@amazon.com', 'Amazon'],
  [/tiktok/i, '@tiktok.com', 'TikTok'],
  [/google|谷歌/i, '@google.com', 'Google'],
]

/** 话题词 → 主题关键词（写死条件优先：能写死就不用 AI）。 */
const TOPIC_TERMS: readonly [RegExp, string, string][] = [
  [/结算|打款|回款|payout/i, 'payout', '结算通知'],
  [/发票|invoice/i, 'invoice', '发票'],
  [/退款|refund/i, 'refund', '退款'],
  [/订单|order/i, 'order', '订单'],
]

/** 话 → 内置标签。 */
const LABEL_TERMS: readonly [RegExp, string][] = [
  [/结算|打款|账单|发票|付款|payout|invoice|billing/i, 'billing'],
  [/订单|物流|发货/i, 'orders'],
  [/合作|红人/i, 'partnership'],
  [/供应商|工厂/i, 'suppliers'],
  [/平台|政策/i, 'platform'],
  [/招聘/i, 'hiring'],
  [/法务|合规/i, 'legal'],
  [/安全|验证码/i, 'security'],
]

const EMAIL_OR_DOMAIN =
  /([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})|(@?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|co|cn|shop|store|de|uk|fr|jp|example))\b/i

/** 「推销的」「推广的」这类说法 → AI 条件的那一句。 */
const PITCH_TERMS = /推销|开发信|陌生.{0,4}(?:合作|推广)|cold|pitch|sales ?pitch/i

/**
 * 一句话转规则（确定性兜底）：认得出的发件人 / 主题词写成写死条件，认不出的那一段写成 AI 条件；
 * 动作按「打标签 / 记到 / 别烦我 / 告诉我 / 简报 / 交给 / 起草」认。认不出动作就不成规则（回 `undefined`）。
 */
export function parseRuleSentence(
  text: string,
  ctx: RuleDraftContext = {},
): MessageRuleDraft | undefined {
  const said = text.trim()
  if (said === '') return undefined
  const conditions: MessageRuleCondition[] = []
  const nameParts: string[] = []
  const addr = EMAIL_OR_DOMAIN.exec(said)
  if (addr !== null) {
    const v = (addr[1] ?? addr[2] ?? '').toLowerCase()
    conditions.push({ type: 'from', value: normalizeSenderPattern(v) })
    nameParts.push(v.replace(/^@/, ''))
  } else {
    for (const [re, domain, name] of KNOWN_SENDERS)
      if (re.test(said)) {
        conditions.push({ type: 'from', value: domain })
        nameParts.push(name)
        break
      }
  }
  for (const [re, term, name] of TOPIC_TERMS)
    if (re.test(said)) {
      conditions.push({ type: 'subject_has', value: term })
      nameParts.push(name)
      break
    }
  if (conditions.length === 0) {
    // 认不出写死条件：把「…的都 / …的信」前面那一段当 AI 条件
    const phrase =
      /^(?:把|凡是|所有|只要是)?(.{1,30}?)(?:的信|的邮件|的消息|的都|的一律|都|一律)/.exec(
        said,
      )?.[1] ?? said.slice(0, 30)
    const what = phrase.replace(/^(?:以后|今后|帮我|请)/, '').trim()
    if (what === '') return undefined
    const desc = PITCH_TERMS.test(what)
      ? '陌生人发来的推销 / 开发信（找你买服务、代运营、推广合作、工厂报价之类）'
      : `${what}的信`
    conditions.push({ type: 'ai', value: desc })
    nameParts.push(PITCH_TERMS.test(what) ? '推销' : what.slice(0, 16))
  }
  const actions: MessageRuleAction[] = []
  const positions = ctx.positions ?? []
  const handMatch = /交给\s*([^\s，,。、]{1,12})/.exec(said)
  if (handMatch !== null) {
    const want = handMatch[1] ?? ''
    const p =
      positions.find((x) => want.includes(x.name_zh) || x.name_zh.includes(want)) ??
      (/客服/.test(want)
        ? { id: 'customer-care' }
        : /红人/.test(want)
          ? { id: 'kol-marketing' }
          : /b2b|外贸|询盘/i.test(want)
            ? { id: 'b2b' }
            : undefined)
    if (p !== undefined) actions.push({ type: 'hand_to', position_id: p.id })
  }
  if (/别烦我|不用管|不用回|不用理|不用通知我|只是通知|收起来/.test(said) && actions.length === 0)
    actions.push({ type: 'notice' })
  if (/标签|打个标|打标/.test(said)) {
    const quoted = /标签\s*[「“"']([^」”"']{1,20})[」”"']/.exec(said)?.[1]
    const byName =
      quoted === undefined
        ? undefined
        : ctx.labels?.find((l) => l.name_zh === quoted || l.id === quoted)?.id
    const builtin = LABEL_TERMS.find(([re]) => re.test(quoted ?? said))?.[1]
    actions.push({ type: 'label', label: byName ?? builtin ?? quoted ?? 'billing' })
  }
  const rec = /(?:记到|记进|记在|记录到|写到|写进)/.exec(said)
  if (rec !== null) {
    // 去处名字：到下一个动作词 / 标点为止，「…表里」去掉「里」；只说了「表」就不算名字
    const rest = said.slice(rec.index + rec[0].length).trim()
    const raw = (
      /^(.{0,16}?)(?:里|别|不用|告诉|提醒|并|然后|再|[，,。、;；\s]|$)/.exec(rest)?.[1] ?? ''
    )
      .replace(/^(?:那张|这张|一张)/, '')
      .trim()
    const name = raw === '' || /^(?:表|表格|表上)$/.test(raw) ? undefined : raw
    actions.push(
      bindSink(name === undefined ? { type: 'record' } : { type: 'record', sink_name: name }, ctx),
    )
  }
  if (/告诉我|提醒我|通知我|叫我|跟我说/.test(said) && !/不用通知我/.test(said))
    actions.push({ type: 'notify' })
  if (/简报|汇总|每天.{0,4}(?:一次|看)/.test(said)) actions.push({ type: 'digest' })
  const draft = /起草|草拟|帮我回|回一封|婉拒/.exec(said)
  if (draft !== null)
    actions.push(
      /婉拒/.test(said) ? { type: 'draft', instruction: '客气地婉拒' } : { type: 'draft' },
    )
  if (actions.length === 0) return undefined
  return sanitizeRuleDraft(
    {
      name: nameParts.join(' ') || undefined,
      when: { match: 'all', conditions },
      actions,
    },
    said,
    ctx,
  )
}

/* ── stub 剧本 ───────────────────────────────────────────────────────── */

/** 宿主的「一句话转规则」提示词里带这一句，stub 剧本据此认出那一次调用。 */
export const RULE_PROPOSE_PROMPT_MARKER = '把用户说的一句话转成一条消息规则。'

/** 宿主的分拣提示词里带上规则时多这一句（stub 剧本据此认出「顺带判规则」）。 */
export const RULE_TRIAGE_PROMPT_MARKER = '另外判断这封信符不符合下面几条规则'

const PITCH_WORDS: readonly string[] = [
  'seo',
  'backlink',
  'guest post',
  'outreach',
  'we can help',
  'grow your',
  'boost your',
  'increase your sales',
  'agency',
  'manufacturer',
  'factory',
  'quotation',
  'cooperation',
  '推广',
  '代运营',
  '合作推广',
  '工厂',
  '报价',
  '外链',
]

function stubRuleScore(ruleText: string, hayText: string): number | undefined {
  const hay = hayText.toLowerCase()
  if (PITCH_TERMS.test(ruleText) || /推销/.test(ruleText))
    return PITCH_WORDS.some((w) => hay.includes(w)) ? 0.85 : undefined
  const tokens = ruleText
    .toLowerCase()
    .split(/[\s、，,。；;/（）()「」“”"'：:]+/)
    .map((t) => t.replace(/的信$|的$/, ''))
    .filter((t) => t.length >= 2)
  return tokens.some((t) => hay.includes(t)) ? 0.8 : undefined
}

/**
 * 没接真模型时：分拣那一次带了规则（提示词里有 {@link RULE_TRIAGE_PROMPT_MARKER}）就只回 `rule_hits`
 * （其余几格照旧由默认值兜，与不带规则时的 stub 结论一致）；「一句话转规则」那一次按
 * {@link parseRuleSentence} 回草案。别的调用一律 `undefined`。
 */
export function messageRuleStubScript(
  messages: readonly { role: string; content: unknown }[],
): string | undefined {
  const system = messages.find((m) => m.role === 'system')?.content
  if (typeof system !== 'string') return undefined
  const user = messages.find((m) => m.role === 'user')?.content
  let req: Record<string, unknown> = {}
  try {
    req = JSON.parse(typeof user === 'string' ? user : '{}') as Record<string, unknown>
  } catch {
    req = {}
  }
  if (system.includes(RULE_PROPOSE_PROMPT_MARKER)) {
    const draft = parseRuleSentence(String(req.text ?? ''), {
      ...(Array.isArray(req.positions)
        ? { positions: req.positions as NonNullable<RuleDraftContext['positions']> }
        : {}),
      ...(Array.isArray(req.labels)
        ? { labels: req.labels as NonNullable<RuleDraftContext['labels']> }
        : {}),
      ...(Array.isArray(req.sinks)
        ? { sinks: req.sinks as NonNullable<RuleDraftContext['sinks']> }
        : {}),
    })
    return JSON.stringify(draft ?? { error: '没听懂要做什么' })
  }
  if (!system.includes(RULE_TRIAGE_PROMPT_MARKER)) return undefined
  const rules = Array.isArray(req.rules) ? (req.rules as { id?: unknown; text?: unknown }[]) : []
  if (rules.length === 0) return undefined
  // 分拣那一次：信在 `mail` 里（主题 + 正文）；试跑那一次：一批信在 `mails` 里
  const one = (mail: Record<string, unknown>): { id: string; confidence: number }[] =>
    rules.flatMap((r) => {
      const id = typeof r.id === 'string' ? r.id : undefined
      const text = typeof r.text === 'string' ? r.text : ''
      if (id === undefined) return []
      const score = stubRuleScore(text, `${String(mail.subject ?? '')}\n${String(mail.body ?? '')}`)
      return score === undefined ? [] : [{ id, confidence: score }]
    })
  if (Array.isArray(req.mails)) {
    return JSON.stringify({
      results: (req.mails as Record<string, unknown>[]).map((m) => ({
        id: m.id,
        rule_hits: one(m),
      })),
    })
  }
  return JSON.stringify({ rule_hits: one(req) })
}

/** 模型回的 `rule_hits`（只认递过去的那几条、把握夹到 0–1）。 */
export function parseRuleHits(
  raw: unknown,
  asked: readonly string[],
): { id: string; confidence: number }[] {
  if (!Array.isArray(raw)) return []
  const out: { id: string; confidence: number }[] = []
  for (const h of raw) {
    if (typeof h === 'string' && asked.includes(h)) out.push({ id: h, confidence: 0.7 })
    if (typeof h !== 'object' || h === null) continue
    const o = h as Record<string, unknown>
    const id = typeof o.id === 'string' ? o.id : typeof o.rule_id === 'string' ? o.rule_id : ''
    if (!asked.includes(id) || out.some((x) => x.id === id)) continue
    const c = typeof o.confidence === 'number' ? o.confidence : 0.7
    out.push({ id, confidence: Math.max(0, Math.min(1, c)) })
  }
  return out
}

/** 类型的可选值（给一句话转规则的提示词）。 */
export const RULE_KIND_CHOICES: readonly MessageKind[] = MESSAGE_KINDS
