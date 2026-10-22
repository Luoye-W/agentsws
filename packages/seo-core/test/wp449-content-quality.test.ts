/**
 * WP449（docs/109 §5.1 #5–8）：多语言、引用核查、「好不好被 AI 引用」打分、竞品对比。
 *
 * 引用页是录好的页面（`fixtures/wp449/*.html`），不联网；样稿是同一篇英文稿与它的两版德语稿。
 */
import { readFileSync } from 'node:fs'
import { marketLanguage } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import {
  type CitationFetch,
  checkCitations,
  checkContentQuality,
  checkLocaleText,
  comparisonIssues,
  contentBlocks,
  contentSentences,
  detectLanguage,
  type FactLike,
  figureKnown,
  isComparisonQuery,
  localizationTargets,
  marketsForLanguage,
  reviewContent,
  scoreAiCitability,
} from '../src/index.js'

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/wp449/${name}`, import.meta.url), 'utf8')

const NOW = '2026-10-22T00:00:00.000Z'

const FACTS: FactLike[] = [
  {
    id: 'f_cap',
    statement: 'The NordVolt Mag 10K has a capacity of 10,000 mAh.',
    terms: ['capacity'],
  },
  {
    id: 'f_w',
    statement: 'The NordVolt Mag 10K weighs 6.3 oz and is 0.6 inch thick.',
    terms: ['weighs'],
  },
  { id: 'f_t', statement: 'It works between 32°F and 95°F.' },
  { id: 'f_us', statement: 'The NordVolt Mag 10K costs $39.99 in the US store.' },
  { id: 'f_eu', statement: 'The NordVolt Mag 10K costs EUR 39.95 in the EU store.' },
  { id: 'f_war', statement: 'Warranty is 24 months.', terms: ['warranty', 'garantie'] },
  { id: 'f_out', statement: 'Wireless output is 15 W; the USB-C port delivers 20 W.' },
]

/** 录好的页面（没录的网址一律 404）。 */
const PAGES: Record<string, string> = {
  'https://research.example.org/charging-survey': fixture('charging-survey.html'),
  'https://lab.example.org/battery-aging': fixture('battery-aging.html'),
}
const recorded = (): { fetch: CitationFetch; calls: string[] } => {
  const calls: string[] = []
  return {
    calls,
    fetch: async (url) => {
      calls.push(url)
      const html = PAGES[url]
      return html === undefined
        ? { ok: false, reason: '这个页面不存在（404）' }
        : { ok: true, html }
    },
  }
}

const BRAND = {
  name: 'NordVolt',
  language: 'en',
  domains: ['nordvolt.example.com'],
  markets: ['US', 'DE'],
}
const split = (md: string) => {
  const [first, ...rest] = md.split('\n')
  return { title: (first ?? '').replace(/^#\s*/, ''), body: rest.join('\n') }
}

describe('拆块与切句：HTML / Markdown 都认，链接留在那一句上', () => {
  it('HTML：小标题、段落、列表、表格；链接里的网址不进正文', () => {
    const blocks = contentBlocks(
      '<h2>How fast?</h2><p>It charges at 15 W. See <a href="https://research.example.org/x?id=12345">the survey</a> for 42%.</p><ol><li>Step one</li></ol><table><tr><td>Output</td><td>15 W</td></tr></table>',
    )
    expect(blocks.map((b) => b.kind)).toEqual(['heading', 'paragraph', 'list_item', 'table_row'])
    expect(blocks[2]?.ordered).toBe(true)
    const s = contentSentences(blocks)
    expect(s.map((x) => x.text)).toContain('See the survey for 42%.')
    expect(s.find((x) => x.text.startsWith('See'))?.links).toEqual([
      'https://research.example.org/x?id=12345',
    ])
    expect(s.find((x) => x.text.startsWith('It charges'))?.links).toEqual([])
  })

  it('Markdown：[字](网址) 与裸网址；4.5 不在小数点处断句', () => {
    const s = contentSentences(
      contentBlocks(
        'Lasts 4.5 hours. Per [Example Lab](https://lab.example.org/a), 80% stay. More at https://lab.example.org/b.',
      ),
    )
    expect(s.map((x) => x.text)).toEqual([
      'Lasts 4.5 hours.',
      'Per Example Lab, 80% stay.',
      'More at https://lab.example.org/b.',
    ])
    expect(s[1]?.links).toEqual(['https://lab.example.org/a'])
    expect(s[2]?.links).toEqual(['https://lab.example.org/b'])
  })

  it('链接网址里的数字不再被当成「没出处的数」（以前直接切原文会报 12345）', () => {
    const r = checkContentQuality({
      body: '<p>Read <a href="https://research.example.org/report/12345">our notes</a>.</p>',
      facts: [],
      now: NOW,
    })
    expect(r.passed).toBe(true)
  })
})

describe('引用核查：打开引用页看那个数在不在（录好的页面）', () => {
  const sentencesOf = (body: string) => contentSentences(contentBlocks(body))

  it('数在页面上 → 过；页面上写的是 80%、稿子写 90% → 挡在那一句；打不开 → 挡', async () => {
    const { fetch, calls } = recorded()
    const out = await checkCitations({
      sentences: sentencesOf(
        [
          'According to a [2026 charging survey](https://research.example.org/charging-survey), 42% of people carry a power bank.',
          'Per [a battery study](https://lab.example.org/battery-aging), cells keep 90% of their capacity after 500 cycles.',
          'Details are in [the full report](https://gone.example.org/report).',
        ].join('\n\n'),
      ),
      ourDomains: ['nordvolt.example.com'],
      fetch,
    })
    expect(calls).toHaveLength(3)
    expect(out?.summary).toMatchObject({ links: 3, checked: 3, skipped: 0, verified: 1, max: 10 })
    const notFound = out?.issues.find((i) => i.rule === 'citation_not_found')
    expect(notFound?.sentence).toBe(
      'Per a battery study, cells keep 90% of their capacity after 500 cycles.',
    )
    expect(notFound?.detail).toContain('90%')
    expect(notFound?.detail).not.toContain('500') // 500 在页面上
    expect(notFound?.url).toBe('https://lab.example.org/battery-aging')
    const dead = out?.issues.find((i) => i.rule === 'citation_unreachable')
    expect(dead?.sentence).toBe('Details are in the full report.')
    expect(dead?.detail).toContain('404')
  })

  it('德语稿引英文页：42 % 与 42% 是同一个数；31 % 在表格里也认', async () => {
    const { fetch } = recorded()
    const out = await checkCitations({
      sentences: sentencesOf(
        'Laut [Umfrage](https://research.example.org/charging-survey) haben 42 % eine Powerbank dabei, 31 % wollen Magnet.',
      ),
      ourDomains: [],
      fetch,
    })
    expect(out?.issues).toEqual([])
    expect(out?.summary.verified).toBe(1)
  })

  it('每篇上限：12 个链接只查前 10 个，后 2 个注明没查；自己的域名不算引用', async () => {
    const { fetch, calls } = recorded()
    const body = [
      ...Array.from({ length: 12 }, (_, i) => `See [source ${i}](https://s${i}.example.org/page).`),
      'Our [product page](https://nordvolt.example.com/products/mag-10k) has 10,000 mAh.',
    ].join('\n\n')
    const out = await checkCitations({
      sentences: sentencesOf(body),
      ourDomains: BRAND.domains,
      fetch,
    })
    expect(calls).toHaveLength(10)
    expect(out?.summary).toMatchObject({ links: 12, checked: 10, skipped: 2 })
    const fewer = await checkCitations({
      sentences: sentencesOf(body),
      ourDomains: BRAND.domains,
      fetch,
      max: 3,
    })
    expect(fewer?.summary).toMatchObject({ checked: 3, skipped: 9, max: 3 })
  })

  it('内网 / IP / localhost 的网址不打开，算打不开', async () => {
    const { fetch, calls } = recorded()
    const out = await checkCitations({
      sentences: sentencesOf(
        'See [admin](http://192.168.1.1/stats) for 42%. And [x](http://intranet.local/a) too.',
      ),
      ourDomains: [],
      fetch,
    })
    expect(calls).toEqual([])
    expect(out?.issues.map((i) => i.rule)).toEqual(['citation_unreachable', 'citation_unreachable'])
  })

  it('没有外链的稿子：不出这一行', async () => {
    const out = await checkCitations({
      sentences: sentencesOf('Just 10,000 mAh.'),
      ourDomains: [],
      fetch: recorded().fetch,
    })
    expect(out).toBeUndefined()
  })
})

