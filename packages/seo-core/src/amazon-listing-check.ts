/**
 * WP396（docs/106 §13，A1 ②）：**自家 Listing 体检**的判法——纯函数，服务端只接线。
 *
 * - 规则表是数据（`amazon-listing-rules.json`，每条带出处与核对日期）；用户改过的建议值 / 开关叠在上面
 *   （{@link resolveListingRules}）。这里只按 `check` 种类判，不写死阈值。
 * - 每处问题写清「哪条规则（带出处）/ 现在是什么 / 建议怎么改」；文案类给一版草稿（照页面原文改），
 *   图片类给「向设计岗下需求单」的标题与需求；要看图才能判的（主图白底、文字水印）只提示人看一眼。
 * - 违规宣称复用 `claim-rules.ts`（按站点的市场分组），出处用那条规则自己的。
 * - 数字照页面原样写；读不到的那一格不判、不估。
 */
import type {
  AmazonListingFacts,
  ContentClaimRule,
  Iso8601,
  ListingCheckupItem,
  ListingCheckupRun,
  ListingIssue,
  ListingRule,
  ListingRuleOverride,
  ListingRuleParam,
  ListingRuleSource,
  ListingSeverity,
} from '@agentsws/contracts'
import { LISTING_RULE_STALE_DAYS, LISTING_SEVERITY_ORDER } from '@agentsws/contracts'
import RULES_FILE from './amazon-listing-rules.json' with { type: 'json' }
import { builtinClaimRule } from './claim-rules.js'
import { claimRuleMatches, splitSentences } from './quality.js'

/** 自带的那一份规则（数据文件原样）。 */
export const BUILTIN_LISTING_RULES: readonly ListingRule[] = (
  RULES_FILE as unknown as { rules: ListingRule[] }
).rules

const BUILTIN = new Map(BUILTIN_LISTING_RULES.map((r) => [r.id, r]))

export function builtinListingRule(id: string): ListingRule | undefined {
  return BUILTIN.get(id)
}

const isParam = (v: unknown): v is ListingRuleParam =>
  typeof v === 'number' ||
  typeof v === 'string' ||
  typeof v === 'boolean' ||
  (Array.isArray(v) && v.every((x) => typeof x === 'string'))

/** 自带规则 + 用户改过的（只认自带规则里有的参数名、类型对得上的值）。 */
export function resolveListingRules(
  overrides: Readonly<Record<string, ListingRuleOverride>> = {},
): ListingRule[] {
  return BUILTIN_LISTING_RULES.map((base) => {
    const o = overrides[base.id]
    if (o === undefined) return base
    const params: Record<string, ListingRuleParam> = { ...base.params }
    for (const [k, v] of Object.entries(o.params ?? {})) {
      const was = base.params[k]
      if (was === undefined || !isParam(v)) continue
      if (
        Array.isArray(was) !== Array.isArray(v) ||
        (!Array.isArray(was) && typeof was !== typeof v)
      )
        continue
      params[k] = v
    }
    return {
      ...base,
      params,
      enabled: o.enabled ?? base.enabled,
      ...(o.checked_at !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(o.checked_at)
        ? { checked_at: o.checked_at }
        : {}),
    }
  })
}

/** 这条规则的核对日期是不是太久了（卡上标「这条规则可能过时」）。 */
export function isListingRuleStale(rule: Pick<ListingRule, 'checked_at'>, now: Iso8601): boolean {
  const at = Date.parse(`${rule.checked_at}T00:00:00Z`)
  const t = Date.parse(now)
  if (Number.isNaN(at) || Number.isNaN(t)) return true
  return t - at > LISTING_RULE_STALE_DAYS * 86_400_000
}

