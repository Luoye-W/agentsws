/**
 * WP386（docs/103 §3.3 第 1 步）：AI 先出「要建的 Google 提醒清单」——四组（自家 / 竞品 / 行业 / 指定网站）。
 *
 * 读品牌档案的竞品（WP349 联网查到的那些）和 GEO 关注的竞品（带别名），按目标市场定语言 / 地区，每条写清
 * Google 查询语句（`"Aventon" -job`、`"Aventon" OR "Aventon ebike"`）和一句理由。联网补别名和型号、问一次模型
 * 是**加料**（`research`），没有模型 / 搜不了网时按规则出（规则脑），清单照样出得来。
 *
 * 清单只是建议：用户在配置卡上改、清空（= 不建）、确认，确认后存成 `MonitorPlanItem`。
 */
import type { MonitorGroup, MonitorPlanItem } from '@agentsws/contracts'
import {
  fencedHits,
  jsonOf,
  MODEL_SOURCE,
  profileSource,
  type SetupBrandFacts,
  type SetupPlan,
  type SetupResearchKit,
  type SetupWebHit,
  webSource,
} from '../setup-research.js'

/** 卡上最多几行（一张卡一次批完；多了让人看不过来）。 */
export const MAX_PLAN_ROWS = 12

/** GEO 关注设置里读到的那几样（没有就是没有）。 */
export interface GeoWatchFacts {
  brand_aliases?: string[]
  competitors?: { name: string; aliases?: string[] }[]
  markets?: string[]
}

/** 清单上的一行草稿（还没存）。 */
export interface DraftItem {
  group: MonitorGroup
  label: string
  competitor?: string
  query: string
  language: string
  region: string
  why: string
  aliases: string[]
}

/** 市场（国家 / 地区码）→ Google Alerts 的语言。认不出就英文。 */
const LANG_OF: Readonly<Record<string, string>> = {
  US: 'en',
  GB: 'en',
  UK: 'en',
  CA: 'en',
  AU: 'en',
  NZ: 'en',
  IE: 'en',
  SG: 'en',
  IN: 'en',
  DE: 'de',
  AT: 'de',
  CH: 'de',
  FR: 'fr',
  BE: 'fr',
  ES: 'es',
  MX: 'es',
  IT: 'it',
  NL: 'nl',
  JP: 'ja',
  KR: 'ko',
  BR: 'pt',
  PT: 'pt',
  PL: 'pl',
  SE: 'sv',
  CN: 'zh-CN',
  TW: 'zh-TW',
  HK: 'zh-TW',
}

/** 「美国」「US」「United States」→ `US`（认不出回 `undefined`）。 */
export function regionCode(market: string): string | undefined {
  const m = market.trim()
  if (/^[A-Za-z]{2}$/u.test(m)) return m.toUpperCase() === 'UK' ? 'GB' : m.toUpperCase()
  const names: Record<string, string> = {
    美国: 'US',
    'united states': 'US',
    usa: 'US',
    英国: 'GB',
    'united kingdom': 'GB',
    加拿大: 'CA',
    canada: 'CA',
    澳大利亚: 'AU',
    australia: 'AU',
    德国: 'DE',
    germany: 'DE',
    法国: 'FR',
    france: 'FR',
    日本: 'JP',
    japan: 'JP',
    西班牙: 'ES',
    spain: 'ES',
    意大利: 'IT',
    italy: 'IT',
    荷兰: 'NL',
    netherlands: 'NL',
    欧洲: 'DE',
    europe: 'DE',
  }
  return names[m.toLowerCase()] ?? names[m]
}

const quote = (s: string): string => `"${s.replace(/"/gu, '').trim()}"`
const uniq = (list: readonly string[]): string[] => {
  const out: string[] = []
  for (const x of list) {
    const t = x.trim()
    if (t !== '' && !out.some((o) => o.toLowerCase() === t.toLowerCase())) out.push(t)
  }
  return out
}

