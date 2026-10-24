/**
 * WP450（docs/109 §5.2 #9–11、17）：主题簇（按搜索结果重叠度）、日历排法、外链体检（录好的回包）、llms.txt、改写成社媒稿。
 * 全是规则，同输入同输出；数一个不经模型手。
 */
import { describe, expect, it } from 'vitest'
import {
  auditBacklinks,
  BACKLINK_SAMPLE_COMPETITORS,
  BACKLINK_SAMPLE_PREVIOUS,
  BACKLINK_SAMPLE_ROWS,
  BACKLINK_SAMPLE_SUMMARY,
  backlinkGapBrief,
  backlinkRowsOf,
  backlinkSummaryOf,
  buildLlmsTxt,
  checkLlmsTxt,
  cleanRepurpose,
  clusterBrief,
  keywordIntent,
  llmsKnownPaths,
  llmsStructureFromUrls,
  PLAN_SAMPLE_KEYWORDS,
  PLAN_SAMPLE_SERPS,
  planClusters,
  repurposeFromModel,
  repurposeRules,
  scheduleCluster,
  serpOverlap,
} from '../src/index.js'

const plan = () =>
  planClusters({
    keywords: PLAN_SAMPLE_KEYWORDS,
    serps: PLAN_SAMPLE_SERPS,
    brand_terms: ['nordvolt'],
    id: 'cl_test',
  })

describe('WP450 主题簇：按搜索结果重叠度分组', () => {
  it('意图按词面认，品牌词算导航', () => {
    expect(keywordIntent('how many watts to charge a laptop')).toBe('informational')
    expect(keywordIntent('best usb c charger')).toBe('commercial')
    expect(keywordIntent('buy gan charger')).toBe('transactional')
    expect(keywordIntent('nordvolt charger', ['nordvolt'])).toBe('navigational')
    expect(keywordIntent('usb c charger')).toBe('unknown')
  })

  it('重叠数去掉协议、www、结尾斜杠', () => {
    expect(
      serpOverlap(['https://www.a.example/x/', 'https://b.example/y'], ['http://a.example/x']),
    ).toBe(1)
  })

  it('样本出一组：总页 + 两个小组 + 内链矩阵；品牌词与不重叠的词照实排除', () => {
    const { clusters, excluded } = plan()
    expect(clusters).toHaveLength(1)
    const c = clusters[0]
    if (c === undefined) throw new Error('没出簇')
    // 总页：和别的词重叠最多、量最大；重叠 7 的「best usb c charger」并进同一篇
    expect(c.pillar.keyword).toBe('usb c charger')
    expect(c.pillar.also).toEqual(['best usb c charger'])
    expect(c.pillar.title).toBe('Usb C Charger: The Complete Guide')
    expect(c.spokes.map((s) => s.keyword)).toEqual([
      'gan charger',
      'usb c laptop charger 100w',
      'how many watts to charge a laptop with usb c',
      'gan charger vs regular charger',
    ])
    // 已经排上的词：回头改那一页，不另写
    const gan = c.spokes.find((s) => s.keyword === 'gan charger')
    expect(gan?.kind).toBe('refresh')
    expect(gan?.existing_page).toContain('gan-chargers-explained')
    // 小组：GaN 两篇和总页一组（重叠 ≥ 4），笔记本瓦数两篇另一组
    const groupOf = (k: string) => c.spokes.find((s) => s.keyword === k)?.group
    expect(groupOf('gan charger')).toBe(c.pillar.group)
    expect(groupOf('usb c laptop charger 100w')).toBe(
      groupOf('how many watts to charge a laptop with usb c'),
    )
    expect(groupOf('usb c laptop charger 100w')).not.toBe(c.pillar.group)
    // 每篇分页 ↔ 总页都有链接
    for (const s of c.spokes) {
      expect(c.links).toContainEqual({
        from: s.id,
        to: 'pillar',
        anchor: 'usb c charger',
        type: 'mandatory',
      })
      expect(c.links).toContainEqual({
        from: 'pillar',
        to: s.id,
        anchor: s.keyword,
        type: 'mandatory',
      })
    }
    expect(c.links.some((l) => l.type === 'sibling')).toBe(true)
    expect(c.overlap[0]).toEqual({
      a: 'gan charger',
      b: 'gan charger vs regular charger',
      shared: 6,
    })
    expect(excluded).toContainEqual({
      keyword: 'nordvolt charger',
      reason: '品牌 / 导航类的词，不写新页',
    })
    expect(excluded.map((e) => e.keyword)).toContain('travel charger with multiple ports')
  })

  it('凑不够三篇不出', () => {
    const r = planClusters({
      keywords: PLAN_SAMPLE_KEYWORDS.slice(6),
      serps: PLAN_SAMPLE_SERPS,
      id: 'x',
    })
    expect(r.clusters).toHaveLength(0)
  })

  it('排日历：总页先写，每天最多 2 篇，排满的日子跳过', () => {
    const c = plan().clusters[0]
    if (c === undefined) throw new Error('没出簇')
    const s = scheduleCluster(c, {
      start: '2026-10-26',
      per_day: 2,
      taken: new Map([['2026-10-27', 2]]),
    })
    expect(s[0]).toEqual({ post_id: 'pillar', date: '2026-10-26' })
    expect(s.map((x) => x.date)).toEqual([
      '2026-10-26',
      '2026-10-26',
      '2026-10-28',
      '2026-10-28',
      '2026-10-29',
    ])
    const brief = clusterBrief(c, c.pillar).join('\n')
    expect(brief).toContain('总页')
    expect(brief).toContain('「gan charger」')
  })
})

