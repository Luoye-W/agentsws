/**
 * WP348（决策 887）：Reddit 巡查配置卡的「怎么查」——出卡前先查、先定方案，人只确认。
 *
 * 查什么（每一步在时间线上留一行）：
 * - **品牌档案**：品牌名、品类、产品，WP346 的子品类、关键词三组、竞品、人群（有就用、没有就跳过）；
 * - **已连的数据**：插件里登着的 Reddit 号（品牌号**只认它或连接里登记的**，不让 AI 猜）、连接里登记的自家版；
 * - **联网搜索**（限次）：Reddit 上和品牌 / 品类 / 竞品相关的版块，数一数各出现几次；
 * - **问一次模型**：把上面这些整理成五样建议（自家版块、重点版块带频率、关键词、告警词、标签词）。
 *
 * 查不到：品牌号标「需要你填」（说清是插件没配对、没连 Reddit 还是没报上号）；
 * 别的格子空着（巡查只要版块和关键词有一样就能跑）。频率默认每天一次。
 */
import { normalizeSubreddit } from '@agentsws/browser-action'
import type { SetupSource } from '@agentsws/contracts'
import {
  DEFAULT_SOURCE,
  MODEL_SOURCE,
  profileSource,
  type SetupPlan,
  type SetupResearchKit,
  type SetupWebHit,
  webSource,
} from '../setup-research.js'
import { formatSubList, type SettingsSuggestions } from './settings.js'
import type { PatrolBrandBrief, PatrolSuggestion } from './suggest.js'

/** 插件那一侧现在怎样（品牌号只从这里来）。 */
export interface PatrolPluginState {
  state: 'unpaired' | 'not_connected' | 'connected'
  /** 插件最近一次读到的、Chrome 里登着的号。 */
  user?: string
}

export interface PatrolResearchInput {
  /** 连接里登记的自家版 / 品牌号（WP249）。 */
  registered(): SettingsSuggestions | undefined
  plugin(): PatrolPluginState
  /** 品牌档案里给巡查用的几格（含商品卡）。 */
  brief?(): Promise<PatrolBrandBrief | undefined> | PatrolBrandBrief | undefined
  /** 问一次模型（带上搜到的东西）；没模型回 `undefined`。 */
  suggest(
    brief: PatrolBrandBrief,
    ask: (prompt: string) => Promise<string | undefined>,
  ): Promise<PatrolSuggestion | undefined>
}