describe('多语言：英文稿 → 德国市场', () => {
  it('认语言；档案里 US + DE → 要出德语建议；只有 US（或 US + GB）→ 不出', () => {
    expect(detectLanguage(fixture('post-en.md'))).toBe('en')
    expect(detectLanguage(fixture('post-de-good.md'))).toBe('de')
    expect(localizationTargets(BRAND, (c) => marketLanguage(c))).toEqual([
      { language: 'de', markets: ['DE'] },
    ])
    expect(localizationTargets({ ...BRAND, markets: ['US'] }, (c) => marketLanguage(c))).toEqual([])
    expect(
      localizationTargets({ ...BRAND, markets: ['US', 'GB'] }, (c) => marketLanguage(c)),
    ).toEqual([])
    expect(
      marketsForLanguage('de', { ...BRAND, markets: ['US', 'DE', 'AT', 'CH'] }, (c) =>
        marketLanguage(c),
      ),
    ).toEqual(['DE', 'AT', 'CH'])
  })

  it('换了写法的数还是事实卡里那个数：10.000 / 4,5 / 179 g（6.3 oz）/ 1,5 cm（0.6 inch）/ 35 °C（95°F）/ 39,95 €', () => {
    const known = figureKnown(FACTS, 'de')
    for (const f of ['10.000', '179', '178,6', '1,5', '15', '35', '0', '39,95', '24'])
      expect(known(f)).toBe(true)
    // 换算错了、编的数：认不出
    for (const f of ['180,5', '2,5', '49,99']) expect(known(f)).toBe(false)
  })

  it('好的德语版：整套质检通过；单位、货币、称呼都对；引用页那个数在', async () => {
    const { title, body } = split(fixture('post-de-good.md'))
    const r = await reviewContent({
      title,
      body,
      facts: FACTS,
      now: NOW,
      brand: BRAND,
      primaryLanguage: (c) => marketLanguage(c),
      fetch: recorded().fetch,
    })
    expect(r.issues).toEqual([])
    expect(r.passed).toBe(true)
    expect(r.locale).toEqual({ language: 'de', markets: ['DE'] })
    expect(r.citations).toMatchObject({ checked: 1, verified: 1 })
  })

  it('偷懒的德语版：美元价、英制单位、英文小数与千位、Sie / du 混用，逐句挡下', async () => {
    const { title, body } = split(fixture('post-de-bad.md'))
    const r = await reviewContent({
      title,
      body,
      facts: FACTS,
      now: NOW,
      brand: BRAND,
      primaryLanguage: (c) => marketLanguage(c),
      fetch: recorded().fetch,
    })
    expect(r.passed).toBe(false)
    const locale = r.issues.filter((i) => i.rule === 'locale_mismatch')
    const say = locale.map((i) => i.detail).join('\n')
    expect(say).toContain('EUR')
    expect(say).toContain('公制')
    expect(say).toContain('「6,3」')
    expect(say).toContain('「10.000」')
    expect(say).toContain('称呼前后不一致')
    expect(locale.find((i) => i.detail.includes('EUR'))?.sentence).toBe(
      'Sie kostet $39.99 und hat 24 Monate Garantie.',
    )
  })

  it('品牌定了「du」：用「Sie」的那句报出来；型号里的小数（USB 3.2）不算英文写法', () => {
    const issues = checkLocaleText({
      sentences: [{ text: 'Mit USB 3.2 lädt du schnell.' }, { text: 'Dann können Sie loslegen.' }],
      language: 'de',
      markets: ['DE'],
      address: 'informal',
    })
    expect(issues).toHaveLength(1)
    expect(issues[0]?.sentence).toBe('Dann können Sie loslegen.')
  })

  it('档案里没有德语市场：德语稿不按德国卡人，只给一句建议', async () => {
    const { title, body } = split(fixture('post-de-good.md'))
    const r = await reviewContent({
      title,
      body,
      facts: FACTS,
      now: NOW,
      brand: { ...BRAND, markets: ['US'] },
      primaryLanguage: (c) => marketLanguage(c),
      fetch: recorded().fetch,
    })
    expect(r.issues.filter((i) => i.rule === 'locale_mismatch')).toEqual([])
    expect(r.advice?.join('\n')).toContain('没配多市场')
  })
})

