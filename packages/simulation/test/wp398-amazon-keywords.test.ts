/**
 * WP398（docs/106 §13 A8）：`amazon.keywords` 事件与 `amazon_keywords` 断言。
 *
 * - DSL 解析得出来，写错键名当场报；
 * - 跑一遍 3 人 pack 那条题：差距词按竞品数排、他牌名标出来、第二次第 5 页被拦就停；
 * - 断言真的会红。
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { runAmazonKeywordSample } from '../src/amazon-keywords.js'
import { parseScenario, runScenario } from '../src/index.js'
import { PACK_DIR, pack, runPackScenario } from './helpers.js'

const FILE = `${PACK_DIR}/scenarios/amazon/amazon-keyword-gaps.yml`

describe('DSL', () => {
  it('amazon.keywords 与 amazon_keywords 解析得出来；写错键名当场报', () => {
    const text = readFileSync(FILE, 'utf8')
    const s = parseScenario(text, 'x.yml')
    const evs = s.events.filter((e) => e.type === 'amazon.keywords')
    expect(evs.map((e) => (e.type === 'amazon.keywords' ? e.amazon_keywords : undefined))).toEqual([
      { who: 'p_li' },
      { who: 'p_li', blocked_at: 5 },
    ])
    expect(s.expected?.amazon_keywords?.autocomplete).toBe('blocked')
    expect(() => parseScenario(text.replace('blocked_at: 5', 'block_at: 5'), 'x.yml')).toThrow()
    expect(() =>
      parseScenario(text.replace('autocomplete: blocked', 'autocomplete: maybe'), 'x.yml'),
    ).toThrow()
  })
})

describe('样本：和服务进程同一份拆词 / 差距', () => {
  it('不被拦读完一批 27 页；被拦从那一页起停', () => {
    const ok = runAmazonKeywordSample()
    expect(ok).toMatchObject({ autocomplete: 'ok', seed: 'electric bike', pages_read: 27 })
    expect(ok.gaps.slice(0, 2)).toEqual([
      ['hydraulic disc brake', 3],
      ['removable battery', 3],
    ])
    const blocked = runAmazonKeywordSample({ blocked_at: 5 })
    expect(blocked).toMatchObject({ autocomplete: 'blocked', pages_read: 4 })
  })
})

describe('3 人 pack：Amazon 词库', () => {
  it('出差距词、标出他牌名、被拦就停', async () => {
    const { report, evidence } = await runPackScenario('amazon/amazon-keyword-gaps.yml')
    expect(report.expectations.filter((e) => !e.ok)).toEqual([])
    expect(report.passed).toBe(true)
    const evs = evidence.events.filter((e) => e.type === 'simulation.amazon_keywords')
    expect(evs).toHaveLength(2)
  })

  it('断言会红：期望写成 removable battery 排第一就不过', async () => {
    const text = readFileSync(FILE, 'utf8')
    const wrong = text.replace(
      'top_gaps: [hydraulic disc brake, removable battery, fat tire]',
      'top_gaps: [removable battery, hydraulic disc brake]',
    )
    expect(wrong).not.toBe(text)
    const report = await runScenario(parseScenario(wrong, 'x.yml'), { pack: pack() })
    expect(report.passed).toBe(false)
    expect(report.expectations.find((e) => e.key === 'amazon_keywords')?.ok).toBe(false)
  })
})
