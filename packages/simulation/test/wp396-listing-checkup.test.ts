/**
 * WP396（docs/106 §13）：`listing.check` 事件与 `listing_checkup` 断言。
 *
 * - DSL：解析得出来，写错键名当场报；
 * - 跑 3 人 pack 那条题：体检出 3 处问题（每处带出处）、标题给草稿、被拦后不再读、点了下到设计岗；
 * - 断言真的会红：期望写错就不过。
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseScenario, runScenario } from '../src/index.js'
import { PACK_DIR, pack, runPackScenario } from './helpers.js'

const FILE = 'amazon/listing-checkup.yml'

describe('DSL', () => {
  it('listing.check 与 listing_checkup 解析得出来；写错键名当场报', () => {
    const text = readFileSync(`${PACK_DIR}/scenarios/${FILE}`, 'utf8')
    const s = parseScenario(text, 'x.yml')
    const ev = s.events.find((e) => e.type === 'listing.check')
    const check = ev?.type === 'listing.check' ? ev.listing_check : undefined
    expect(check?.pages).toHaveLength(3)
    expect(check?.blocked).toBe(2)
    expect(check?.design).toBe(true)
    expect(check?.pages[1]?.stock).toBe('out_of_stock')
    expect(s.expected?.listing_checkup?.issues).toEqual([
      'title.promo_words',
      'images.min_count',
      'offer.in_stock',
    ])
    expect(() => parseScenario(text.replace('images: 3', 'imgs: 3'), 'x.yml')).toThrow()
    expect(() =>
      parseScenario(text.replace('stopped: blocked', 'stopped: quota'), 'x.yml'),
    ).toThrow(/blocked/)
  })
})

describe('3 人 pack：体检出 3 处问题、给草稿、下设计需求单', () => {
  it('每处带出处；被拦那页起不读；需求单从亚马逊店铺运营下到设计岗', async () => {
    const { report, evidence } = await runPackScenario(FILE)
    expect(report.passed).toBe(true)
    const reads = evidence.events
      .filter((e) => e.type === 'simulation.listing_read')
      .map((e) => (e.payload as { asin: string; status: string }).status)
    expect(reads).toEqual(['ok', 'ok', 'blocked'])
    const issues = evidence.events
      .filter((e) => e.type === 'simulation.listing_issue')
      .map((e) => e.payload as { source: string; draft: boolean; design_request: boolean })
    expect(issues).toHaveLength(3)
    for (const i of issues) expect(i.source).not.toBe('')
    expect(issues.some((i) => i.draft)).toBe(true)
    expect(issues.some((i) => i.design_request)).toBe(true)
  })

  it('断言会红：期望写成 4 处就不过', async () => {
    const text = readFileSync(`${PACK_DIR}/scenarios/${FILE}`, 'utf8')
    const wrong = text.replace(
      'issues: [title.promo_words, images.min_count, offer.in_stock]',
      'issues: [title.promo_words, images.min_count, images.video, offer.in_stock]',
    )
    expect(wrong).not.toBe(text)
    const report = await runScenario(parseScenario(wrong, 'x.yml'), { pack: pack() })
    expect(report.passed).toBe(false)
    expect(report.expectations.find((e) => e.key === 'listing_checkup')?.ok).toBe(false)
  })
})
