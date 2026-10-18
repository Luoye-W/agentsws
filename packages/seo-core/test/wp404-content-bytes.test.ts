/**
 * WP404：规则表从 .ts 挪成数据文件前后，**判出来的东西一个字节不变**。
 *
 * 违规宣称表、GEO 候选句（几组品牌档案 × 中英）、Amazon 词库的切词 / 归一（停用词、单复数例外）
 * 逐项取哈希，和外置前记下的那一份比。真要改内容：`WP404_WRITE_FIXTURE=1` 重记，PR 里写明为什么。
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  BUILTIN_LISTING_RULES,
  extractPhrases,
  generatePromptCandidates,
  guessPromptTopic,
  MARKET_CLAIM_RULES,
  normalizeKeyword,
  resolveClaimRules,
  singularEn,
} from '../src/index.js'

const FIXTURE = fileURLToPath(new URL('./fixtures/wp404-content-bytes.json', import.meta.url))
const hash = (v: unknown): string =>
  createHash('sha256').update(JSON.stringify(v), 'utf8').digest('hex').slice(0, 16)

const SEEDS = [
  { brand: { name: 'Voltix', aliases: ['伏特'] }, language: 'zh' as const },
  {
    brand: { name: 'Voltix' },
    category: '充电宝',
    competitors: ['Anker', 'Baseus', 'Ugreen'],
    use_cases: ['露营', '出差', '通勤', '旅行'],
    language: 'zh' as const,
    top_queries: ['充电宝哪个牌子好', 'Voltix 怎么样', '露营用什么充电宝'],
  },
  {
    brand: { name: 'Voltix' },
    category: '充电宝',
    competitors: ['Anker'],
    language: 'zh' as const,
  },
  {
    brand: { name: 'Voltix' },
    category: 'power bank',
    competitors: ['Anker', 'Baseus'],
    use_cases: ['travel', 'camping'],
    language: 'en' as const,
    top_queries: ['best power bank for travel', 'voltix vs anker', 'how to choose a power bank'],
  },
  { brand: { name: 'Voltix' }, category: 'power bank', language: 'en' as const },
  { brand: { name: 'Voltix' }, language: 'en' as const },
]

const TEXTS = [
  'Voltix 20000mAh Power Bank, 65W Fast Charging Portable Chargers for the iPhone 15 and Samsung Galaxy, Batteries Included',
  'E-Bike Conversion Kit with 48V Batteries - Series of Accessories for Adults; Compatible with all Bikes (GPS Tracker Plus)',
  'Stainless Steel Water Bottles, Insulated Glasses Set of 4 pcs, Leak-Proof Lids, for Kids and Adults',
]
const WORDS = ['batteries', 'series', 'glasses', 'boxes', 'buses', 'lens', 'bikes', 'kits', 'news']

function snapshot(): Record<string, string> {
  const ctx = { language: 'en', brands: ['Voltix', 'Anker'] }
  return {
    claim_rules: hash(MARKET_CLAIM_RULES),
    claim_resolved_us_de: hash(resolveClaimRules({ markets: ['US', 'DE'], cards: [] })),
    claim_resolved_none: hash(resolveClaimRules({ markets: [], cards: [] })),
    geo_candidates: hash(SEEDS.map((s) => generatePromptCandidates(s))),
    geo_topics: hash(
      ['Anker vs Voltix', '性价比最高的充电宝', 'best budget charger', '露营适合用什么'].map((t) =>
        guessPromptTopic(t, { name: 'Voltix' }),
      ),
    ),
    kw_phrases: hash(TEXTS.map((t) => extractPhrases(t, ctx))),
    kw_normalize: hash(TEXTS.map((t) => normalizeKeyword(t))),
    kw_singular: hash(WORDS.map((w) => singularEn(w))),
    listing_rules: hash(BUILTIN_LISTING_RULES),
  }
}

describe('WP404 规则表外置前后逐字节相同', () => {
  it('违规宣称、GEO 候选句、Amazon 词库切词、Listing 规则与外置前一致', () => {
    const now = snapshot()
    if (process.env.WP404_WRITE_FIXTURE === '1' || !existsSync(FIXTURE))
      writeFileSync(FIXTURE, `${JSON.stringify(now, null, 2)}\n`, 'utf8')
    expect(now).toEqual(JSON.parse(readFileSync(FIXTURE, 'utf8')))
  })
})
