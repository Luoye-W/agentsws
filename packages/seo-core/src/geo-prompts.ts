/**
 * WP310（决策 463，Luoye 10-14 改）：GEO **按 Prompt 追踪**——从几个方向列候选 Prompt，
 * 用户从中选最相关的 5 条（默认；档位 5 / 10 / 20）持续追踪。
 *
 * 这里只有**纯函数与存储形状**：按品牌档案套句子出候选（按方向分组、不塞品牌名的占多数），
 * 猜一句话属于哪个方向、带没带品牌名，挑默认已选的那几条，和已有的合并（人改过的永远赢、
 * 归档过的不以「新的」身份回来）。真正调模型推荐放 O2（出来的同样走 `newPromptCandidates`）。
 */
import type { GeoPromptTopic, GeoQuestion } from '@agentsws/contracts'
import { GEO_PROMPT_DEFAULT_SELECTED, GEO_PROMPT_TOPICS } from '@agentsws/contracts'
import { looksLikeQuestion } from './geo.js'
import { normalizeQuery } from './signals.js'

/** 出候选要的品牌档案那几格。 */
export interface PromptSeed {
  brand: { name: string; aliases?: readonly string[] | undefined }
  /** 品类（"power bank" / "充电宝"）；没有就只出带品牌名的与查询来的。 */
  category?: string | undefined
  /** 竞品名（最多用前两个）。 */
  competitors?: readonly string[] | undefined
  /** 使用场景（"travel" / "露营"；最多用前三个）。 */
  use_cases?: readonly string[] | undefined
  language: 'zh' | 'en'
  /** Search Console 里排在前面的查询（像问句的才收，方向按字面猜）。 */
  top_queries?: readonly string[] | undefined
}

