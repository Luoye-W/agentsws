/**
 * WP249（决策 81）：「自家版待处理」的**判断**那一半——分类与建议（纯函数，不碰网络）。
 *
 * 两条通道（OAuth 接口 / 官方号浏览器）读回来的 {@link ModQueueEntry} 在这里归类、给建议：
 * 「批准 / 移除 / 不用管 + 一句理由（引用版规）」。
 *
 * 三条纪律：
 *
 * 1. **建议引用的是这个版自己的版规**（`/about/rules` 读回来的短名），不是我们编的规矩。
 *    版规里没有对应的那一条，就照实说「版规里没写这一条」，不硬套。
 * 2. **判不准就说判不准**。举报说违反「不跑题」，我们看不出来跑没跑题——那一条建议
 *    「先别动，你看一眼」（`ignore` + 理由写清），不替人猜。
 * 3. **正文是外部文本**（21 §1）：这里只拿它做词表匹配，原句不进日志、不当指令读。
 *    建议本身不是动作——真动手一律出卡（`community_moderation`）。
 */

import type { OwnSubQueueKind, OwnSubSuggestion } from '@agentsws/contracts'
import type { ModQueueEntry } from './channels/types.js'

/** 归类：modqueue 里带举报的 = 被举报；不带的 = 被自动过滤扣下；unmoderated = 新帖。 */
export function ownSubKindOf(entry: ModQueueEntry): OwnSubQueueKind {
  if (entry.source === 'unmoderated') return 'new_post'
  return entry.report_reasons.length > 0 ? 'reported' : 'held'
}

/** 广告 / 引流的信号词（宽收：漏一条广告比多看一眼代价大）。只可加行。 */
export const OWN_SUB_SPAM_TERMS: readonly string[] = [
  'dm me',
  'message me on',
  'whatsapp',
  'telegram',
  't.me/',
  'wa.me/',
  'discount code',
  'promo code',
  'coupon',
  'cheap',
  'wholesale',
  'replica',
  'free gift',
  'giveaway link',
  'click here',
  'bit.ly',
  'tinyurl',
  'onlyfans',
  'crypto',
  'airdrop',
  'earn money',
  '加我',
  '私聊',
  '代购',
  '低价',
  '批发',
]

/** 骂人 / 人身攻击的信号词。只可加行。 */
export const OWN_SUB_ABUSE_TERMS: readonly string[] = [
  'idiot',
  'stupid',
  'moron',
  'shut up',
  'kill yourself',
  'kys',
  'retard',
  'scammer',
  '傻逼',
  '滚',
]

/** 版规短名里认「广告 / 自我推广 / 垃圾」那一类的词。 */
const SPAM_RULE_WORDS = [
  'spam',
  'self-promo',
  'self promo',
  'promotion',
  'advertis',
  'no ads',
  'referral',
  '广告',
  '推广',
]
/** 版规短名里认「文明 / 不骂人」那一类的词。 */
const CIVIL_RULE_WORDS = [
  'civil',
  'respect',
  'harass',
  'rude',
  'personal attack',
  'abuse',
  'hate',
  'kind',
  '文明',
  '人身攻击',
]

const lower = (s: string): string => s.toLowerCase()
const hits = (text: string, terms: readonly string[]): string[] =>
  terms.filter((t) => text.includes(t))

/** 一段文字里的外链个数（reddit 自己的链接不算）。 */
function externalLinks(text: string): number {
  const all = text.match(/https?:\/\/[^\s)\]]+/giu) ?? []
  return all.filter((u) => !/^https?:\/\/([a-z0-9-]+\.)*(reddit\.com|redd\.it)\b/iu.test(u)).length
}

/** 版规里认得出的那一条（按类）。 */
function ruleOfClass(rules: readonly string[], words: readonly string[]): string | undefined {
  return rules.find((r) => words.some((w) => lower(r).includes(w)))
}

/** 举报原因里点名的那条版规（举报时多半就是原样选的版规短名）。 */
function ruleNamedIn(reasons: readonly string[], rules: readonly string[]): string | undefined {
  for (const reason of reasons) {
    const r = lower(reason)
    const found = rules.find((rule) => {
      const name = lower(rule)
      return name.length >= 3 && (r.includes(name) || name.includes(r))
    })
    if (found !== undefined) return found
  }
  return undefined
}

/**
 * 给一条待处理的东西出建议（三选一 + 一句理由）。
 *
 * `rules` 是这个版的版规短名（读不到就给空数组——建议照出，只是引不了版规）。
 */
export function suggestOwnSubAction(
  entry: ModQueueEntry,
  rules: readonly string[],
): OwnSubSuggestion {
  const kind = ownSubKindOf(entry)
  const text = lower(`${entry.title ?? ''}\n${entry.excerpt}`)
  const spam = hits(text, OWN_SUB_SPAM_TERMS)
  const links = externalLinks(`${entry.title ?? ''}\n${entry.excerpt}`)
  const abuse = hits(text, OWN_SUB_ABUSE_TERMS)
  const spamRule = ruleOfClass(rules, SPAM_RULE_WORDS)
  const civilRule = ruleOfClass(rules, CIVIL_RULE_WORDS)
  const named = ruleNamedIn(entry.report_reasons, rules)
  const isSpam = spam.length > 0 || (links >= 2 && entry.excerpt.length < 400)
  const cite = (rule: string | undefined): { rule?: string; quote: string } =>
    rule === undefined
      ? { quote: '（版规里没写这一条，按常识判）' }
      : { rule, quote: `违反版规「${rule}」` }

  if (isSpam) {
    const c = cite(named !== undefined && ruleOfClass([named], SPAM_RULE_WORDS) ? named : spamRule)
    const why =
      spam.length > 0 ? `出现「${spam.slice(0, 2).join('」「')}」` : `带了 ${links} 个外链`
    return {
      verdict: 'remove',
      reason: `像广告 / 引流：${why}，${c.quote}。`,
      ...(c.rule === undefined ? {} : { rule: c.rule }),
    }
  }
  if (abuse.length > 0) {
    const c = cite(
      named !== undefined && ruleOfClass([named], CIVIL_RULE_WORDS) ? named : civilRule,
    )
    return {
      verdict: 'remove',
      reason: `有骂人的话（「${abuse[0]}」），${c.quote}。`,
      ...(c.rule === undefined ? {} : { rule: c.rule }),
    }
  }
  if (kind === 'reported') {
    // 举报点名了一条我们判不了的版规（跑题、重复帖……）：不替人猜
    if (named !== undefined)
      return {
        verdict: 'ignore',
        reason: `举报说违反「${named}」，这一条我判不准（不是广告也没骂人），先别动，你看一眼原文再定。`,
        rule: named,
      }
    return {
      verdict: 'approve',
      reason: '举报原因在内容里找不到对应的东西（不是广告、没骂人）；批准可清掉举报、移出队列。',
    }
  }
  if (kind === 'held')
    return {
      verdict: 'approve',
      reason: '被 Reddit 自动过滤扣下了，但没看到广告或骂人的话；建议放出来。',
    }
  return { verdict: 'ignore', reason: '正常新帖，不用管。' }
}