describe('「好不好被 AI 引用」：三份样稿排序合理、每项说得出为什么', () => {
  const known = new Set(
    FACTS.flatMap((f) =>
      (f.statement.match(/\d[\d,.]*\d|\d/g) ?? []).map((x) => x.replace(/,/g, '')),
    ),
  )
  const score = (name: string) => {
    const { title, body } = split(fixture(name))
    return scoreAiCitability({
      blocks: contentBlocks(body, title),
      entities: ['NordVolt'],
      knownFigures: known,
    })
  }

  it('好 > 中 > 差；满分 100，五项分数加起来就是总分', () => {
    const good = score('score-good.md')
    const medium = score('score-medium.md')
    const poor = score('score-poor.md')
    expect(good.score).toBeGreaterThan(medium.score)
    expect(medium.score).toBeGreaterThan(poor.score)
    expect(good.score).toBeGreaterThanOrEqual(85)
    expect(poor.score).toBeLessThan(40)
    for (const s of [good, medium, poor]) {
      expect(s.checks.map((c) => c.id)).toEqual([
        'answer_first',
        'self_contained',
        'entity_clear',
        'figures_sourced',
        'extractable',
      ])
      expect(s.checks.reduce((a, c) => a + c.max, 0)).toBe(100)
      expect(s.checks.reduce((a, c) => a + c.points, 0)).toBe(s.score)
      for (const c of s.checks) expect(c.detail).not.toBe('')
    }
  })

  it('中等那份：问句开头、「This is」接上文、25 W 没出处——各扣在对应那一项，给得出下一步', () => {
    const m = score('score-medium.md')
    const by = Object.fromEntries(m.checks.map((c) => [c.id, c]))
    expect(by.answer_first?.points).toBeLessThan(25)
    expect(by.answer_first?.hint).toContain('开头')
    expect(by.self_contained?.hint).toContain('This is')
    expect(by.figures_sourced?.detail).toBe('2 句带数字，1 句指得回事实卡或链着出处')
  })

  it('不挡发布：分数低也照样 passed，建议写进 advice', async () => {
    const { title, body } = split(fixture('score-medium.md'))
    const r = await reviewContent({
      title,
      body: body.replace('25 W', '20 W'),
      facts: FACTS,
      now: NOW,
      brand: BRAND,
      primaryLanguage: (c) => marketLanguage(c),
    })
    expect(r.passed).toBe(true)
    expect(r.ai_citability?.score).toBeLessThan(70)
    expect(r.advice?.some((a) => a.startsWith('好不好被 AI 引用'))).toBe(true)
  })
})