describe('WP450 外链体检：录好的回包', () => {
  const ours = backlinkSummaryOf(BACKLINK_SAMPLE_SUMMARY.items, '2026-10-20T03:00:00.000Z')
  const rows = backlinkRowsOf(BACKLINK_SAMPLE_ROWS.items)
  const competitors = new Map(
    [...BACKLINK_SAMPLE_COMPETITORS].map(([d, r]) => [d, backlinkRowsOf(r.items)]),
  )
  const result = auditBacklinks({
    ...(ours === undefined ? {} : { ours }),
    previous: BACKLINK_SAMPLE_PREVIOUS,
    rows,
    competitors,
    brand_terms: ['nordvolt'],
    our_domains: ['shop.example'],
    keywords: ['usb c charger', 'gan charger'],
  })

  it('来源域名变化、锚文本集中、可疑来源', () => {
    expect(ours?.referring_domains).toBe(142)
    expect(rows).toHaveLength(30)
    expect(result.change).toEqual({ referring_domains: -39, pct: -21.5 })
    const rules = result.issues.map((i) => `${i.rule}:${i.severity}`)
    expect(rules).toContain('domains_drop:high')
    expect(rules).toContain('anchor_concentration:high')
    expect(rules).toContain('exact_anchor_high:high')
    expect(rules).toContain('suspicious_sources:high')
    expect(rules).toContain('single_domain_heavy:medium')
    expect(rules).not.toContain('spam_score_high:medium')
    expect(result.issues[0]?.severity).toBe('high')
    expect(result.anchors[0]).toMatchObject({ anchor: 'usb c charger', kind: 'exact', count: 17 })
    expect(result.anchors.find((a) => a.anchor === 'NordVolt Gear')?.kind).toBe('brand')
    expect(result.anchors.find((a) => a.anchor === 'click here')?.kind).toBe('generic')
    expect(result.suspicious).toEqual([
      { domain: 'linkfarm-seo.example', why: '垃圾分 74（估算）' },
    ])
  })

  it('竞品有而我们没有：两家都链的排前面，可疑与已链我们的不算，最多 10 个', () => {
    expect(result.gap).toHaveLength(10)
    expect(result.gap.slice(0, 4).map((g) => g.domain)).toEqual([
      'techradar-like.example',
      'outdoor-lab.example',
      'laptop-mag.example',
      'vanlife-notes.example',
    ])
    const domains = result.gap.map((g) => g.domain)
    expect(domains).not.toContain('spammy-dir.example')
    expect(domains).not.toContain('gadget-blog.example')
    const brief = backlinkGapBrief(result.gap).join('\n')
    expect(brief).toContain('不买链接')
    expect(brief).not.toMatch(/dataforseo|semrush|ahrefs/i)
  })
})

