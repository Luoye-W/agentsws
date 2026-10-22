/**
 * WP449：**发布前质检的整套**（服务端 `gatePublish` 只调这一个）。
 *
 * 原来三道（事实对得上、数字有出处、没有违规宣称，`checkContentQuality`）之外，这一单加四样：
 *
 * | 哪样 | 挡不挡 |
 * |---|---|
 * | 引用核查（`citations.ts`）：外链里的数打开那一页看在不在 | 打不开 / 找不到 → 挡 |
 * | 市场版本（`localize.ts`）：给另一个市场的版本，货币 / 单位 / 数字 / 日期 / 称呼 | 不对 → 挡 |
 * | 竞品对比（`comparison.ts`）：贬低、比了却没出处 | 挡 |
 * | 「好不好被 AI 引用」（`citability.ts`） | **不挡**，只给建议 |
 *
 * 抓网页由调用方注入；其余全是规则，不调模型。
 */
import type { ContentClaimRule, ContentQualityResult, Iso8601 } from '@agentsws/contracts'
import { extractFigures } from '@agentsws/core'
import { citabilityLine, scoreAiCitability } from './citability.js'
import { type CitationFetch, checkCitations, citationLine } from './citations.js'
import { comparisonIssues } from './comparison.js'
import { contentBlocks, contentPlainText, contentSentences } from './content-text.js'
import {
  checkLocaleText,
  detectLanguage,
  type LocaleBrand,
  localizationTargets,
  marketsForLanguage,
} from './localize.js'
import { checkContentQuality, type FactLike, figureKnown } from './quality.js'

/** 「好不好被 AI 引用」低于多少分才把建议写到卡上（职责阈值 `ai_citability_advice_below`）。 */
export const DEFAULT_CITABILITY_ADVICE_BELOW = 70

export interface ReviewContentInput {
  body: string
  title?: string
  facts: readonly FactLike[]
  rules?: readonly ContentClaimRule[]
  now: Iso8601
  /** 品牌：名字（开头要点名）、自己的域名（链到自己不算出处）、竞品名单、语言与目标市场。 */
  brand: LocaleBrand & {
    name: string
    domains: readonly string[]
    competitors?: readonly string[]
    /** 品牌定了「您」还是「你」（不给 = 只查前后一致）。 */
    address?: 'formal' | 'informal'
  }
  /** 一个市场说什么语言（`@agentsws/contracts` 的 `marketLanguage`）。 */
  primaryLanguage(code: string): string | undefined
  /** 这篇写明了是哪种语言（卡上带了就用它；不给就按正文认）。 */
  language?: string
  /** 抓引用页（不给 = 引用没法查，卡上注明）。 */
  fetch?: CitationFetch
  /** 每篇最多查几个链接。 */
  maxLinks?: number
  /** 低于这个分才写建议。 */
  adviceBelow?: number
}

/** 跑整套。`passed` 只看挡的那几样；建议另放 `advice`。 */
export async function reviewContent(input: ReviewContentInput): Promise<ContentQualityResult> {
  const title = input.title !== undefined && input.title.trim() !== '' ? input.title : undefined
  const blocks = contentBlocks(input.body, title)
  const sentences = contentSentences(blocks)
  const own = input.brand.language.split('-')[0] ?? input.brand.language
  const language = (input.language ?? detectLanguage(contentPlainText(blocks)))?.split('-')[0]
  const foreign = language !== undefined && language !== own ? language : undefined
  const markets =
    foreign === undefined ? [] : marketsForLanguage(foreign, input.brand, input.primaryLanguage)
  const canFetch = input.fetch !== undefined

  const base = checkContentQuality({
    body: input.body,
    ...(title === undefined ? {} : { title }),
    facts: input.facts,
    ...(input.rules === undefined ? {} : { rules: input.rules }),
    now: input.now,
    ...(foreign === undefined ? {} : { language: foreign }),
    linkedFiguresChecked: canFetch,
    ourDomains: input.brand.domains,
  })
  const issues = [...base.issues]
  const advice: string[] = []

  // 引用核查
  const cited = await checkCitations({
    sentences,
    ourDomains: input.brand.domains,
    fetch: input.fetch,
    max: input.maxLinks,
  })
  if (cited !== undefined) {
    issues.push(...cited.issues)
    if (cited.summary.skipped > 0 || cited.summary.checked === 0)
      advice.push(citationLine(cited.summary))
  }

  // 市场版本
  if (foreign !== undefined) {
    if (markets.length === 0) {
      const targets = localizationTargets(input.brand, input.primaryLanguage)
      advice.push(
        targets.length === 0
          ? `这篇是 ${foreign} 写的，品牌档案里没配多市场：要发别的语言版，先在品牌档案里加上那个市场。`
          : `这篇是 ${foreign} 写的，品牌档案里没有说这种语言的市场（有的是 ${targets.map((t) => t.language).join('、')}）。`,
      )
    } else
      issues.push(
        ...checkLocaleText({
          sentences,
          language: foreign,
          markets,
          ...(input.brand.address === undefined ? {} : { address: input.brand.address }),
        }),
      )
  }

  // 竞品对比
  const known = figureKnown(input.facts, foreign)
  issues.push(
    ...comparisonIssues({
      sentences,
      competitors: input.brand.competitors ?? [],
      known,
      facts: input.facts,
      flagged: new Set(issues.map((i) => i.sentence)),
    }),
  )

  // 「好不好被 AI 引用」（只给建议）
  const knownFigures = new Set(
    input.facts.flatMap((f) => extractFigures(f.statement).map((x) => x.replace(/[,\s_]/g, ''))),
  )
  const score = scoreAiCitability({
    blocks,
    entities: [input.brand.name],
    knownFigures,
  })
  if (score.score < (input.adviceBelow ?? DEFAULT_CITABILITY_ADVICE_BELOW))
    advice.push(citabilityLine(score))

  return {
    ...base,
    passed: issues.length === 0,
    issues,
    ...(cited === undefined ? {} : { citations: cited.summary }),
    ai_citability: score,
    ...(foreign === undefined ? {} : { locale: { language: foreign, markets } }),
    ...(advice.length === 0 ? {} : { advice }),
  }
}