describe('竞品对比：贬低挡、比了没出处挡、链了出处交给引用核查', () => {
  const sentences = (t: string) => contentSentences(contentBlocks(t))
  const known = figureKnown(FACTS)

  it('三种句子', () => {
    const issues = comparisonIssues({
      sentences: sentences(
        [
          'VoltMax is a scam compared to us.',
          'Unlike VoltMax, the NordVolt Mag 10K has a USB-C port.',
          'VoltMax lists 5,000 mAh on [its spec page](https://voltmax.example.org/spec).',
          'The NordVolt Mag 10K has 10,000 mAh, VoltMax is also a good choice.',
        ].join(' '),
      ),
      competitors: ['VoltMax'],
      known,
      facts: FACTS,
    })
    expect(issues.map((i) => [i.rule, i.sentence])).toEqual([
      ['comparison_disparaging', 'VoltMax is a scam compared to us.'],
      ['comparison_unsourced', 'Unlike VoltMax, the NordVolt Mag 10K has a USB-C port.'],
    ])
  })

  it('有一张卡在讲这个竞品、数都在卡上 → 过（对比项指得回事实卡）', () => {
    const facts = [
      ...FACTS,
      {
        id: 'f_vm',
        statement: 'VoltMax Slim lists 5,000 mAh on its spec sheet (checked 2026-10-01).',
      },
    ]
    const s = sentences(
      'The NordVolt Mag 10K holds 10,000 mAh, twice the 5,000 mAh of the VoltMax Slim.',
    )
    expect(
      comparisonIssues({
        sentences: s,
        competitors: ['VoltMax'],
        known: figureKnown(facts),
        facts,
      }),
    ).toEqual([])
    expect(
      comparisonIssues({
        sentences: s,
        competitors: ['VoltMax'],
        known: figureKnown(FACTS),
        facts: FACTS,
      }),
    ).toHaveLength(1)
  })

  it('竞品名单是空的就不查；SEO 认得出对比类查询', () => {
    expect(
      comparisonIssues({ sentences: sentences('VoltMax is junk.'), competitors: [], known }),
    ).toEqual([])
    for (const q of [
      'nordvolt vs voltmax',
      'voltmax alternative',
      'powerbank vergleich',
      '充电宝哪个好',
      'voltmax 平替',
    ])
      expect(isComparisonQuery(q)).toBe(true)
    expect(isComparisonQuery('best magnetic power bank')).toBe(false)
  })
})
