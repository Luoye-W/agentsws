/**
 * WP220：**最近 N 天大家在聊什么**的排序——方法改编自 mvanhorn/last30days-skill（MIT，© 2026 Matt Van Horn）。
 *
 * 留下的方法（用我们自己的话、自己的代码重写，没有搬它的 Python）：
 *
 * 1. **时间窗是硬的**：窗外的一律不进排序（它的规矩：「最近 30 天」的报告不许把九个月前的视频排第一）；
 * 2. **同一条只算一次**：按归一后的地址去重，留信息更全的那份；同平台里标题 + 正文几乎一样的也合并；
 * 3. **主体对得上才算数**：话题去掉「评测 / 价格 / 这周」这类意图词，剩下的主体（取第一个词）
 *    在标题或正文里找不到 → 重罚（互动再高也救不回来，免得热门的跑题帖排到前面）；
 * 4. **分数 = 相关 × 互动 × 新鲜 × 来源可信度**，互动取对数（一条爆帖不压死别的）；
 * 5. **一个作者最多三条**（不让一个人刷屏整份报告）；
 * 6. **扩散速度**：互动 ÷ 发出后的小时数，明显高于其余的标成「在扩散」。
 *
 * 数字由这里算，模型只负责读懂、分组、说成人话。
 */
import type { Iso8601, ResearchFetchRoute } from '@agentsws/contracts'

export type ResearchSentiment = 'positive' | 'negative' | 'neutral' | 'mixed' | 'unclear'

/** 研究拿回来的一条（任何平台、任何来源，归一后）。正文是**外部文本**。 */
export interface ResearchItem {
  platform: string
  url: string
  title?: string
  text?: string
  author?: string
  published_at?: Iso8601
  engagement?: {
    score?: number
    likes?: number
    comments?: number
    shares?: number
    views?: number
  }
  /** 从哪一路取来的（报告的出处要写）。 */
  route: ResearchFetchRoute
  cached?: boolean
  /** 归到哪个话题（模型分组后填；不填归「其他」）。 */
  topic?: string
  /** 情绪（规则或模型判；判不准就是 `unclear`，别凑）。 */
  sentiment?: ResearchSentiment
}

export interface RankedItem {
  item: ResearchItem
  score: number
  /** 主体没对上（被重罚过）。 */
  entity_miss: boolean
  /** 同一条又在别处见到几次（去重合并进来的）。 */
  seen_count: number
  /** 互动 ÷ 小时（没有发帖时间就没有）。 */
  velocity?: number
}

export interface RankResult {
  ranked: RankedItem[]
  /** 窗外丢掉了几条。 */
  out_of_window: number
  /** 合并掉了几条重复。 */
  duplicates: number
}

/** 各来源的可信度（社媒噪音大一点）。没列的按 0.7。 */
export const SOURCE_QUALITY: Readonly<Record<string, number>> = {
  web: 0.9,
  hacker_news: 0.8,
  youtube: 0.85,
  reddit: 0.65,
  x: 0.65,
  tiktok: 0.6,
  instagram: 0.6,
  facebook: 0.6,
  threads: 0.6,
  linkedin: 0.7,
}

/** 主体没对上时扣的分（满分 100）。足够把跑题帖压到对题帖下面。 */
export const ENTITY_MISS_PENALTY = 25
export const MAX_ITEMS_PER_AUTHOR = 3

const INTENT_WORDS = new Set([
  'review',
  'reviews',
  'pricing',
  'price',
  'reddit',
  'twitter',
  'x',
  'news',
  'reaction',
  'opinions',
  'vs',
  'best',
  'tips',
  'problems',
  'issues',
  'this',
  'week',
  'month',
  '评测',
  '价格',
  '口碑',
  '这周',
  '本周',
  '这个月',
  '最近',
  '怎么样',
  '在聊什么',
  '大家',
  '舆情',
])

/** 话题 → 主体的第一个词（小写）。中文主体取整段（中文不按空格分词）。 */
export function primaryEntityHead(topic: string): string {
  const tokens = topic
    .toLowerCase()
    .split(/[\s,，、/|]+/u)
    .map((t) => t.trim())
    .filter((t) => t !== '' && !INTENT_WORDS.has(t))
  return tokens[0] ?? topic.trim().toLowerCase()
}

/** 地址归一：去追踪参数、锚点、末尾斜杠；host 小写；`old.` / `m.` / `www.` 当同一个站。 */
export function normalizeResearchUrl(raw: string): string {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return raw.trim()
  }
  for (const key of [...u.searchParams.keys()])
    if (/^(utm_|ref$|ref_|fbclid$|gclid$|igshid$|share_id$|si$|s$|t$)/i.test(key))
      u.searchParams.delete(key)
  const host = u.hostname.toLowerCase().replace(/^(www|old|m|mobile)\./, '')
  const path = u.pathname.replace(/\/+$/, '')
  const q = u.searchParams.toString()
  return `${host}${path}${q === '' ? '' : `?${q}`}`
}