/** 版块名在搜到的东西里出现几次（网址里的 `/r/x`、标题 / 摘要里的 `r/x`）。 */
export function subsInHits(
  hits: readonly SetupWebHit[],
): { name: string; count: number; hit: SetupWebHit }[] {
  const seen = new Map<string, { name: string; count: number; hit: SetupWebHit }>()
  for (const h of hits) {
    const text = `${h.url} ${h.title ?? ''} ${h.snippet ?? ''}`
    const names = new Set<string>()
    for (const m of text.matchAll(/(?:^|[\s/(（"'])r\/([A-Za-z0-9_]{2,21})\b/gu)) {
      const n = normalizeSubreddit(m[1] ?? '')
      if (n !== undefined) names.add(n)
    }
    for (const n of names) {
      const k = n.toLowerCase()
      const cur = seen.get(k)
      if (cur === undefined) seen.set(k, { name: n, count: 1, hit: h })
      else cur.count += 1
    }
  }
  return [...seen.values()].sort((a, b) => b.count - a.count)
}

const CONNECTED_USER: SetupSource = { kind: 'connected', label: '插件里登着的 Reddit 号' }
const REGISTERED: SetupSource = { kind: 'connected', label: '连接里登记的 Reddit 号' }

const uniq = (list: readonly string[], max: number): string[] => {
  const out: string[] = []
  for (const x of list) {
    const t = x.trim()
    if (t !== '' && !out.some((o) => o.toLowerCase() === t.toLowerCase())) out.push(t)
  }
  return out.slice(0, max)
}

export async function researchPatrol(
  kit: SetupResearchKit,
  input: PatrolResearchInput,
): Promise<SetupPlan> {
  const plan: SetupPlan = {}
  const facts = await kit.profile()
  const brief0 = (await Promise.resolve(input.brief?.()).catch(() => undefined)) ?? {}
  const name = brief0.name ?? facts.name
  const topic =
    facts.subcategory ??
    facts.category ??
    brief0.category ??
    facts.keywords?.category[0] ??
    brief0.products?.[0]?.slice(0, 40)
  const competitors = facts.competitors ?? []
  const kw = facts.keywords

  // 1. 品牌档案
  const seenBits = [
    name,
    topic,
    kw === undefined ? undefined : `关键词 ${kw.brand.length + kw.category.length} 个`,
    competitors.length === 0 ? undefined : `竞品 ${competitors.length} 个`,
  ].filter((x): x is string => x !== undefined && x !== '')
  kit.note(
    seenBits.length === 0 ? '品牌档案还是空的' : `看了品牌档案：${seenBits.join(' · ')}`,
    profileSource('品牌'),
  )

  // 2. 已连的数据：品牌号只认插件里登着的 / 连接里登记的
  const plugin = input.plugin()
  const reg = input.registered() ?? {}
  if (plugin.user !== undefined) {
    plan.brand_username = {
      value: plugin.user,
      why: '插件里登着的就是这个号',
      sources: [CONNECTED_USER],
    }
    kit.note(`插件里登着的 Reddit 号：u/${plugin.user}`, CONNECTED_USER)
  } else if (reg.brand_username !== undefined) {
    plan.brand_username = {
      value: reg.brand_username,
      why: '连接里登记的品牌号',
      sources: [REGISTERED],
    }
    kit.note(`连接里登记的 Reddit 号：u/${reg.brand_username}`, REGISTERED)
  } else {
    const why =
      plugin.state === 'unpaired'
        ? '插件还没配对，看不到登着哪个号'
        : plugin.state === 'not_connected'
          ? '插件里还没连 Reddit，看不到登着哪个号'
          : '插件还没报上登着的号；空着也行，第一次巡查会记下登着的那个'
    plan.brand_username = { needs_you: true, why }
    kit.note(why)
  }

  // 3. 联网搜索（限次）：品牌、品类、竞品在 Reddit 上的版块
  const queries = uniq(
    [
      name === undefined ? '' : `site:reddit.com ${name}`,
      topic === undefined ? '' : `site:reddit.com ${topic} subreddit`,
      competitors.length === 0
        ? ''
        : `site:reddit.com ${competitors
            .slice(0, 3)
            .map((c) => c.name)
            .join(' OR ')}`,
    ],
    3,
  )
  const hits: SetupWebHit[] = []
  let searched = false
  for (const q of queries) {
    const got = await kit.search(q)
    if (got === undefined) continue
    searched = true
    hits.push(...got)
  }
  const found = subsInHits(hits)
  if (found.length > 0)
    kit.note(
      `搜了 Reddit 上的相关版块：${found
        .slice(0, 5)
        .map((f) => `r/${f.name}`)
        .join('、')}`,
      webSource(found[0]?.hit as SetupWebHit),
    )
  else
    kit.note(
      queries.length === 0
        ? '档案里没有品牌名 / 品类，没法搜'
        : searched
          ? '联网搜了，没搜到相关版块'
          : '这次搜不了网（联网搜索没开）',
    )
  const webOf = (sub: string): SetupSource[] => {
    const f = found.find((x) => x.name.toLowerCase() === sub.toLowerCase())
    return f === undefined ? [] : [webSource(f.hit)]
  }

  // 4. 问一次模型整理（档案 + 搜到的）
  const brief: PatrolBrandBrief = {
    ...brief0,
    ...(name === undefined ? {} : { name }),
    ...(brief0.one_liner === undefined && facts.one_liner !== undefined
      ? { one_liner: facts.one_liner }
      : {}),
    // WP346 的档案几格：宿主那份（brief0）已经带上就用它，没有再用通用档案里读到的
    ...(brief0.category === undefined && topic !== undefined ? { category: topic } : {}),
    ...(brief0.keywords === undefined && kw !== undefined ? { keywords: kw } : {}),
    ...(brief0.competitors === undefined && competitors.length > 0
      ? { competitors: competitors.map((c) => c.name) }
      : {}),
    ...(brief0.audience === undefined && facts.audience !== undefined
      ? {
          audience: [facts.audience.buyers ?? '', ...(facts.audience.concerns ?? [])]
            .filter((x) => x !== '')
            .join('；'),
        }
      : {}),
    ...(found.length === 0
      ? {}
      : { found_subs: found.slice(0, 12).map((f) => ({ name: f.name, count: f.count })) }),
  }
  const ai = await input.suggest(brief, (p) => kit.ask(p)).catch(() => undefined)
  if (ai !== undefined) kit.note('问了一次 AI，把上面这些整理成方案', MODEL_SOURCE)

  // 5. 拼方案：自家版块
  const regSubs = reg.own_subreddits ?? []
  const nameKey = (name ?? '').toLowerCase().replace(/[^a-z0-9]/gu, '')
  const ownFromSearch =
    nameKey.length < 3
      ? []
      : found.filter((f) => f.name.toLowerCase().includes(nameKey)).map((f) => f.name)
  if (regSubs.length === 0) {
    const own = ai?.own_subreddits.length ? ai.own_subreddits : ownFromSearch.slice(0, 2)
    if (own.length > 0)
      plan.own_subreddits = {
        value: own.join(', '),
        why: ai?.own_subreddits.length
          ? (ai.why.own_subreddits ?? '名字和品牌对得上')
          : '搜到的版块名和品牌对得上',
        sources: [...own.flatMap(webOf), ...(ai?.own_subreddits.length ? [MODEL_SOURCE] : [])],
      }
  }
  const ownKeys = new Set(
    [...regSubs, ...(plan.own_subreddits?.value?.split(', ') ?? [])].map((x) => x.toLowerCase()),
  )

  // 重点版块（带频率）：AI 的；没有 AI 就按搜到的次数（前两个每天，其余每周）
  let watch: { name: string; per_week?: number }[] = (ai?.watch_subreddits ?? []).filter(
    (w) => !ownKeys.has(w.name.toLowerCase()),
  )
  if (watch.length === 0)
    watch = found
      .filter((f) => !ownKeys.has(f.name.toLowerCase()))
      .slice(0, 6)
      .map((f, i) => (i < 2 ? { name: f.name } : { name: f.name, per_week: 1 }))
  if (watch.length > 0)
    plan.watch_subreddits = {
      value: formatSubList(
        watch.map((w) => w.name),
        Object.fromEntries(
          watch
            .filter((w) => w.per_week !== undefined)
            .map((w) => [w.name.toLowerCase(), w.per_week as number]),
        ),
      ),
      why:
        ai?.watch_subreddits.length && ai.why.watch_subreddits !== undefined
          ? ai.why.watch_subreddits
          : '品类、竞品的用户在这几个版；最相关的每天看，其余每周',
      sources: uniqSources([
        ...watch.flatMap((w) => webOf(w.name)),
        ...(ai?.watch_subreddits.length ? [MODEL_SOURCE] : []),
      ]),
    }

  // 关键词：档案的品牌词 / 品类词 + 竞品名，再补 AI 的
  const fromProfile = uniq(
    [
      ...(name === undefined ? [] : [name]),
      ...(kw?.brand ?? []),
      ...(kw?.category ?? []).slice(0, 2),
      ...competitors.slice(0, 3).map((c) => c.name),
    ],
    8,
  )
  const keywords = uniq([...fromProfile, ...(ai?.keywords ?? [])], 8)
  if (keywords.length > 0)
    plan.keywords = {
      value: keywords.join(', '),
      why:
        competitors.length > 0
          ? '品牌词、品类词，加上竞品名（看大家怎么比）'
          : (ai?.why.keywords ?? '品牌词和品类词'),
      sources: uniqSources([
        ...(kw === undefined && name === undefined ? [] : [profileSource('关键词')]),
        ...(competitors.length === 0 ? [] : [profileSource('竞品')]),
        ...(ai?.keywords.length ? [MODEL_SOURCE] : []),
      ]),
    }

  // 告警词 / 标签词：AI 按品类与产品给；没有就空着（不替人定规矩）
  if (ai !== undefined && ai.alert_words.length > 0)
    plan.alert_words = {
      value: ai.alert_words.join(', '),
      why: ai.why.alert_words ?? '出了就要马上看的',
      sources: [MODEL_SOURCE],
    }
  if (ai !== undefined && ai.tag_words.length > 0)
    plan.tag_words = {
      value: ai.tag_words.join(', '),
      why: ai.why.tag_words ?? '型号、产品线的写法',
      sources: [MODEL_SOURCE],
    }
  plan.every_hours = { value: '24', why: '默认每天一次', sources: [DEFAULT_SOURCE] }
  return plan
}

function uniqSources(list: readonly SetupSource[]): SetupSource[] {
  const out: SetupSource[] = []
  for (const s of list)
    if (!out.some((o) => o.kind === s.kind && o.label === s.label && o.url === s.url)) out.push(s)
  return out.slice(0, 4)
}