/** 一个名字 + 别名 → Google 查询语句（`"Aventon" OR "Aventon ebike" -job`）。 */
export function queryFor(name: string, aliases: readonly string[] = []): string {
  const terms = uniq([name, ...aliases])
    .slice(0, 4)
    .map(quote)
  return `${terms.join(' OR ')} -job`
}

/**
 * 按档案出的清单（规则脑）：自家一条（每个主要语言一条）、每个竞品一条、品类一条。
 * 已经存着的清单（用户确认过的）优先：卡上回显它，不重新编。
 */
export function draftPlan(input: {
  facts: SetupBrandFacts
  geo?: GeoWatchFacts | undefined
  saved?: readonly MonitorPlanItem[]
}): DraftItem[] {
  if (input.saved !== undefined && input.saved.length > 0)
    return input.saved.slice(0, MAX_PLAN_ROWS).map((p) => ({
      group: p.group,
      label: p.label,
      ...(p.competitor === undefined ? {} : { competitor: p.competitor }),
      query: p.query,
      language: p.language,
      region: p.region,
      why: p.why,
      aliases: [],
    }))
  const { facts, geo } = input
  const markets = uniq([...(facts.markets ?? []), ...(geo?.markets ?? [])])
    .map(regionCode)
    .filter((x): x is string => x !== undefined)
  const regions = markets.length === 0 ? ['US'] : uniq(markets)
  const primary = regions[0] as string
  const out: DraftItem[] = []
  const name = facts.name?.trim()
  if (name !== undefined && name !== '') {
    const aliases = uniq([...(geo?.brand_aliases ?? []), ...(facts.keywords?.brand ?? [])]).filter(
      (a) => a.toLowerCase() !== name.toLowerCase(),
    )
    const langs = uniq(regions.map((r) => LANG_OF[r] ?? 'en')).slice(0, 3)
    for (const lang of langs) {
      const region = regions.find((r) => (LANG_OF[r] ?? 'en') === lang) ?? primary
      out.push({
        group: 'own',
        label: name,
        query: queryFor(name, aliases.slice(0, 2)),
        language: lang,
        region,
        why:
          langs.length > 1
            ? `外面怎么说我们（${region} 市场）`
            : '外面怎么说我们：新闻、博客、评测、论坛都算',
        aliases,
      })
    }
  }
  const comps = new Map<string, { name: string; aliases: string[]; why: string }>()
  for (const c of facts.competitors ?? [])
    comps.set(c.name.toLowerCase(), {
      name: c.name,
      aliases: [],
      why: c.reason === undefined || c.reason === '' ? '品牌档案里的竞品' : c.reason,
    })
  for (const c of geo?.competitors ?? []) {
    const k = c.name.toLowerCase()
    const had = comps.get(k)
    comps.set(k, {
      name: had?.name ?? c.name,
      aliases: uniq([...(had?.aliases ?? []), ...(c.aliases ?? [])]),
      why: had?.why ?? 'AI 搜索里一起出现的竞品',
    })
  }
  for (const c of comps.values())
    out.push({
      group: 'competitor',
      label: c.name,
      competitor: c.name,
      query: queryFor(c.name, c.aliases.slice(0, 2)),
      language: LANG_OF[primary] ?? 'en',
      region: primary,
      why: `竞品动向：${c.why}`,
      aliases: c.aliases,
    })
  const topic = facts.subcategory ?? facts.category
  if (topic !== undefined && topic.trim() !== '')
    out.push({
      group: 'industry',
      label: topic,
      query: `${quote(topic)} (recall OR lawsuit OR regulation OR tariff)`,
      language: LANG_OF[primary] ?? 'en',
      region: primary,
      why: '品类里的召回、诉讼、法规、关税会波及我们',
      aliases: [],
    })
  return out.slice(0, MAX_PLAN_ROWS)
}

/** 卡上那一格的值：`查询语句 ｜ en · US`（人改的时候也按这个写）。 */
export function rowValue(item: Pick<DraftItem, 'query' | 'language' | 'region'>): string {
  return `${item.query} ｜ ${item.language} · ${item.region}`
}