describe('WP450 llms.txt', () => {
  const origin = 'https://shop.example'
  const urls = [
    `${origin}/collections/chargers`,
    `${origin}/collections/cables`,
    `${origin}/products/usb-c-65w-charger`,
    `${origin}/blogs/guide/gan-chargers-explained`,
    `${origin}/pages/about`,
  ]
  const s = llmsStructureFromUrls({
    name: 'NordVolt Gear',
    summary: 'USB-C chargers and cables.',
    origin,
    urls,
  })
  const draft = buildLlmsTxt(s, '2026-10-25T00:00:00.000Z')

  it('按店铺结构生成：H1、摘要、合集 / 商品 / 政策 / 文章，Optional 放独立页', () => {
    expect(draft.content.startsWith('# NordVolt Gear\n\n> USB-C chargers and cables.')).toBe(true)
    expect(draft.content).toContain('- [Chargers](https://shop.example/collections/chargers)')
    expect(draft.content).toContain('## Policies & help')
    expect(draft.content).toContain('(https://shop.example/policies/refund-policy)')
    expect(draft.content).toContain('## Optional')
    expect(draft.sections.map((x) => x.title)).toEqual([
      'Collections',
      'Products',
      'Policies & help',
      'Guides',
      'Optional',
    ])
  })

  it('体检那一项：没有 / 回网页 / 合格 / 过时 / Shopify 自己生成的', () => {
    const expected = [...s.collections, ...s.policies].map((l) => l.url)
    const known = llmsKnownPaths(urls, origin)
    const check = (fetched: Parameters<typeof checkLlmsTxt>[0]['fetched']) =>
      checkLlmsTxt({ url: `${origin}/llms.txt`, origin, fetched, expected, known, at: 'T' })
    expect(check({ status: 404 }).state).toBe('missing')
    expect(check(undefined).state).toBe('unknown')
    expect(
      check({ status: 200, body: '<!doctype html><html>', content_type: 'text/html' }).state,
    ).toBe('invalid')
    expect(check({ status: 200, body: draft.content }).state).toBe('current')
    const old = `${draft.content.replace(/- \[Cables\][^\n]+\n/, '')}- [Old](https://shop.example/collections/discontinued)\n`
    const stale = check({ status: 200, body: old })
    expect(stale.state).toBe('stale')
    expect(stale.missing_links).toEqual(['https://shop.example/collections/cables'])
    expect(stale.dead_links).toEqual(['https://shop.example/collections/discontinued'])
    const shopify = check({
      status: 200,
      body: '# NordVolt Gear\n\n> Agent-discovery summary. Full description at https://shop.example/agents.md\n\n- [Sitemap](https://shop.example/sitemap.xml)\n',
    })
    expect(shopify).toMatchObject({ state: 'current', generated_by: 'shopify' })
    expect(shopify.reasons[0]).toContain('Shopify 自动生成')
  })
})

describe('WP450 改写成社媒稿：只起草，不编经历与数字', () => {
  const article = {
    title: 'How to choose a USB-C charger',
    body: '<p>Most laptops need 65W or more.</p><h2>Check the wattage</h2><p>A 65W charger covers most 13-inch laptops.</p><h2>Look for GaN</h2><p>GaN chargers run cooler and are smaller.</p>',
    url: 'https://shop.example/blogs/guide/how-to-choose-a-usb-c-charger',
    brand: 'NordVolt Gear',
  }

  it('规则版：X 每条 ≤ 280、带原文链接；LinkedIn 留真实经历占位；Reddit 提醒版规并说明身份；短视频有钩子', () => {
    const x = repurposeRules(article, 'x')
    expect(x.parts?.length).toBe(4)
    for (const p of x.parts ?? []) expect(p.length).toBeLessThanOrEqual(280)
    expect(x.text).toContain(
      'Full post: https://shop.example/blogs/guide/how-to-choose-a-usb-c-charger',
    )
    expect(x.removed).toEqual([])
    const li = repurposeRules(article, 'linkedin')
    expect(li.placeholders[0]).toContain('YOUR REAL EXPERIENCE')
    const rd = repurposeRules(article, 'reddit')
    expect(rd.text).toContain('Check the subreddit rules first')
    expect(rd.text).toContain('I work at NordVolt Gear')
    const sv = repurposeRules(article, 'short_video')
    expect(sv.text).toContain('[0–3s HOOK]')
    expect(sv.text).toContain('[BEAT 1] Check the wattage')
  })

  it('模型回文里原文没有的数整句拿掉、编的亲身经历换成占位', () => {
    const raw =
      'A 65W charger covers most 13-inch laptops.\nIt charges 3x faster than old bricks.\n\nI tested 12 chargers over 3 months and this one won.'
    const d = repurposeFromModel(article, 'x', raw)
    expect(d.text).toContain('A 65W charger covers most 13-inch laptops.')
    expect(d.text).not.toContain('3x faster')
    expect(d.text).not.toContain('I tested')
    expect(d.placeholders[0]).toContain('YOUR REAL EXPERIENCE')
    expect(d.removed.length).toBeGreaterThanOrEqual(2)
    const zh = cleanRepurpose('我们测试了一个月，效果很好。', {
      title: '怎么选充电器',
      body: '先看功率。',
    })
    expect(zh.text).toContain('你的真实经历')
  })
})