const num = (rule: ListingRule, key: string, fallback: number): number => {
  const v = rule.params[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}
const list = (rule: ListingRule, key: string): string[] => {
  const v = rule.params[key]
  return Array.isArray(v) ? v : []
}

const quote = (s: string, max = 80): string => `「${s.length > max ? `${s.slice(0, max)}…` : s}」`

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** 促销字眼按整词找（`best` 不命中 `bestow`；`#1` 这类带符号的按子串）。 */
function promoHits(text: string, words: readonly string[]): string[] {
  const out: string[] = []
  for (const w of words) {
    const re = /^[\w\s'-]+$/.test(w)
      ? new RegExp(`(?<![\\w])${escapeRe(w)}(?![\\w])`, 'i')
      : new RegExp(escapeRe(w), 'i')
    if (re.test(text)) out.push(w)
  }
  return out
}

const wordsOf = (text: string): string[] =>
  text
    .toLowerCase()
    .split(/[^\p{L}\p{N}#&'-]+/u)
    .map((w) => w.replace(/^'+|'+$/g, ''))
    .filter((w) => w !== '')

/** 同一个词（单复数算一个）出现了几次；豁免词不算。 */
function repeated(title: string, max: number, exempt: readonly string[]): [string, number][] {
  const skip = new Set(exempt.map((e) => e.toLowerCase()))
  const counts = new Map<string, number>()
  for (const w of wordsOf(title)) {
    if (skip.has(w) || /^\d+$/.test(w)) continue
    const stem = w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w
    counts.set(stem, (counts.get(stem) ?? 0) + 1)
  }
  return [...counts].filter(([, n]) => n > max)
}

const upperRatio = (text: string): number => {
  const letters = [...text].filter((c) => /\p{L}/u.test(c) && c.toLowerCase() !== c.toUpperCase())
  if (letters.length < 10) return 0
  return letters.filter((c) => c === c.toUpperCase()).length / letters.length
}

const titleCase = (text: string): string =>
  text.replace(/\p{L}[\p{L}'-]*/gu, (w) =>
    w.length <= 3 && /^[A-Z]+$/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase(),
  )

/** 在 `max` 字以内、按词断开。 */
function cut(text: string, max: number): string {
  if (text.length <= max) return text
  const head = text.slice(0, max)
  const at = Math.max(head.lastIndexOf(', '), head.lastIndexOf(' '))
  return (at > max * 0.6 ? head.slice(0, at) : head).replace(/[\s,;:–-]+$/u, '')
}

/** 标题草稿：去特殊符号 → 去促销字眼 → 多余的重复词 → 全大写改首字母大写 → 收到长度以内。 */
export function listingTitleDraft(title: string, rules: readonly ListingRule[]): string {
  const rule = (check: ListingRule['check']): ListingRule | undefined =>
    rules.find((r) => r.check === check && r.enabled)
  let t = title
  const special = rule('title_special_chars')
  if (special !== undefined) for (const c of list(special, 'chars')) t = t.split(c).join(' ')
  const promo = rule('title_promo_words')
  if (promo !== undefined)
    for (const w of promoHits(t, list(promo, 'words')))
      t = t.replace(
        /^[\w\s'-]+$/.test(w)
          ? new RegExp(`(?<![\\w])${escapeRe(w)}(?![\\w])`, 'gi')
          : new RegExp(escapeRe(w), 'gi'),
        ' ',
      )
  const rep = rule('title_repeat_words')
  if (rep !== undefined) {
    const max = num(rep, 'max_repeat', 2)
    const skip = new Set(list(rep, 'exempt').map((e) => e.toLowerCase()))
    const seen = new Map<string, number>()
    t = t.replace(/[\p{L}\p{N}#&'-]+/gu, (w) => {
      const lw = w.toLowerCase()
      if (skip.has(lw) || /^\d+$/.test(lw)) return w
      const stem = lw.length > 3 && lw.endsWith('s') && !lw.endsWith('ss') ? lw.slice(0, -1) : lw
      const n = (seen.get(stem) ?? 0) + 1
      seen.set(stem, n)
      return n > max ? '' : w
    })
  }
  const caps = rule('title_all_caps')
  if (caps !== undefined && upperRatio(t) > num(caps, 'max_upper_ratio', 0.7)) t = titleCase(t)
  t = t
    .replace(/\s+([,;:])/g, '$1')
    .replace(/([,;:])(?:\s*[,;:])+/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s,;:–-]+|[\s,;:–-]+$/gu, '')
  const len = rule('title_max_chars')
  return len === undefined ? t : cut(t, num(len, 'max_chars', 200))
}

/** 两个标题像不像（词集合的重合度）。 */
export function titleSimilarity(a: string, b: string): number {
  const x = new Set(wordsOf(a))
  const y = new Set(wordsOf(b))
  if (x.size === 0 || y.size === 0) return 0
  let both = 0
  for (const w of x) if (y.has(w)) both += 1
  return both / (x.size + y.size - both)
}

export interface ListingCheckInput {
  facts: AmazonListingFacts
  /** 这一次用的规则（{@link resolveListingRules} 出来的）。 */
  rules: readonly ListingRule[]
  /** 这个站点要用的违规宣称规则（按市场分组合成好的）。 */
  claimRules: readonly ContentClaimRule[]
  /** 自家店铺名（购物车是不是你；空 = 判不了，提示人说一声）。 */
  ownSellers: readonly string[]
  /** 同一站点的其它自家 ASIN（判变体是不是断了）。 */
  siblings?: readonly AmazonListingFacts[]
  now: Iso8601
}

export interface ListingCheckResult {
  issues: ListingIssue[]
  human_checks: string[]
}

/** 一页商品页按规则逐条判。 */
export function checkListing(input: ListingCheckInput): ListingCheckResult {
  const { facts: f, now } = input
  const issues: ListingIssue[] = []
  const human: string[] = []
  const shortTitle = f.title === undefined ? f.asin : cut(f.title, 40)
  let titleDraftGiven = false
  const add = (
    rule: ListingRule,
    nowText: string,
    extra: Partial<
      Pick<ListingIssue, 'draft' | 'design_request' | 'needs_human' | 'suggestion'>
    > & {
      source?: ListingRuleSource
    } = {},
  ): void => {
    const { source, ...rest } = extra
    issues.push({
      rule_id: rule.id,
      area: rule.area,
      severity: rule.severity,
      rule_name: rule.name.zh,
      source: source ?? rule.source,
      rule_checked_at: rule.checked_at,
      rule_stale: isListingRuleStale(rule, now),
      now: nowText,
      suggestion: rule.advice.zh,
      ...rest,
    })
  }
  const titleDraft = (): { draft?: string } => {
    if (titleDraftGiven || f.title === undefined) return {}
    titleDraftGiven = true
    const d = listingTitleDraft(f.title, input.rules)
    return d === f.title ? {} : { draft: d }
  }
  const design = (
    what: string,
    problem: string,
  ): { design_request: { title: string; need: string } } => ({
    design_request: {
      title: `Amazon ${what}：${shortTitle}（${f.asin}）`,
      need: `${f.marketplace} 站 ASIN ${f.asin}（${f.url}）要${what}。体检发现：${problem}。照 Amazon 图片要求做（主图纯白底、商品占画面 85% 以上、不加文字水印）。`,
    },
  })
  const nonEmpty = f.bullets.filter((b) => b.trim() !== '')
  const own = input.ownSellers.map((s) => s.trim().toLowerCase()).filter((s) => s !== '')

  for (const rule of input.rules) {
    if (!rule.enabled) continue
    switch (rule.check) {
      case 'in_stock':
        if (f.availability === 'out_of_stock')
          add(rule, `前台写着${quote(f.availability_text ?? '没货')}，买家现在买不了`)
        break
      case 'buybox_present':
        if (!f.buybox.present && f.availability !== 'out_of_stock')
          add(rule, '页面上没有「加入购物车」，买家只能点「查看所有购买选项」')
        break
      case 'buybox_own': {
        const seller = f.buybox.seller
        if (!f.buybox.present || seller === undefined) break
        if (own.length === 0) {
          human.push(
            `购物车现在是${quote(seller)}在卖；不知道你的店铺名，没法判断是不是你——告诉我店铺名就能判`,
          )
          break
        }
        const s = seller.toLowerCase()
        if (!own.some((o) => s.includes(o) || o.includes(s)))
          add(rule, `购物车现在是${quote(seller)}在卖，不是你的店铺`)
        break
      }
      case 'title_max_chars': {
        const max = num(rule, 'max_chars', 200)
        if (f.title !== undefined && f.title.length > max)
          add(rule, `标题 ${f.title.length} 个字符，建议不超过 ${max}`, titleDraft())
        break
      }
      case 'title_repeat_words': {
        if (f.title === undefined) break
        const hits = repeated(f.title, num(rule, 'max_repeat', 2), list(rule, 'exempt'))
        if (hits.length > 0)
          add(
            rule,
            `${hits.map(([w, n]) => `「${w}」出现 ${n} 次`).join('、')}，建议每个词最多 ${num(rule, 'max_repeat', 2)} 次`,
            titleDraft(),
          )
        break
      }
      case 'title_special_chars': {
        if (f.title === undefined) break
        const hits = list(rule, 'chars').filter((c) => f.title?.includes(c))
        if (hits.length > 0) add(rule, `标题里有 ${hits.join(' ')}`, titleDraft())
        break
      }
      case 'title_promo_words': {
        if (f.title === undefined) break
        const hits = promoHits(f.title, list(rule, 'words'))
        if (hits.length > 0)
          add(rule, `标题里有${hits.map((h) => quote(h)).join('')}`, titleDraft())
        break
      }
      case 'title_all_caps':
        if (f.title !== undefined && upperRatio(f.title) > num(rule, 'max_upper_ratio', 0.7))
          add(rule, `标题几乎全是大写：${quote(f.title, 60)}`, titleDraft())
        break
      case 'bullets_min_count': {
        const min = num(rule, 'min', 3)
        if (nonEmpty.length < min)
          add(rule, `五点只有 ${nonEmpty.length} 条有字，建议至少 ${min} 条`)
        break
      }
      case 'bullets_empty': {
        const empty = f.bullets.length - nonEmpty.length
        if (empty > 0) add(rule, `有 ${empty} 条五点是空的`)
        break
      }
      case 'bullets_length': {
        const min = num(rule, 'min_chars', 10)
        const max = num(rule, 'max_chars', 255)
        nonEmpty.forEach((b, i) => {
          if (b.length > max)
            add(rule, `第 ${i + 1} 条五点 ${b.length} 个字符，建议不超过 ${max}`, {
              draft: cut(b, max),
            })
          else if (b.length < min)
            add(rule, `第 ${i + 1} 条五点只有 ${b.length} 个字符：${quote(b)}`)
        })
        break
      }
      case 'bullets_special_chars': {
        const chars = list(rule, 'chars')
        nonEmpty.forEach((b, i) => {
          const hits = chars.filter((c) => b.includes(c))
          const emoji = /\p{Extended_Pictographic}/u.test(b)
          if (hits.length === 0 && !emoji) return
          let draft = b
          for (const c of chars) draft = draft.split(c).join('')
          draft = draft
            .replace(/\p{Extended_Pictographic}️?/gu, '')
            .replace(/\s{2,}/g, ' ')
            .trim()
          add(rule, `第 ${i + 1} 条五点里有 ${hits.length > 0 ? hits.join(' ') : '表情符号'}`, {
            draft,
          })
        })
        break
      }
      case 'description_or_aplus':
        if (!f.has_description && !f.has_aplus) add(rule, '页面上既没有商品描述，也没有 A+')
        break
      case 'aplus_present':
        if (!f.has_aplus) add(rule, '没有 A+', design('A+', '没有 A+'))
        break
      case 'main_image_present':
        if (!f.has_main_image) add(rule, '页面上没读到主图', design('主图', '没有主图'))
        break
      case 'images_min_count': {
        const min = num(rule, 'min', 6)
        if (f.image_count !== undefined && f.image_count < min)
          add(
            rule,
            `一共 ${f.image_count} 张图，建议至少 ${min} 张`,
            design('副图', `现在只有 ${f.image_count} 张图`),
          )
        break
      }
      case 'video_present':
        if (!f.has_video) add(rule, '图片区没有视频', design('视频', '没有视频'))
        break
      case 'variants_broken': {
        const min = num(rule, 'min_title_similarity', 0.8)
        if (f.title === undefined) break
        for (const s of input.siblings ?? []) {
          if (s.asin === f.asin || s.marketplace !== f.marketplace || s.title === undefined)
            continue
          if (f.variants.child_asins.includes(s.asin) || s.variants.child_asins.includes(f.asin))
            continue
          if (titleSimilarity(f.title, s.title) < min) continue
          add(
            rule,
            `和你的另一款 ${s.asin}${quote(cut(s.title, 50))}几乎同名，却不在同一组变体里`,
            { needs_human: true },
          )
          break
        }
        break
      }
      case 'variants_unavailable':
        if (f.variants.present && f.variants.unavailable_count > 0)
          add(
            rule,
            `${f.variants.child_asins.length > 0 ? `${f.variants.child_asins.length} 个款式里` : ''}有 ${f.variants.unavailable_count} 个现在买不了`,
          )
        break
      case 'rating_min': {
        const min = num(rule, 'min', 4)
        if (f.rating !== undefined && f.rating < min)
          add(rule, `评分 ${f.rating}（建议 ${min} 以上）`)
        break
      }
      case 'reviews_min': {
        const min = num(rule, 'min', 10)
        if (f.reviews_count !== undefined && f.reviews_count < min)
          add(rule, `${f.reviews_count} 个评分（建议至少 ${min} 个）`)
        break
      }
      case 'claims': {
        const texts = [f.title ?? '', ...nonEmpty].filter((t) => t !== '')
        const seen = new Set<string>()
        for (const text of texts)
          for (const sentence of splitSentences(text))
            for (const c of input.claimRules) {
              if (seen.has(c.id) || !claimRuleMatches(c, sentence)) continue
              seen.add(c.id)
              const base = builtinClaimRule(c.id)
              add(rule, `${quote(sentence, 60)}——${c.reason}`, {
                ...(base === undefined
                  ? {}
                  : {
                      source: { kind: 'official', title: base.source_title, url: base.source_url },
                    }),
              })
            }
        break
      }
    }
  }
  if (f.has_main_image)
    human.push('主图是不是纯白底、有没有文字 / 水印、商品占不占画面 85% 以上——要看图，建议你看一眼')
  issues.sort(
    (a, b) =>
      LISTING_SEVERITY_ORDER.indexOf(a.severity) - LISTING_SEVERITY_ORDER.indexOf(b.severity),
  )
  return { issues, human_checks: human }
}

/** 一处问题的比对键（同一条规则、同一个「现在是什么」开头 = 同一处；判「修了几处」用）。 */
export function listingIssueKey(issue: Pick<ListingIssue, 'rule_id' | 'now'>): string {
  return `${issue.rule_id}|${issue.now.replace(/\d+/g, '#').slice(0, 24)}`
}

/** 和上一次比：上次几处、这次修好了几处、新冒出几处。 */
export function compareListingIssues(
  previous: readonly Pick<ListingIssue, 'rule_id' | 'now'>[],
  current: readonly Pick<ListingIssue, 'rule_id' | 'now'>[],
): { issues: number; fixed: number; added: number } {
  const before = new Set(previous.map(listingIssueKey))
  const after = new Set(current.map(listingIssueKey))
  let fixed = 0
  for (const k of before) if (!after.has(k)) fixed += 1
  let added = 0
  for (const k of after) if (!before.has(k)) added += 1
  return { issues: previous.length, fixed, added }
}

/** 一次体检的摘要（几个 ASIN、几处问题、最严重的一条）。 */
export function summarizeListingCheckup(
  items: readonly ListingCheckupItem[],
): ListingCheckupRun['summary'] {
  let worst: ListingCheckupRun['summary']['worst']
  let rank = Number.POSITIVE_INFINITY
  let issues = 0
  let blockers = 0
  for (const it of items) {
    issues += it.issues.length
    for (const i of it.issues) {
      if (i.severity === 'blocker') blockers += 1
      const r = LISTING_SEVERITY_ORDER.indexOf(i.severity as ListingSeverity)
      if (r < rank) {
        rank = r
        worst = { asin: it.asin, rule_name: i.rule_name, now: i.now, severity: i.severity }
      }
    }
  }
  return {
    asins: items.length,
    checked: items.filter((i) => i.status === 'checked').length,
    issues,
    blockers,
    ...(worst === undefined ? {} : { worst }),
  }
}
