/**
 * WP449（docs/109 §5.1 #5、#7、#8）：内容与博客的「多市场版本」技能，与 seo-judgment 新加的两节。
 *
 * 钉四件事：
 * - 格式：WP209 frontmatter、MIT、按 ## 切段、加载器吃得进去；出处写在正文第一行（钉着提交）；
 * - 登记：THIRD-PARTY-NOTICES 与 upstreams.yml 都写上了 claude-blog / claude-seo；
 * - content-localize：品牌档案里没配多市场不提；另发一篇（翻译接口还没授权）；单位按固定系数换、
 *   货币只写事实卡里的当地价、关键词按市场重挑、口号不直译；
 * - seo-judgment：对比页（指得回事实卡或公开页、不贬低、结构化数据只标自己）与「让 AI 答得出」五条。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { readBundledSkill, splitFrontmatter, splitSections } from '../src/index.js'
import { makeSkills } from './helpers.js'

const UPSTREAMS = readFileSync(
  fileURLToPath(new URL('../../../upstreams.yml', import.meta.url)),
  'utf8',
)
const NOTICES = readFileSync(
  fileURLToPath(new URL('../bundled/THIRD-PARTY-NOTICES', import.meta.url)),
  'utf8',
)
const CONTENT_YML = readFileSync(
  fileURLToPath(new URL('../../roles/roles/dtc/content.yml', import.meta.url)),
  'utf8',
)

describe('content-localize：格式与出处', () => {
  const skill = readBundledSkill('content-localize')
  const { frontmatter, body } = splitFrontmatter(skill.markdown)

  it('frontmatter：name / MIT / open / 版本；中英显示名与一句话；不写 positions（职责 yml 反查）', () => {
    expect(frontmatter.name).toBe('content-localize')
    expect(frontmatter.description?.length ?? 0).toBeGreaterThan(20)
    expect(frontmatter.extra.license).toBe('MIT')
    expect(frontmatter.extra.tier).toBe('open')
    expect(frontmatter.extra.version).toMatch(/^\d+\.\d+\.\d+$/)
    for (const key of ['display_name', 'display_name_en', 'summary', 'summary_en'])
      expect(frontmatter.extra[key]?.trim() ?? '').not.toBe('')
    expect(frontmatter.extra.positions).toBeUndefined()
  })

  it('出处写在正文第一行，钉着上游提交；FLOW 提示词没收', () => {
    const first = body.trim().split('\n')[0] ?? ''
    expect(first).toContain('改编自 AgriciDaniel/claude-blog（MIT，© 2025-2026 AgriciDaniel）')
    expect(first).toContain('354442348815a7f0327077ad89af2c43cf4b4ab4')
    expect(first).toContain('FLOW 提示词（CC BY 4.0）没有收')
  })

  it('按 ## 切段、段名唯一、不少于 8 段；加载器吃得进去', async () => {
    const headings = splitSections(body)
      .map((s) => s.heading)
      .filter((h) => h !== '')
    expect(headings.length).toBeGreaterThanOrEqual(8)
    expect(new Set(headings).size).toBe(headings.length)
    const { skills } = makeSkills()
    await skills.registry.putFromMarkdown({
      markdown: skill.markdown,
      tier: 'package',
      owner: 'package',
      version: '1.0.0',
      evals: skill.evals.map((e) => e.id),
    })
    const resolved = await skills.registry.resolve('content-localize', {
      person_id: 'p_1',
      workspace_id: 'ws_1',
      role_id: 'dtc.content',
    })
    for (const h of headings) expect(resolved?.markdown).toContain(`## ${h}`)
  })

  it('挂在内容与博客上（按需）；职责阈值里有引用核查上限与建议线', () => {
    expect(CONTENT_YML).toContain('- { name: content-localize, tier: open, load: on_demand }')
    expect(CONTENT_YML).toMatch(/citation_check_max_links: 10/)
    expect(CONTENT_YML).toMatch(/ai_citability_advice_below: 70/)
  })
})

describe('content-localize：规矩', () => {
  const md = readBundledSkill('content-localize').markdown

  it('没配多市场不提；人点名的市场先加进品牌档案', () => {
    expect(md).toContain('品牌档案里只有一个市场')
    expect(md).toContain('不提多语言')
    expect(md).toContain('品牌档案里还没有这个市场')
  })

  it('写法二选一写明了：现在另发一篇（同一份每日额度），翻译接口缺授权', () => {
    expect(md).toContain('在目标市场另发一篇')
    expect(md).toContain('每天 2 篇的额度')
    expect(md).toContain('店铺授权里还没有翻译那一项权限')
  })

  it('本地化七样都在：例子、单位、货币、称呼、法规口径、当地数据来源、号召用语', () => {
    for (const k of [
      '例子',
      '计量单位',
      '货币',
      '称呼与正式度',
      '当地法规口径',
      '当地能用的数据来源',
      '号召用语',
    ])
      expect(md).toContain(`| ${k} |`)
  })

  it('数不经估算：单位按固定系数、货币只写事实卡里的当地价、不现算汇率；关键词重挑、口号不直译', () => {
    expect(md).toContain('换算按固定系数从事实卡上的数算')
    expect(md).toContain('事实卡里没有当地价就不写价')
    expect(md).toContain('不拿汇率现算')
    expect(md).toContain('关键词按目标市场重挑')
    expect(md).toContain('品牌口号不直译')
  })

  it('没有真实联系方式（出处那一行的提交号除外）', () => {
    const rest = splitFrontmatter(md).body.trim().split('\n').slice(1).join('\n')
    expect(md).not.toMatch(/[\w.+-]+@[\w-]+\.[a-z]{2,}/i)
    expect(rest).not.toMatch(/\+?\d[\d\s-]{9,}\d/)
  })
})

describe('seo-judgment：WP449 新加的两节', () => {
  const md = readBundledSkill('seo-judgment').markdown
  const { frontmatter, body } = splitFrontmatter(md)

  it('版本升了（包层会被换掉）；出处第一行补上 claude-seo / claude-blog', () => {
    expect(frontmatter.extra.version).toBe('1.1.0')
    const first = body.trim().split('\n')[0] ?? ''
    expect(first).toContain('AgriciDaniel/claude-seo（MIT）')
    expect(first).toContain('AgriciDaniel/claude-blog（MIT）')
  })

  it('对比页：指得回事实卡或公开页、写日期、不贬低、结构化数据只标自己的商品', () => {
    const section = splitSections(body).find((s) => s.heading.startsWith('对比页'))
    expect(section).toBeDefined()
    const text = section?.body ?? ''
    expect(text).toContain('对比项必须指得回事实卡或公开可核的页面')
    expect(text).toContain('截至某日')
    expect(text).toContain('不贬低、不用绝对化词')
    expect(text).toContain('结构化数据只标我们自己的商品')
    expect(text).toContain('新页面选题卡')
  })

  it('让 AI 答得出：五条与 seo-core 的打分同一份说法', () => {
    for (const k of ['先给答案', '段落自足', '实体说清', '数字带出处', '能抽成列表 / 表格'])
      expect(md).toContain(`**${k}**`)
    expect(md).toContain('只给建议，不挡发布')
  })
})

describe('出处登记', () => {
  it('THIRD-PARTY-NOTICES：两家的许可证全文与钉住的提交', () => {
    expect(NOTICES).toContain('AgriciDaniel/claude-blog')
    expect(NOTICES).toContain('pinned commit 354442348815a7f0327077ad89af2c43cf4b4ab4')
    expect(NOTICES).toContain('AgriciDaniel/claude-seo')
    expect(NOTICES).toContain('pinned commit 4b99de2f7de7e7d5247042e5fb5b4ea9368ef734')
    expect(NOTICES).toMatch(/Used in: content-localize/)
    expect(NOTICES).toMatch(/Used in: seo-judgment \(the comparison-page section/)
  })

  it('upstreams.yml：两条 ported，盯着用到的几本', () => {
    expect(UPSTREAMS).toContain('  - id: claude-blog\n    kind: ported')
    expect(UPSTREAMS).toContain('  - id: claude-seo\n    kind: ported')
    for (const p of [
      'skills/blog-translate',
      'skills/blog-factcheck',
      'skills/blog-geo',
      'skills/seo-competitor-pages',
    ])
      expect(UPSTREAMS).toContain(`      - ${p}\n`)
    expect(UPSTREAMS).toContain('packages/skills/bundled/content-localize/SKILL.md')
  })
})