const LATIN = /^[\p{Script=Latin}\p{N}\s.&'’-]+$/u

/** 一句话里有没有这个名字（拉丁字母按词、其余按子串；大小写不敏感）。 */
function hasName(text: string, name: string): boolean {
  const n = name.trim()
  if (n === '') return false
  if (!LATIN.test(n)) return text.toLowerCase().includes(n.toLowerCase())
  const escaped = n.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`, 'iu').test(text)
}

/** Prompt 里带不带我们的品牌名 / 别名（带的与不带的分开看，借 open-seo `aiPromptIsBranded`）。 */
export function promptIsBranded(text: string, brand: PromptSeed['brand']): boolean {
  return [brand.name, ...(brand.aliases ?? [])].some((n) => hasName(text, n))
}

/** 方向的猜法：按字面关键词（中英都认）。先看带没带品牌名。 */
const TOPIC_RULES: readonly [GeoPromptTopic, RegExp][] = [
  [
    'comparison',
    /\b(vs\.?|versus|compare[ds]?|comparison|alternatives?)\b|对比|相比|和.{1,12}比|替代/iu,
  ],
  [
    'price_value',
    /\b(cheap|cheapest|budget|price[ds]?|pricing|afford\w*|value|worth (it|the money)|cost)\b|性价比|便宜|价格|多少钱|值不值/iu,
  ],
  [
    'reviews',
    /\b(reviews?|reliab\w+|durab\w+|complaints?|quality|legit|trust\w*)\b|口碑|评价|靠谱|耐用|质量/iu,
  ],
  [
    'buying_guide',
    /\b(how (do|to|should) (i )?(choose|pick|buy)|look for|buying guide|consider|features?)\b|选购|怎么选|注意什么|看什么/iu,
  ],
  [
    'use_case',
    /\bbest .+ for\b|\bfor (travel|camping|hiking|work|kids|beginners|gaming|home|office|outdoor\w*)\b|适合|用来|场景/iu,
  ],
  ['category', /\b(best|top|recommend\w*|which brand|leading|popular)\b|推荐|哪个牌子|哪款|排行/iu],
]

/** 一句话属于哪个方向（带品牌名的一律是 `branded`）。 */
export function guessPromptTopic(text: string, brand: PromptSeed['brand']): GeoPromptTopic {
  if (promptIsBranded(text, brand)) return 'branded'
  for (const [topic, re] of TOPIC_RULES) if (re.test(text)) return topic
  return 'other'
}

/** 稳定 id：同一句话（归一后）永远是同一个 id。 */
export function promptId(text: string): string {
  let h = 0
  for (const ch of normalizeQuery(text)) h = (h * 31 + (ch.codePointAt(0) ?? 0)) >>> 0
  return `gp_${h.toString(36)}`
}

/** 品牌档案 → 每个方向几句（英文 / 中文两套）。 */
function templates(seed: PromptSeed): [GeoPromptTopic, string][] {
  const cat = seed.category?.trim() ?? ''
  const name = seed.brand.name.trim()
  const rivals = (seed.competitors ?? [])
    .map((c) => c.trim())
    .filter((c) => c !== '')
    .slice(0, 2)
  const uses = (seed.use_cases ?? [])
    .map((u) => u.trim())
    .filter((u) => u !== '')
    .slice(0, 3)
  const out: [GeoPromptTopic, string][] = []
  const add = (topic: GeoPromptTopic, text: string): void => {
    out.push([topic, text])
  }
  if (seed.language === 'zh') {
    if (cat !== '') {
      add('category', `${cat}哪个牌子好？`)
      add('category', `现在口碑最好的${cat}有哪些？`)
      add('buying_guide', `买${cat}要注意什么？`)
      add('buying_guide', `怎么选一款合适的${cat}？`)
      if (rivals.length >= 2) add('comparison', `${rivals[0]}和${rivals[1]}的${cat}哪个好？`)
      if (rivals[0] !== undefined) add('comparison', `有没有比${rivals[0]}更好的${cat}？`)
      for (const u of uses) add('use_case', `${u}用什么${cat}比较好？`)
      if (uses.length === 0) add('use_case', `新手适合用什么${cat}？`)
      add('price_value', `性价比最高的${cat}是哪款？`)
      add('price_value', `便宜的${cat}值得买吗？`)
      add('reviews', `哪些${cat}品牌评价最好、最耐用？`)
    }
    add('branded', `${name}怎么样，值得买吗？`)
    add('branded', `${name}的口碑如何？`)
    if (rivals[0] !== undefined) add('branded', `${name}和${rivals[0]}哪个好？`)
    return out
  }
  if (cat !== '') {
    add('category', `What is the best ${cat}?`)
    add('category', `Which ${cat} brands are the most recommended right now?`)
    add('buying_guide', `What should I look for when buying a ${cat}?`)
    add('buying_guide', `How do I choose the right ${cat}?`)
    if (rivals.length >= 2)
      add('comparison', `${rivals[0]} vs ${rivals[1]}: which ${cat} is better?`)
    if (rivals[0] !== undefined)
      add('comparison', `What are the best alternatives to ${rivals[0]}?`)
    for (const u of uses) add('use_case', `What is the best ${cat} for ${u}?`)
    if (uses.length === 0) add('use_case', `What is the best ${cat} for beginners?`)
    add('price_value', `What is the best budget ${cat}?`)
    add('price_value', `Is an expensive ${cat} worth it?`)
    add('reviews', `Which ${cat} brands have the best reviews for reliability?`)
  }
  add('branded', `Is ${name} worth it?`)
  add('branded', `What do customers say about ${name}?`)
  if (rivals[0] !== undefined) add('branded', `${name} vs ${rivals[0]}: which is better?`)
  return out
}

const asQuestion = (q: string): string => {
  const t = q.trim()
  if (/[?？]$/u.test(t)) return t
  return /[㐀-鿿]/u.test(t) ? `${t}？` : `${t.charAt(0).toUpperCase()}${t.slice(1)}?`
}

/**
 * 出候选（还没选，`selected: false`）：品牌档案套句 + Search Console 里像问句的查询。
 * 按方向的展示顺序排；同一句（归一后）只出一次。不带品牌名的占多数（带品牌名的只在 `branded` 方向）。
 */
export function generatePromptCandidates(seed: PromptSeed): GeoQuestion[] {
  const seen = new Set<string>()
  const out: GeoQuestion[] = []
  const push = (topic: GeoPromptTopic, text: string, origin: GeoQuestion['origin']): void => {
    const k = normalizeQuery(text)
    if (k === '' || seen.has(k)) return
    seen.add(k)
    out.push({
      id: promptId(text),
      text,
      origin,
      enabled: true,
      topic,
      branded: promptIsBranded(text, seed.brand),
      selected: false,
    })
  }
  for (const [topic, text] of templates(seed)) push(topic, text, 'brand')
  for (const q of seed.top_queries ?? [])
    if (looksLikeQuestion(q)) push(guessPromptTopic(q, seed.brand), asQuestion(q), 'top_query')
  const order = (t: GeoPromptTopic | undefined): number =>
    GEO_PROMPT_TOPICS.findIndex((x) => x.id === t)
  return out
    .map((q, i) => ({ q, i }))
    .sort((a, b) => order(a.q.topic) - order(b.q.topic) || a.i - b.i)
    .map((x) => x.q)
}

/** 带品牌名的最多占几条（5 条里 1 条、10 条里 2 条、20 条里 4 条——不带的占多数）。 */
export function maxBrandedSelected(n: number): number {
  return Math.max(1, Math.floor(n / 5))
}

/**
 * 默认已选：先留人已经选了的（人改过的永远赢）；再按方向轮流挑不带品牌名的；留一个位置给
 * 一条带品牌名的直接提问（看 AI 被直接问到我们时怎么说），带品牌名的总数不超过
 * {@link maxBrandedSelected}。归档的、关掉的不挑。回的是选中的 id（顺序即挑的顺序）。
 */
export function pickDefaultPrompts(
  prompts: readonly GeoQuestion[],
  n: number = GEO_PROMPT_DEFAULT_SELECTED,
): string[] {
  const live = prompts.filter((p) => p.archived_at === undefined && p.enabled)
  const picked: string[] = live
    .filter((p) => p.selected === true)
    .map((p) => p.id)
    .slice(0, n)
  const has = new Set(picked)
  const cap = maxBrandedSelected(n)
  let branded = live.filter((p) => has.has(p.id) && p.branded === true).length
  const brandedPool = live.filter((p) => !has.has(p.id) && p.branded === true)
  const reserve = branded === 0 && brandedPool.length > 0 && picked.length < n ? 1 : 0
  const take = (id: string): void => {
    picked.push(id)
    has.add(id)
  }
  // 不带品牌名的：每个方向轮流拿一条
  const byTopic = GEO_PROMPT_TOPICS.map((t) =>
    live.filter((p) => !has.has(p.id) && (p.topic ?? 'other') === t.id && p.branded !== true),
  )
  for (let round = 0; picked.length < n - reserve; round += 1) {
    let took = false
    for (const list of byTopic) {
      const p = list[round]
      if (p === undefined || picked.length >= n - reserve) continue
      take(p.id)
      took = true
    }
    if (!took) break
  }
  // 带品牌名的：先补留的那一个位置，不带的不够时再补，不超过上限
  for (const p of brandedPool) {
    if (picked.length >= n || branded >= cap) break
    take(p.id)
    branded += 1
  }
  return picked
}

/**
 * 新生成的候选里哪些是真新的：与已有的（**含归档的**）按归一后的字面比，见过的不再加——
 * 人删掉 / 改掉的那一句不会以「新的」身份回来。
 */
export function newPromptCandidates(
  existing: readonly GeoQuestion[],
  generated: readonly GeoQuestion[],
): GeoQuestion[] {
  const seen = new Set(existing.map((q) => normalizeQuery(q.text)))
  const ids = new Set(existing.map((q) => q.id))
  return generated.filter((q) => {
    const k = normalizeQuery(q.text)
    if (seen.has(k) || ids.has(q.id)) return false
    seen.add(k)
    return true
  })
}

/** 按方向分组（展示顺序；空的方向不出）。 */
export interface GeoPromptGroup {
  topic: GeoPromptTopic
  label_zh: string
  prompts: GeoQuestion[]
}

export function groupPromptsByTopic(prompts: readonly GeoQuestion[]): GeoPromptGroup[] {
  return GEO_PROMPT_TOPICS.map((t) => ({
    topic: t.id,
    label_zh: t.label_zh,
    prompts: prompts.filter((p) => (p.topic ?? 'other') === t.id),
  })).filter((g) => g.prompts.length > 0)
}
