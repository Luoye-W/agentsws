/**
 * WP381 ②：robots.txt 挡没挡 AI 爬虫。
 *
 * 清单是**数据**（{@link DEFAULT_AI_CRAWLERS}），品牌可以在设置里加减（只存差异，默认清单更新照样跟上）。
 * 初版清单从开源项目 ai.robots.txt（github.com/ai-robots-txt/ai.robots.txt，MIT）的 `robots.json`
 * 与各家官方说明里挑出来，用途按我们自己的三类分：
 *
 * - `search`：进 AI 搜索 / AI 回答的索引——挡了它，那个 AI 就引不到你；
 * - `user`：用户在 AI 里问到你、AI 临时替他打开页面——挡了它，AI 打不开你的页；
 * - `training`：拿去训练模型——挡不挡是品牌自己的选择，不算错，只列出来。
 *
 * Googlebot 与 bingbot 也在清单里：Google AI 概览 / Gemini、Copilot 读的就是这两家的索引。
 *
 * 规则解析不自己写：用 `robots-parser`（MIT，按 RFC 9309 分组、最长匹配、Allow 优先）。
 */
import type { AiCrawler, AiCrawlerVerdict, SiteHealthListOverrides } from '@agentsws/contracts'
import robotsParserModule from 'robots-parser'

/** `robots-parser` 是 CommonJS（`module.exports = function`），它的类型声明在 NodeNext 下认不出默认导出。 */
interface ParsedRobots {
  isAllowed(url: string, ua?: string): boolean | undefined
  getMatchingLineNumber(url: string, ua?: string): number
}
const robotsParser = robotsParserModule as unknown as (url: string, txt: string) => ParsedRobots

/** 清单的版本（我们核对清单的日期）。 */
export const AI_CRAWLER_LIST_VERSION = '2026-10-17'

export const DEFAULT_AI_CRAWLERS: readonly AiCrawler[] = [
  { token: 'OAI-SearchBot', vendor: 'OpenAI', purpose: 'search', platform: 'ChatGPT' },
  { token: 'ChatGPT-User', vendor: 'OpenAI', purpose: 'user', platform: 'ChatGPT' },
  { token: 'GPTBot', vendor: 'OpenAI', purpose: 'training', platform: 'ChatGPT' },
  { token: 'Claude-SearchBot', vendor: 'Anthropic', purpose: 'search', platform: 'Claude' },
  { token: 'Claude-User', vendor: 'Anthropic', purpose: 'user', platform: 'Claude' },
  { token: 'ClaudeBot', vendor: 'Anthropic', purpose: 'training', platform: 'Claude' },
  { token: 'PerplexityBot', vendor: 'Perplexity', purpose: 'search', platform: 'Perplexity' },
  { token: 'Perplexity-User', vendor: 'Perplexity', purpose: 'user', platform: 'Perplexity' },
  { token: 'Googlebot', vendor: 'Google', purpose: 'search', platform: 'Google AI 概览 / Gemini' },
  { token: 'Google-Extended', vendor: 'Google', purpose: 'training', platform: 'Gemini' },
  { token: 'bingbot', vendor: 'Microsoft', purpose: 'search', platform: 'Copilot' },
  { token: 'Applebot', vendor: 'Apple', purpose: 'search', platform: 'Siri / Spotlight' },
  {
    token: 'Applebot-Extended',
    vendor: 'Apple',
    purpose: 'training',
    platform: 'Apple Intelligence',
  },
  { token: 'DuckAssistBot', vendor: 'DuckDuckGo', purpose: 'search', platform: 'DuckDuckGo' },
  { token: 'Amazonbot', vendor: 'Amazon', purpose: 'search', platform: 'Alexa' },
  { token: 'MistralAI-User', vendor: 'Mistral', purpose: 'user', platform: 'Le Chat' },
  { token: 'meta-externalagent', vendor: 'Meta', purpose: 'training', platform: 'Meta AI' },
  { token: 'CCBot', vendor: 'Common Crawl', purpose: 'training' },
  { token: 'Bytespider', vendor: 'ByteDance', purpose: 'training' },
]

/** 默认清单 + 品牌的加减（同名以品牌加的为准；减按名字，大小写不敏感）。 */
export function effectiveCrawlers(
  overrides: SiteHealthListOverrides = {},
  base: readonly AiCrawler[] = DEFAULT_AI_CRAWLERS,
): AiCrawler[] {
  const removed = new Set((overrides.crawlers_remove ?? []).map((t) => t.toLowerCase()))
  const added = overrides.crawlers_add ?? []
  const addedNames = new Set(added.map((c) => c.token.toLowerCase()))
  return [...base.filter((c) => !addedNames.has(c.token.toLowerCase())), ...added].filter(
    (c) => !removed.has(c.token.toLowerCase()),
  )
}

/** 默认抽查的路径（首页、商品、合集、政策页——AI 最常引的几类页）。 */
export const DEFAULT_CRAWLER_PATHS: readonly string[] = [
  '/',
  '/products/',
  '/collections/',
  '/policies/refund-policy',
]

export interface AiCrawlerCheckInput {
  /** `https://example.com`（不带结尾斜杠）。 */
  origin: string
  /**
   * robots.txt 原文。`''` = 站上没有 robots.txt（404，等于全放行）；
   * `undefined` = 这次没读到（全部记「没读到」，**不当成放行**）。
   */
  robots: string | undefined
  crawlers: readonly AiCrawler[]
  /** 抽查哪些路径（不给按 {@link DEFAULT_CRAWLER_PATHS}；可以带上真实的商品页路径）。 */
  paths?: readonly string[]
}

/** 每个爬虫一行结论。纯函数：同一份 robots 每次同一张表。 */
export function checkAiCrawlers(input: AiCrawlerCheckInput): AiCrawlerVerdict[] {
  const paths = input.paths ?? DEFAULT_CRAWLER_PATHS
  const lines = (input.robots ?? '').split(/\r?\n/)
  const parsed =
    input.robots === undefined
      ? undefined
      : robotsParser(`${input.origin}/robots.txt`, input.robots)
  return input.crawlers.map((c) => {
    const base = {
      token: c.token,
      vendor: c.vendor,
      purpose: c.purpose,
      ...(c.platform === undefined ? {} : { platform: c.platform }),
    }
    if (parsed === undefined) return { ...base, state: 'unknown' as const }
    const blocked: string[] = []
    let rule: string | undefined
    for (const path of paths) {
      const url = `${input.origin}${path}`
      if (parsed.isAllowed(url, c.token) === false) {
        blocked.push(path)
        if (rule === undefined) {
          const n = parsed.getMatchingLineNumber(url, c.token)
          const text = n > 0 ? lines[n - 1]?.trim() : undefined
          if (text !== undefined && text !== '') rule = `#${String(n)} ${text}`
        }
      }
    }
    if (blocked.length === 0) return { ...base, state: 'allowed' as const }
    return {
      ...base,
      state: blocked.length === paths.length ? ('blocked' as const) : ('partial' as const),
      blocked_paths: blocked,
      ...(rule === undefined ? {} : { rule }),
    }
  })
}

/**
 * 这一行算不算问题：搜索 / 替用户打开的被挡（整站或部分）是问题；训练用的被挡是品牌自己的选择。
 */
export function crawlerVerdictIsProblem(v: AiCrawlerVerdict): boolean {
  return v.purpose !== 'training' && (v.state === 'blocked' || v.state === 'partial')
}
