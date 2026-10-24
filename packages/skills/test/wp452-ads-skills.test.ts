/**
 * WP452（docs/109 §5.2 #13、§6.3）：投放的两个新技能（改写自 claude-ads，MIT）。
 *
 * 钉：格式（frontmatter、MIT、按 ## 切段、加载器吃得进去）；出处在正文第一行、钉着提交；
 * 登记（THIRD-PARTY-NOTICES、upstreams.yml）；归因技能有「App 安装与应用内事件」一节且不接任何归因平台；
 * 两个技能挂在投放职责上（实验只给能改广告的老四家）。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { readBundledSkill, splitFrontmatter, splitSections } from '../src/index.js'
import { makeSkills } from './helpers.js'

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
const COMMIT = 'fc3908e786c318776df89a3a098333da377364be'

for (const name of ['ads-experiment', 'ads-attribution']) {
  describe(`${name}：格式与出处`, () => {
    const skill = readBundledSkill(name)
    const { frontmatter, body } = splitFrontmatter(skill.markdown)
    it('frontmatter：name / MIT / open / 版本 / 中英显示名', () => {
      expect(frontmatter.name).toBe(name)
      expect(frontmatter.extra.license).toBe('MIT')
      expect(frontmatter.extra.tier).toBe('open')
      for (const key of ['display_name', 'display_name_en', 'summary', 'summary_en'])
        expect(frontmatter.extra[key]?.trim() ?? '').not.toBe('')
    })
    it('出处在正文第一行，钉着上游提交；平台事实不抄', () => {
      const first = body.trim().split('\n')[0] ?? ''
      expect(first).toContain('改编自 AgriciDaniel/claude-ads（MIT，© 2026 Daniel Agrici）')
      expect(first).toContain(COMMIT)
    })
    it('按 ## 切段、段名唯一；加载器吃得进去', async () => {
      const headings = splitSections(body)
        .map((s) => s.heading)
        .filter((h) => h !== '')
      expect(headings.length).toBeGreaterThanOrEqual(5)
      expect(new Set(headings).size).toBe(headings.length)
      const { skills } = makeSkills()
      await skills.registry.putFromMarkdown({
        markdown: skill.markdown,
        tier: 'package',
        owner: 'package',
        version: '1.0.0',
        evals: skill.evals.map((e) => e.id),
      })
    })
  })
}

describe('登记与挂载', () => {
  it('THIRD-PARTY-NOTICES 与 upstreams.yml 都写上了 claude-ads', () => {
    expect(read('../bundled/THIRD-PARTY-NOTICES')).toContain(`pinned commit ${COMMIT}`)
    expect(read('../../../upstreams.yml')).toContain(`pinned_commit: ${COMMIT}`)
  })
  it('归因技能有 App 那一节，只讲判断、不接归因平台', () => {
    const md = readBundledSkill('ads-attribution').markdown
    expect(md).toContain('## App 安装与应用内事件')
    expect(md).toContain('不接任何归因平台')
    expect(md).toContain('品牌档案里「卖的是什么」填的是 App 时才讲这一节')
  })
  it('实验技能挂在老四家，归因技能十家都挂', () => {
    for (const p of ['meta', 'google', 'tiktok', 'x']) {
      const yml = read(`../../roles/roles/ads/${p}.yml`)
      expect(yml).toContain('name: ads-experiment')
      expect(yml).toContain('name: ads-attribution')
    }
    for (const p of ['microsoft', 'pinterest', 'reddit', 'linkedin', 'snapchat', 'apple']) {
      const yml = read(`../../roles/roles/ads/${p}.yml`)
      expect(yml).not.toContain('name: ads-experiment')
      expect(yml).toContain('name: ads-attribution')
    }
  })
})