function engagementTotal(e: ResearchItem['engagement']): number {
  if (e === undefined) return 0
  return (
    (e.score ?? 0) +
    (e.likes ?? 0) +
    (e.comments ?? 0) * 2 +
    (e.shares ?? 0) * 2 +
    (e.views ?? 0) / 100
  )
}

function trigrams(text: string): Set<string> {
  const t = text.toLowerCase().replace(/\s+/g, ' ').trim()
  const out = new Set<string>()
  for (let i = 0; i + 3 <= t.length; i++) out.add(t.slice(i, i + 3))
  return out
}

function similar(a: string, b: string): number {
  const x = trigrams(a)
  const y = trigrams(b)
  if (x.size === 0 || y.size === 0) return 0
  let inter = 0
  for (const g of x) if (y.has(g)) inter++
  return inter / (x.size + y.size - inter)
}

/** 信息更全的那份（有发帖时间、互动数更多的优先）。 */
function richer(a: ResearchItem, b: ResearchItem): ResearchItem {
  const fields = (i: ResearchItem): number =>
    (i.published_at === undefined ? 0 : 1) +
    Object.keys(i.engagement ?? {}).length +
    (i.text === undefined ? 0 : 1)
  return fields(b) > fields(a) ? b : a
}

export function rankTrendItems(
  items: readonly ResearchItem[],
  options: { topic: string; now: Iso8601; window_days?: number },
): RankResult {
  const nowMs = Date.parse(options.now)
  const windowMs = (options.window_days ?? 30) * 86_400_000
  let outOfWindow = 0
  // 1. 硬时间窗（没有时间的留着——网页常常没有，报告里标「时间不明」）
  const inWindow = items.filter((i) => {
    if (i.published_at === undefined) return true
    const t = Date.parse(i.published_at)
    const ok = Number.isFinite(t) && t <= nowMs && nowMs - t <= windowMs
    if (!ok) outOfWindow++
    return ok
  })
  // 2. 按地址去重，再同平台按文字近似合并
  const byUrl = new Map<string, { item: ResearchItem; seen: number }>()
  for (const i of inWindow) {
    const key = normalizeResearchUrl(i.url)
    const found = byUrl.get(key)
    if (found === undefined) byUrl.set(key, { item: i, seen: 1 })
    else byUrl.set(key, { item: richer(found.item, i), seen: found.seen + 1 })
  }
  const merged: { item: ResearchItem; seen: number }[] = []
  for (const row of byUrl.values()) {
    const text = `${row.item.title ?? ''} ${row.item.text ?? ''}`.trim()
    const twin =
      text.length < 20
        ? undefined
        : merged.find(
            (m) =>
              m.item.platform === row.item.platform &&
              similar(text, `${m.item.title ?? ''} ${m.item.text ?? ''}`) >= 0.7,
          )
    if (twin === undefined) merged.push({ ...row })
    else {
      twin.item = richer(twin.item, row.item)
      twin.seen += row.seen
    }
  }
  const duplicates = inWindow.length - merged.length
  // 3–4. 打分
  const head = primaryEntityHead(options.topic)
  const maxEng = Math.max(1, ...merged.map((m) => engagementTotal(m.item.engagement)))
  const scored: RankedItem[] = merged.map(({ item, seen }) => {
    const hay = `${item.title ?? ''} ${item.text ?? ''}`.toLowerCase()
    const entityMiss = head !== '' && !hay.includes(head)
    const eng = engagementTotal(item.engagement)
    const engNorm = Math.log1p(eng) / Math.log1p(maxEng)
    const ageDays =
      item.published_at === undefined
        ? undefined
        : (nowMs - Date.parse(item.published_at)) / 86_400_000
    const fresh =
      ageDays === undefined ? 0.5 : Math.max(0, 1 - ageDays / ((options.window_days ?? 30) + 1))
    const relevance = entityMiss ? 0.3 : 1
    const quality = SOURCE_QUALITY[item.platform] ?? 0.7
    const raw = 100 * (0.45 * relevance + 0.35 * engNorm + 0.2 * fresh) * quality
    const score = Math.round((entityMiss ? raw - ENTITY_MISS_PENALTY : raw) * 10) / 10
    const hours = ageDays === undefined ? undefined : Math.max(1, ageDays * 24)
    return {
      item,
      score,
      entity_miss: entityMiss,
      seen_count: seen,
      ...(hours === undefined ? {} : { velocity: Math.round((eng / hours) * 10) / 10 }),
    }
  })
  scored.sort((a, b) => b.score - a.score)
  // 5. 一个作者最多三条
  const perAuthor = new Map<string, number>()
  const ranked = scored.filter((r) => {
    const a = r.item.author?.toLowerCase()
    if (a === undefined) return true
    const n = (perAuthor.get(`${r.item.platform}:${a}`) ?? 0) + 1
    perAuthor.set(`${r.item.platform}:${a}`, n)
    return n <= MAX_ITEMS_PER_AUTHOR
  })
  return { ranked, out_of_window: outOfWindow, duplicates }
}
