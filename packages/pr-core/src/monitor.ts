/**
 * 提及归一、去重、情绪分级与"归谁"（60 §2 `monitor.ts`）。
 *
 * `pr.monitoring` 一天要看几十条来自新闻、Reddit、论坛、评测、社媒的提及。
 * 这个模块回答的是三个问题，顺序不能换：
 *
 * 1. **是不是同一条**（{@link mentionKey} / {@link dedupeMentions}）——
 *    同一条新闻会被十几个站转载，Google Alerts 与 Reddit 搜索也会各给一遍。
 *    不去重的话"今天有 40 条负面"这句话本身就是假的。
 * 2. **是好话还是坏话**（{@link scoreSentiment}）——三档，不是分数（见契约
 *    `MentionSentiment` 的注释）。
 * 3. **归谁**（{@link triageMention}）——**客户问题转客服，舆情公关自己答**。
 *    这是 60 分界行那句话的落点，与 56 的那条边界是同一条纪律：
 *    一句"我的单还没到"出现在 Reddit 上，它仍然是一张工单。
 *
 * 客户问题那一档**复用 `@agentsws/social-core` 的 `triageThread`**，不另写一份
 * 词表：同一句话在 Discord 里与在 Reddit 里是同一个意思，两份词表迟早各改各的。
 */

import type { Mention, MentionSentiment, MentionSource, MentionTriage } from '@agentsws/contracts'
import { triageThread } from '@agentsws/social-core'

/* ── 一、去重 ───────────────────────────────────────────────────────── */

/** URL 归一：去掉追踪参数、末尾斜杠与 `#锚点`。大小写只归 host，不归路径。 */
export function normalizeUrl(raw: string): string {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return raw.trim()
  }
  const drop = /^(utm_|ref$|ref_|fbclid$|gclid$|igshid$|share_id$|si$)/i
  for (const key of [...u.searchParams.keys()]) if (drop.test(key)) u.searchParams.delete(key)
  u.hash = ''
  const path = u.pathname.replace(/\/+$/, '')
  const query = u.searchParams.toString()
  return `${u.protocol}//${u.hostname.toLowerCase()}${path}${query === '' ? '' : `?${query}`}`
}

