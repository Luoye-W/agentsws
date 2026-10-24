/**
 * WP450（docs/109 §5.2 #9）：**主题簇**——按搜索结果重叠度把词分组，出「一篇总页 + 几篇分页 + 内链怎么连」。
 *
 * 全是规则，数一个不经模型手；同输入同输出：
 *
 * 1. 先认意图（词面）：导航类（品牌名、登录、官网）不进簇；
 * 2. 两两比前 10 名自然结果里**共有几个网址**（去掉协议、`www.`、结尾斜杠与参数）：
 *    ≥ 7 = 同一篇（并进一篇，一篇接住几个词）；4–6 = 同一小组（组内分页互链）；2–3 = 邻组（各链一条）；0–1 = 不相干；
 * 3. 按「≥ 2」连起来的那一片是一个主题；总页挑**和别的词重叠最多、量最大**的那个；
 * 4. 内链：每篇分页 ↔ 总页（必有）；同组分页互链（每篇最多 2 条）；邻组各一条；
 * 5. 已经排上的词（Search Console 里有那一页）标「回头改那一页」，不另写一篇新的。
 *
 * 方法借 claude-seo（MIT，github.com/AgriciDaniel/claude-seo @ 4b99de2）`skills/seo-cluster`（重叠阈值 7 / 4 / 2、
 * 总页挑法、链接矩阵）与 claude-blog（MIT，github.com/AgriciDaniel/claude-blog @ 3544423）`skills/blog-cluster`
 * （总页先写、分页按量排）。只借方法，代码自己写。
 */
import type {
  SeoCluster,
  SeoClusterKeyword,
  SeoClusterLink,
  SeoClusterOverlap,
  SeoClusterPost,
  SeoClusterScheduleItem,
  SeoKeywordIntent,
} from '@agentsws/contracts'
import { addDays } from './google.js'
import { isBrandQuery, normalizeQuery } from './signals.js'

/** 重叠阈值（前 10 名里共有几个网址）。 */
export const CLUSTER_OVERLAP = {
  /** 同一篇。 */
  same_post: 7,
  /** 同一小组。 */
  same_group: 4,
  /** 邻组（互链一条）。 */
  interlink: 2,
} as const

/** 一组至少几篇才出卡（总页 + 2 篇分页）。 */
export const MIN_CLUSTER_POSTS = 3
/** 一组最多几篇分页（多了下一次再出）。 */
export const MAX_CLUSTER_SPOKES = 8
/** 一次最多查几个词的搜索结果（花费上限）。 */
export const MAX_CLUSTER_SERP = 20

const INTENT_TERMS: { intent: Exclude<SeoKeywordIntent, 'unknown'>; terms: string[] }[] = [
  {
    intent: 'navigational',
    terms: ['login', 'log in', 'sign in', 'official site', 'customer service', '官网', '登录'],
  },
  {
    intent: 'transactional',
    terms: [
      'buy',
      'price',
      'discount',
      'coupon',
      'promo code',
      'order',
      'cheap',
      'deal',
      'for sale',
      'kaufen',
      'preis',
      'acheter',
      'prix',
      '购买',
      '价格',
      '优惠',
      '多少钱',
    ],
  },
  {
    intent: 'commercial',
    terms: [
      'best',
      'top',
      'review',
      ' vs',
      'versus',
      'alternative',
      'compare',
      'comparison',
      'test',
      'beste',
      'vergleich',
      'meilleur',
      '推荐',
      '哪个好',
      '对比',
      '评测',
    ],
  },
  {
    intent: 'informational',
    terms: [
      'how',
      'what',
      'why',
      'when',
      'guide',
      'tutorial',
      'tips',
      'ideas',
      'wie',
      'was ist',
      'comment',
      "qu'est",
      '如何',
      '怎么',
      '什么',
      '为什么',
      '教程',
    ],
  },
]

/** 词面认意图；品牌词与登录类算导航（不进簇）。认不出 `unknown`（照样进簇）。 */
export function keywordIntent(
  keyword: string,
  brand_terms: readonly string[] = [],
): SeoKeywordIntent {
  if (isBrandQuery(keyword, brand_terms)) return 'navigational'
  const q = ` ${normalizeQuery(keyword)} `
  for (const r of INTENT_TERMS)
    if (r.terms.some((t) => (/^[a-z ]/.test(t) ? q.includes(` ${t.trim()}`) : q.includes(t))))
      return r.intent
  return 'unknown'
}