/** 卡上那一格 → 查询语句 + 语言 + 地区（没写语言地区就用草稿的）。空 = 不建这一条。 */
export function parseRowValue(
  raw: string,
  fallback: Pick<DraftItem, 'language' | 'region'>,
): { query: string; language: string; region: string } | undefined {
  const t = raw.trim()
  if (t === '') return undefined
  const [q, tail] = t.split(/\s*[｜]\s*/u)
  const query = (q ?? '').trim()
  if (query === '') return undefined
  const m = /^([a-z]{2}(?:-[A-Za-z]{2})?)\s*[·・.,，/\s]\s*([A-Za-z]{2}|any)$/u.exec(
    (tail ?? '').trim(),
  )
  return {
    query,
    language: m?.[1] ?? fallback.language,
    region: m?.[2] === undefined ? fallback.region : m[2] === 'any' ? 'any' : m[2].toUpperCase(),
  }
}

/**
 * 出卡前查一遍：联网补竞品的别名和型号（限次）、问一次模型整理；查不到就按规则出。
 * 回的是每一行 `alert_<n>` 的方案值 + 理由 + 来源。
 */
export async function researchPlan(
  kit: SetupResearchKit,
  drafts: readonly DraftItem[],
): Promise<SetupPlan> {
  const plan: SetupPlan = {}
  if (drafts.length === 0) {
    kit.note('品牌档案里没有品牌名、竞品和品类，列不出清单；你直接把 RSS 链接贴进来也行')
    return plan
  }
  const comps = drafts.filter((d) => d.group === 'competitor')
  kit.note(
    `看了品牌档案和 GEO 关注的竞品：自家 ${drafts.filter((d) => d.group === 'own').length} 条、竞品 ${comps.length} 个`,
    profileSource('竞品'),
  )
  const hits: SetupWebHit[] = []
  for (const c of comps.slice(0, 3)) {
    const got = await kit.search(`${c.label} models lineup`)
    if (got !== undefined) hits.push(...got)
  }
  if (hits.length > 0)
    kit.note(`联网查了竞品的型号和别名（${hits.length} 条结果）`, webSource(hits[0] as SetupWebHit))
  const prompt = [
    '给一个品牌做 Google Alerts 监控清单。下面每行是一条提醒草稿（key | 组 | 名字 | 查询语句）。',
    '只做一件事：按搜到的资料给竞品补 1–2 个常见别名或主力型号（只用资料里原样出现的写法），回 JSON：',
    '{"rows":{"alert_1":{"aliases":["…"]}}}。拿不准就不补。',
    ...drafts.map((d, i) => `alert_${i + 1} | ${d.group} | ${d.label} | ${d.query}`),
    hits.length === 0 ? '（没有搜到资料）' : fencedHits(hits),
  ].join('\n')
  const raw = hits.length === 0 ? undefined : await kit.ask(prompt)
  const rows = (jsonOf(raw)?.rows ?? {}) as Record<string, { aliases?: unknown }>
  if (raw !== undefined) kit.note('问了一次 AI，补上别名和型号', MODEL_SOURCE)
  drafts.forEach((d, i) => {
    const key = `alert_${i + 1}`
    const given = rows[key]?.aliases
    const extra = Array.isArray(given)
      ? (given as unknown[])
          .filter((a): a is string => typeof a === 'string')
          // 只认资料里原样出现过的（核对模型没编）
          .filter((a) => hits.some((h) => `${h.title ?? ''} ${h.snippet ?? ''}`.includes(a)))
      : []
    const aliases = uniq([...d.aliases, ...extra]).slice(0, 3)
    const query =
      d.group === 'industry' || aliases.length === d.aliases.length
        ? d.query
        : queryFor(d.label, aliases)
    plan[key] = {
      value: rowValue({ ...d, query }),
      why: extra.length > 0 ? `${d.why}；补了 ${extra.join('、')}` : d.why,
      sources:
        extra.length > 0
          ? [profileSource('竞品'), MODEL_SOURCE]
          : [profileSource(d.group === 'own' ? '品牌' : '竞品')],
    }
  })
  return plan
}