/** 标题归一：去空白、转小写、去掉标点——转载会改标点与空格，不会改字。 */
function titleKey(title: string): string {
  return title
    .toLowerCase()
    .replace(/[\s　]+/g, '')
    .replace(/[|｜\-—–·:：,，.。!！?？"'“”‘’()（）[\]【】]/g, '')
    .slice(0, 80)
}

/**
 * 一条提及的去重键。
 *
 * 优先用归一后的 URL（同一个地址一定是同一条）；没有 URL 就用
 * `来源 + 标题`——同一天同一个标题在同一个来源上出现两次，当一条。
 * **不跨来源合并标题**：同一个标题出现在新闻与 Reddit 上是两件事
 * （一条是报道，一条是有人在讨论那条报道），处理方式不一样。
 */
export function mentionKey(input: {
  source: MentionSource
  url?: string
  title?: string
  text?: string
}): string {
  if (input.url !== undefined && input.url.trim() !== '') return `url:${normalizeUrl(input.url)}`
  const t = input.title ?? input.text ?? ''
  return `${input.source}:${titleKey(t)}`
}

/**
 * 一批提及去重。**留最早的那一条**，把后来的算成"又见到一次"。
 *
 * 留最早不是随手定的：转载链上第一条多半是原发，而原发那一条的作者与正文
 * 是我们真要看的东西。`seen_count` 让"这条被转了 30 次"这件事看得见——
 * 那正是舆情要不要升级的判据。
 */
export function dedupeMentions<T extends { dedupe_key: string; published_at: string }>(
  rows: readonly T[],
): { mention: T; seen_count: number }[] {
  const byKey = new Map<string, { mention: T; seen_count: number }>()
  for (const row of rows) {
    const found = byKey.get(row.dedupe_key)
    if (found === undefined) {
      byKey.set(row.dedupe_key, { mention: row, seen_count: 1 })
      continue
    }
    found.seen_count += 1
    if (Date.parse(row.published_at) < Date.parse(found.mention.published_at)) found.mention = row
  }
  return [...byKey.values()]
}

/* ── 二、情绪 ───────────────────────────────────────────────────────── */

/** **只可加行**（15 §2 对规则集的老规矩）。 */
export const NEGATIVE_TERMS: readonly string[] = [
  '翻车',
  '避雷',
  '别买',
  '智商税',
  '割韭菜',
  '虚假宣传',
  '维权',
  '投诉',
  '曝光',
  '骗',
  '垃圾',
  '失望',
  '召回',
  '起火',
  '漏电',
  '退货潮',
  'scam',
  'ripoff',
  'avoid',
  'do not buy',
  "don't buy",
  'waste of money',
  'terrible',
  'awful',
  'broke after',
  'stopped working',
  'recall',
  'lawsuit',
  'misleading',
  'false advertising',
]

export const POSITIVE_TERMS: readonly string[] = [
  '真香',
  '好评',
  '推荐',
  '值得',
  '惊喜',
  '做工扎实',
  '用了一年',
  '回购',
  'love it',
  'highly recommend',
  'worth every',
  'best i',
  'holds up',
  'solid build',
  'impressed',
]

/** 低于这个把握就当中性——**不猜**（同 56 §3 的 `TRIAGE_FLOOR`）。 */
export const SENTIMENT_FLOOR = 0.5

export interface SentimentResult {
  sentiment: MentionSentiment
  confidence: number
  /** 命中的判据名（**不是原句**：结论会进事件日志，正文是外部文本，21 §1）。 */
  signals: string[]
}

/**
 * 三档情绪。
 *
 * 加权很简单，故意的：命中一条负面词加 0.6，正面加 0.55，两边都命中时
 * **负面赢**——一条"做工不错，但用了两周就漏电"在舆情上是负面，
 * 漏掉它的代价比误报一条大得多。
 */
export function scoreSentiment(input: { title?: string; text: string }): SentimentResult {
  const hay = `${input.title ?? ''}\n${input.text}`.toLowerCase()
  const signals: string[] = []
  let neg = 0
  let pos = 0
  for (const t of NEGATIVE_TERMS)
    if (hay.includes(t.toLowerCase())) {
      neg += 0.6
      signals.push(`negative:${t}`)
    }
  for (const t of POSITIVE_TERMS)
    if (hay.includes(t.toLowerCase())) {
      pos += 0.55
      signals.push(`positive:${t}`)
    }
  // 两边都有 → 负面赢（文件头这一段的最后一句）
  if (neg > 0 && neg >= Math.min(pos, 1)) {
    const confidence = Math.min(1, neg)
    return confidence >= SENTIMENT_FLOOR
      ? { sentiment: 'negative', confidence, signals }
      : { sentiment: 'neutral', confidence, signals }
  }
  if (pos > 0) {
    const confidence = Math.min(1, pos)
    return confidence >= SENTIMENT_FLOOR
      ? { sentiment: 'positive', confidence, signals }
      : { sentiment: 'neutral', confidence, signals }
  }
  return { sentiment: 'neutral', confidence: 0, signals }
}

/* ── 三、归谁 ───────────────────────────────────────────────────────── */

/** 记者来问的那几句（"想采访""能不能给份资料"）。收窄，宁可漏判成舆情。 */
export const MEDIA_INQUIRY_TERMS: readonly string[] = [
  '采访',
  '约稿',
  '媒体咨询',
  '新闻稿',
  '想写一篇',
  '能否提供样品测评',
  'press inquiry',
  'media request',
  'press kit',
  'for an article',
  'writing a piece',
  'comment for our story',
]

export interface MentionTriageResult {
  triage: MentionTriage
  sentiment: MentionSentiment
  confidence: number
  signals: string[]
  /** 该谁接。`pr` = 公关自己处理。 */
  route: MentionRoute
}

/**
 * 判完之后交给谁。
 *
 * - `pr`：公关自己（舆情、媒体询问、存证、归档）；
 * - `support`：客服（**客户的问题**）——60 分界行那句话。
 */
export type MentionRoute = 'pr' | 'support'

/** 五类各归谁。**只有这一份**：转客服卡、岗位路由、面板计数都读它。 */
export const MENTION_ROUTES: Readonly<Record<MentionTriage, MentionRoute>> = {
  customer_issue: 'support',
  reputation: 'pr',
  media_inquiry: 'pr',
  praise: 'pr',
  noise: 'pr',
}

/**
 * 判一条提及。
 *
 * 顺序是硬的，每一步都能短路后面的：
 *
 * 1. **客户问题最先判**（复用 `social-core` 的 `triageThread`）：一条
 *    "我的单还没到"不管它出现在哪儿，都归客服。判错成舆情的代价是
 *    一个买家在外面等着没人理。
 * 2. **记者来问**次之：它常常同时命中负面词（记者问的多半是坏事），
 *    但"该谁答"的答案是公关而不是"发一条预警"。
 * 3. 剩下的按情绪分：负面 → `reputation`（出预警卡），正面 → `praise`
 *    （存证），中性 → `noise`（归档）。判不准落 `noise`，**不猜**。
 */
export function triageMention(input: {
  title?: string
  text: string
  source: MentionSource
}): MentionTriageResult {
  const mood = scoreSentiment(input)
  const hay = `${input.title ?? ''}\n${input.text}`
  const lower = hay.toLowerCase()

  // 一、客户问题（词表在 social-core，全仓同一份）
  const asThread = triageThread({ text: hay, mentions_us: true })
  if (asThread.klass === 'customer_question')
    return {
      triage: 'customer_issue',
      sentiment: mood.sentiment,
      confidence: asThread.confidence,
      signals: [...asThread.signals, ...mood.signals],
      route: 'support',
    }

  // 二、记者来问
  const inquiry = MEDIA_INQUIRY_TERMS.find((t) => lower.includes(t.toLowerCase()))
  if (inquiry !== undefined)
    return {
      triage: 'media_inquiry',
      sentiment: mood.sentiment,
      confidence: 0.7,
      signals: [`media_inquiry:${inquiry}`, ...mood.signals],
      route: 'pr',
    }

  // 三、按情绪分
  const triage: MentionTriage =
    mood.sentiment === 'negative'
      ? 'reputation'
      : mood.sentiment === 'positive'
        ? 'praise'
        : 'noise'
  return {
    triage,
    sentiment: mood.sentiment,
    confidence: mood.confidence,
    signals: mood.signals,
    route: MENTION_ROUTES[triage],
  }
}

/** 一张转出去 / 要人看的卡该带什么。 */
export interface MentionHandoff {
  /** 转给哪条职责；`undefined` = 公关自己处理（但可能还是要出一张预警卡）。 */
  to_role?: string
  kind: 'support_handoff' | 'negative_alert' | 'response_draft' | 'archive'
  title: string
  reason: string
}

/**
 * 判完之后该出哪一张卡。
 *
 * 四条路各自的理由：
 *
 * - `customer_issue` → **转客服卡**，公关不答（60 分界行）。它的 `to_role`
 *   是网站客服 `dtc.support`——提及来自公开网络，不是我们自己的群，所以不是
 *   社群管理那条（56 §4 的 `dtc.community-support` 只收自己群里的）。
 * - `reputation` + 负面 → **负面预警卡**（L3 自动出，60 §1 那一行）。
 * - `media_inquiry` → **回应草稿卡**：记者等着一句话，拖三天就变成
 *   "该公司未予置评"。
 * - 其余 → 存证 / 归档，不出卡。
 */
export function handoffOfMention(
  result: MentionTriageResult,
  ctx: { origin: string; author?: string },
): MentionHandoff {
  const who = ctx.author === undefined ? ctx.origin : `${ctx.author}（${ctx.origin}）`
  if (result.triage === 'customer_issue')
    return {
      to_role: 'dtc.support',
      kind: 'support_handoff',
      title: `转客服：${who} 在外面问的一个订单问题`,
      reason:
        '这是客户的问题（订单 / 售后 / 怎么用），按 60 的分界归客服答——公关管的是舆情与媒体，答不了"你的单到哪儿了"（这条职责的 scopes 里没有订单域）。',
    }
  if (result.triage === 'media_inquiry')
    return {
      kind: 'response_draft',
      title: `媒体询问：${who}`,
      reason:
        '有记者在问。拖三天的后果不是没人写，是写成"该公司未予置评"——先出一份草稿，你改完再发。',
    }
  if (result.triage === 'reputation' && result.sentiment === 'negative')
    return {
      kind: 'negative_alert',
      title: `负面预警：${who}`,
      reason:
        '外面有一条负面在传。先让你看见，再决定要不要回——多数负面不需要回应，但每一条都需要有人知道。',
    }
  return {
    kind: 'archive',
    title: `存档：${who}`,
    reason:
      result.triage === 'praise'
        ? '一条好话，存着。以后写新闻稿、做落地页要引用真实的用户原话。'
        : '判不准是好是坏，归档——判不准就不猜（多一个「疑似」的桶只会让两边都不接）。',
  }
}

/** 一批提及按类计数（面板"提及流（按情绪）"那一格读它）。 */
export function mentionCounts(rows: readonly Pick<Mention, 'sentiment' | 'triage'>[]): {
  sentiment: Record<MentionSentiment, number>
  triage: Record<MentionTriage, number>
} {
  const sentiment: Record<MentionSentiment, number> = { negative: 0, neutral: 0, positive: 0 }
  const triage: Record<MentionTriage, number> = {
    customer_issue: 0,
    reputation: 0,
    media_inquiry: 0,
    praise: 0,
    noise: 0,
  }
  for (const r of rows) {
    if (r.sentiment !== undefined) sentiment[r.sentiment] += 1
    if (r.triage !== undefined) triage[r.triage] += 1
  }
  return { sentiment, triage }
}