/** 前 10 名的网址认成同一个（去协议、`www.`、参数、结尾斜杠，小写）。 */
export function serpUrlKey(url: string): string {
  try {
    const u = new URL(url)
    const path = u.pathname.replace(/\/+$/, '')
    return `${u.hostname.replace(/^www\./, '').toLowerCase()}${path.toLowerCase()}`
  } catch {
    return url
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/^www\./, '')
      .replace(/[?#].*$/, '')
      .replace(/\/+$/, '')
  }
}

/** 两个词前 10 名自然结果里共有几个网址。 */
export function serpOverlap(a: readonly string[], b: readonly string[]): number {
  const ka = new Set(a.slice(0, 10).map(serpUrlKey))
  let n = 0
  for (const u of new Set(b.slice(0, 10).map(serpUrlKey))) if (ka.has(u)) n += 1
  return n
}

/** 并查集（按插入顺序，结果确定）。 */
function groupsBy(ids: readonly string[], linked: (a: string, b: string) => boolean): string[][] {
  const parent = new Map(ids.map((id) => [id, id]))
  const find = (x: string): string => {
    let r = x
    while (parent.get(r) !== r) r = parent.get(r) as string
    parent.set(x, r)
    return r
  }
  for (let i = 0; i < ids.length; i += 1)
    for (let j = i + 1; j < ids.length; j += 1) {
      const a = ids[i] as string
      const b = ids[j] as string
      if (linked(a, b)) {
        const ra = find(a)
        const rb = find(b)
        if (ra !== rb) parent.set(rb, ra)
      }
    }
  const out = new Map<string, string[]>()
  for (const id of ids) {
    const r = find(id)
    out.set(r, [...(out.get(r) ?? []), id])
  }
  return [...out.values()]
}

const isCjk = (s: string): boolean => /[぀-ヿ一-鿿]/.test(s)

const titleCase = (q: string): string =>
  q
    .trim()
    .split(/\s+/)
    .map((w) => (/^[a-z]/.test(w) ? `${w.charAt(0).toUpperCase()}${w.slice(1)}` : w))
    .join(' ')

/** 建议标题（规则拼的）：总页「完整指南」，分页照词写（写的人可以改）。 */
export function clusterTitle(keyword: string, role: 'pillar' | 'spoke'): string {
  const t = titleCase(keyword)
  if (role === 'spoke') return t
  return isCjk(keyword) ? `${t}：完整指南` : `${t}: The Complete Guide`
}

export interface ClusterInput {
  keywords: readonly SeoClusterKeyword[]
  /** 词（原样）→ 前 10 名自然结果的网址；没查到的词不在里面。 */
  serps: ReadonlyMap<string, readonly string[]>
  brand_terms?: readonly string[]
  /** 簇 id 前缀（服务端给日期，测试给固定值）。 */
  id: string
  max_spokes?: number
}

export interface ClusterPlan {
  /** 能出卡的主题（大的在前）；一组都凑不成是空。 */
  clusters: SeoCluster[]
  excluded: { keyword: string; reason: string }[]
}

const strength = (k: SeoClusterKeyword): number => k.volume ?? k.impressions ?? 0

/** 按搜索结果重叠度分组（见文件头）。 */
export function planClusters(input: ClusterInput): ClusterPlan {
  const brand = input.brand_terms ?? []
  const maxSpokes = input.max_spokes ?? MAX_CLUSTER_SPOKES
  const excluded: { keyword: string; reason: string }[] = []
  const seen = new Set<string>()
  const pool: SeoClusterKeyword[] = []
  for (const raw of input.keywords) {
    const key = normalizeQuery(raw.keyword)
    if (key === '' || seen.has(key)) continue
    seen.add(key)
    const intent = raw.intent === 'unknown' ? keywordIntent(raw.keyword, brand) : raw.intent
    if (intent === 'navigational' || isBrandQuery(raw.keyword, brand)) {
      excluded.push({ keyword: raw.keyword, reason: '品牌 / 导航类的词，不写新页' })
      continue
    }
    const serp = input.serps.get(raw.keyword)
    if (serp === undefined || serp.length === 0) {
      excluded.push({ keyword: raw.keyword, reason: '没查到搜索结果，分不了组' })
      continue
    }
    pool.push({ ...raw, intent })
  }
  const byKw = new Map(pool.map((k) => [k.keyword, k]))
  const ov = (a: string, b: string): number =>
    serpOverlap(input.serps.get(a) ?? [], input.serps.get(b) ?? [])
  // 1) ≥ 7 并成一篇：一篇里量最大的那个词当正题，其余挂 `also`
  const posts = groupsBy(
    pool.map((k) => k.keyword),
    (a, b) => ov(a, b) >= CLUSTER_OVERLAP.same_post,
  ).map((ws) => {
    const kw = (w: string): SeoClusterKeyword => byKw.get(w) as SeoClusterKeyword
    const sorted = [...ws].sort((a, b) => strength(kw(b)) - strength(kw(a)))
    return { lead: sorted[0] as string, words: sorted }
  })
  // 两篇之间的重叠 = 两篇各自词之间的最大值
  const postOverlap = (a: { words: string[] }, b: { words: string[] }): number => {
    let m = 0
    for (const x of a.words) for (const y of b.words) m = Math.max(m, ov(x, y))
    return m
  }
  const leadOf = new Map(posts.map((p) => [p.lead, p]))
  const leads = posts.map((p) => p.lead)
  const po = (a: string, b: string): number =>
    postOverlap(leadOf.get(a) as { words: string[] }, leadOf.get(b) as { words: string[] })
  // 2) ≥ 2 连起来的一片 = 一个主题
  const topics = groupsBy(leads, (a, b) => po(a, b) >= CLUSTER_OVERLAP.interlink)
  for (const t of topics)
    if (t.length < MIN_CLUSTER_POSTS)
      for (const lead of t)
        for (const w of leadOf.get(lead)?.words ?? [])
          excluded.push({ keyword: w, reason: '和别的词搜索结果几乎不重叠，凑不成一组' })
  const clusters: SeoCluster[] = []
  const usable = topics
    .filter((t) => t.length >= MIN_CLUSTER_POSTS)
    .sort((a, b) => {
      const sa = a.reduce((s, l) => s + strength(byKw.get(l) as SeoClusterKeyword), 0)
      const sb = b.reduce((s, l) => s + strength(byKw.get(l) as SeoClusterKeyword), 0)
      return sb - sa || b.length - a.length
    })
  usable.forEach((topic, ti) => {
    // 3) 总页：和组里别的词重叠最多 + 量最大（两样各归一化到 0–1 相加）
    const degree = new Map(
      topic.map((l) => [l, topic.reduce((s, o) => (o === l ? s : s + po(l, o)), 0)]),
    )
    const maxDeg = Math.max(1, ...degree.values())
    const maxVol = Math.max(1, ...topic.map((l) => strength(byKw.get(l) as SeoClusterKeyword)))
    const score = (l: string): number =>
      (degree.get(l) ?? 0) / maxDeg + strength(byKw.get(l) as SeoClusterKeyword) / maxVol
    const ordered = [...topic].sort((a, b) => score(b) - score(a) || a.localeCompare(b))
    const pillarLead = ordered[0] as string
    const spokeLeads = ordered
      .slice(1)
      .sort(
        (a, b) =>
          strength(byKw.get(b) as SeoClusterKeyword) - strength(byKw.get(a) as SeoClusterKeyword) ||
          a.localeCompare(b),
      )
    const kept = spokeLeads.slice(0, maxSpokes)
    for (const l of spokeLeads.slice(maxSpokes))
      excluded.push({ keyword: l, reason: '这组分页已经够多，留到下一组' })
    // 4) 小组：≥ 4 连起来的
    const groups = groupsBy([pillarLead, ...kept], (a, b) => po(a, b) >= CLUSTER_OVERLAP.same_group)
    const groupOf = new Map<string, number>()
    groups.forEach((g, gi) => {
      for (const l of g) groupOf.set(l, gi)
    })
    const postOf = (lead: string, role: 'pillar' | 'spoke', i: number): SeoClusterPost => {
      const k = byKw.get(lead) as SeoClusterKeyword
      const words = leadOf.get(lead)?.words ?? [lead]
      const also = words.filter((w) => w !== lead)
      const refresh = k.ranking_page !== undefined
      return {
        id: role === 'pillar' ? 'pillar' : `s${String(i + 1)}`,
        role,
        keyword: lead,
        ...(also.length === 0 ? {} : { also }),
        title: clusterTitle(lead, role),
        kind: refresh ? 'refresh' : 'new',
        ...(refresh ? { existing_page: k.ranking_page } : {}),
        ...(k.volume === undefined ? {} : { volume: k.volume }),
        group: groupOf.get(lead) ?? 0,
      }
    }
    const pillar = postOf(pillarLead, 'pillar', 0)
    const spokes = kept.map((l, i) => postOf(l, 'spoke', i))
    const links = clusterLinks(pillar, spokes, (a, b) => po(a, b))
    const pairs: SeoClusterOverlap[] = []
    const all = [pillarLead, ...kept]
    for (let i = 0; i < all.length; i += 1)
      for (let j = i + 1; j < all.length; j += 1) {
        const shared = po(all[i] as string, all[j] as string)
        if (shared >= CLUSTER_OVERLAP.interlink)
          pairs.push({ a: all[i] as string, b: all[j] as string, shared })
      }
    pairs.sort((x, y) => y.shared - x.shared || x.a.localeCompare(y.a))
    clusters.push({
      id: `${input.id}-${String(ti + 1)}`,
      topic: pillarLead,
      pillar,
      spokes,
      links,
      overlap: pairs.slice(0, 6),
    })
  })
  if (clusters[0] !== undefined && excluded.length > 0) clusters[0].excluded = excluded.slice(0, 12)
  return { clusters, excluded }
}

/**
 * 链接矩阵：分页 ↔ 总页（必有，锚文本 = 对方的词）；同组分页互链（每篇最多 2 条）；邻组（重叠 2–3）每篇最多 1 条。
 */
export function clusterLinks(
  pillar: SeoClusterPost,
  spokes: readonly SeoClusterPost[],
  overlap: (a: string, b: string) => number,
): SeoClusterLink[] {
  const links: SeoClusterLink[] = []
  for (const s of spokes) {
    links.push({ from: s.id, to: pillar.id, anchor: pillar.keyword, type: 'mandatory' })
    links.push({ from: pillar.id, to: s.id, anchor: s.keyword, type: 'mandatory' })
  }
  for (const s of spokes) {
    const siblings = spokes
      .filter((o) => o.id !== s.id && o.group === s.group)
      .sort((a, b) => overlap(s.keyword, b.keyword) - overlap(s.keyword, a.keyword))
      .slice(0, 2)
    for (const o of siblings)
      links.push({ from: s.id, to: o.id, anchor: o.keyword, type: 'sibling' })
    const cross = spokes
      .filter(
        (o) => o.group !== s.group && overlap(s.keyword, o.keyword) >= CLUSTER_OVERLAP.interlink,
      )
      .sort((a, b) => overlap(s.keyword, b.keyword) - overlap(s.keyword, a.keyword))[0]
    if (cross !== undefined)
      links.push({ from: s.id, to: cross.id, anchor: cross.keyword, type: 'cross' })
  }
  return links
}

/**
 * 排进日历：总页先写，分页按小组、再按量；每天最多 `per_day` 篇（与发布额度同一个数），已经排满的日子跳过。
 * `taken` = 日期 → 那天已经排了几篇。
 */
export function scheduleCluster(
  cluster: SeoCluster,
  opts: { start: string; per_day: number; taken?: ReadonlyMap<string, number> },
): SeoClusterScheduleItem[] {
  const perDay = Math.max(1, Math.floor(opts.per_day))
  const used = new Map(opts.taken ?? [])
  const order = [
    cluster.pillar,
    ...[...cluster.spokes].sort((a, b) => a.group - b.group || (b.volume ?? 0) - (a.volume ?? 0)),
  ]
  const out: SeoClusterScheduleItem[] = []
  let day = opts.start
  for (const post of order) {
    while ((used.get(day) ?? 0) >= perDay) day = addDays(day, 1)
    out.push({ post_id: post.id, date: day })
    used.set(day, (used.get(day) ?? 0) + 1)
  }
  return out
}

/** 写作事项的正文：这篇是总页还是分页、接住哪几个词、要放哪几条内链、要等谁先发。 */
export function clusterBrief(cluster: SeoCluster, post: SeoClusterPost): string[] {
  const name = (id: string): string =>
    id === cluster.pillar.id
      ? `总页「${cluster.pillar.keyword}」`
      : `「${cluster.spokes.find((s) => s.id === id)?.keyword ?? id}」`
  const lines = [
    post.role === 'pillar'
      ? `这是「${cluster.topic}」这组的总页：把这个主题讲全，每篇分页都要从这里链出去（分页发了再补链）。`
      : `这是「${cluster.topic}」这组的一篇分页：只讲透这一个点，开头先给答案。`,
    `主攻的词：${post.keyword}${post.also === undefined ? '' : `（同一篇也接住：${post.also.join('、')}）`}`,
  ]
  if (post.kind === 'refresh' && post.existing_page !== undefined)
    lines.push(`这个词我们已经排上了：回头改 ${post.existing_page}，不另写一篇新的。`)
  const out = cluster.links.filter((l) => l.from === post.id)
  if (out.length > 0)
    lines.push(
      `内链（锚文本用这个词）：${out.map((l) => `${name(l.to)} ← 「${l.anchor}」`).join('；')}`,
    )
  return lines
}
