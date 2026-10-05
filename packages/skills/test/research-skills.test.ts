/**
 * WP220：两份研究技能（`trend-research` 给公共关系、`social-research` 给社媒运营）。
 *
 * 钉五件事：
 * - 格式：WP209 frontmatter、MIT、按 ## 切段、加载器吃得进去；
 * - 出处：正文第一行写明改编自谁（MIT 要保留版权声明），危机说明那一节另写 agency-agents；
 *   THIRD-PARTY-NOTICES 与 upstreams.yml 都登记了；
 * - 取数：只走许可的口，Reddit 两路（接口中台 → 浏览器只读），绝不用品牌发帖会话；没取到 ≠ 0 条；
 * - 产出：报告带出处与时间、按话题 / 情绪 / 平台分组；卡最多三张、只有两种；
 * - 危机说明：五格、不说「无可奉告」、不承诺、不写完成式。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  BUNDLED_SKILLS_DIR,
  findAuthorizationPhrases,
  readBundledSkill,
  splitFrontmatter,
  splitSections,
} from '../src/index.js'
import { makeSkills } from './helpers.js'

const ATTRIBUTION: Record<string, string[]> = {
  'trend-research': [
    '改编自 mvanhorn/last30days-skill（MIT，© 2026 Matt Van Horn）',
    'msitarzewski/agency-agents（MIT，© 2025 AgentLand Contributors）',
  ],
  'social-research': [
    '改编自 ScrapeCreators/social-media-research-skills（MIT，© 2026 ScrapeCreators）',
  ],
}

const UPSTREAMS = readFileSync(
  fileURLToPath(new URL('../../../upstreams.yml', import.meta.url)),
  'utf8',
)

describe('WP220 两份研究技能：格式与出处', () => {
  for (const [name, lines] of Object.entries(ATTRIBUTION)) {
    describe(name, () => {
      const skill = readBundledSkill(name)
      const { frontmatter, body } = splitFrontmatter(skill.markdown)

      it('frontmatter：name 与目录一致；MIT / open / 版本；中英显示名与一句话', () => {
        expect(frontmatter.name).toBe(name)
        expect(frontmatter.description?.length ?? 0).toBeGreaterThan(20)
        expect(frontmatter.extra.license).toBe('MIT')
        expect(frontmatter.extra.tier).toBe('open')
        expect(frontmatter.extra.version).toMatch(/^\d+\.\d+\.\d+$/)
        for (const key of ['display_name', 'display_name_en', 'summary', 'summary_en'])
          expect(frontmatter.extra[key]?.trim() ?? '').not.toBe('')
        // 归哪个岗位由职责 yml 的 skills: 反查（不写 positions，不进「通用」）
        expect(frontmatter.extra.positions).toBeUndefined()
      })

      it('出处写在正文第一行', () => {
        const first = body.trim().split('\n')[0] ?? ''
        for (const line of lines) expect(first).toContain(line)
        expect(first).toContain('取数层整个换成 Agents 工坊自己的口')
      })

      it('按 ## 切段、段标题唯一、不少于 8 段；加载器吃得进去', async () => {
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
        })
        const resolved = await skills.registry.resolve(name, {
          person_id: 'p_1',
          workspace_id: 'ws_1',
          role_id: name === 'trend-research' ? 'pr.monitoring' : 'social.tiktok',
        })
        for (const h of headings) expect(resolved?.markdown).toContain(`## ${h}`)
      })

      it('读品牌档案与事实卡；没有附录目录；没有授权字样；没有真实联系方式；不出现上游服务名', () => {
        expect(skill.markdown).toContain('品牌档案')
        expect(skill.markdown).toContain('事实卡')
        expect(existsSync(join(BUNDLED_SKILLS_DIR, name, 'references'))).toBe(false)
        expect(findAuthorizationPhrases(skill.markdown)).toEqual([])
        expect(skill.markdown).not.toMatch(/[\w.+-]+@[\w-]+\.[a-z]{2,}/i)
        // 第三方抓取服务的名字只在第一行出处里出现（仓库名），正文不教人去用
        const rest = body.trim().split('\n').slice(1).join('\n')
        expect(rest).not.toMatch(/scrapecreators|apify|bright ?data|api_key|cookie/i)
      })

      it('取数只走许可的口：不直接抓、Reddit 两路、绝不用品牌发帖会话、没取到不写成 0', () => {
        expect(skill.markdown).toMatch(/不直接抓任何平台/)
        expect(skill.markdown).toContain('接口中台')
        expect(skill.markdown).toContain('浏览器只读')
        expect(skill.markdown).toContain('绝不用品牌发帖账号的会话')
        // Luoye 10-05：官方网页抓取可以打开 Reddit / X 的公开页面（不用品牌账号）
        expect(skill.markdown).toMatch(/Reddit、X 的(单条)?公开页面/)
        expect(skill.markdown).toContain('不用任何品牌账号')
        expect(skill.markdown).toContain('还没接')
      })

      it('出卡规矩：写明出卡、自动化级别不由技能授权；建议卡两种、最多三张', () => {
        expect(skill.markdown).toContain('出卡')
        expect(skill.markdown).toContain('自动化级别')
        expect(skill.markdown).toContain('这个话题值得回应')
        expect(skill.markdown).toContain('这条帖子在扩散')
        expect(skill.markdown).toContain('最多三张')
      })

      it('这周什么在起来：营销用、三个免费公开来源、取不到照实说、选题带出处与日期、不做选品', () => {
        const section = splitSections(body).find((x) => x.heading === '这周什么在起来')
        const text = section?.body ?? ''
        for (const piece of [
          'Google Trends',
          'TikTok Creative Center',
          '`read_reddit`',
          '**不做选品**',
          '取不到照实说',
          '每条都带出处与日期',
        ])
          expect(text).toContain(piece)
        expect(text).not.toMatch(/jungle|helium/i)
      })

      it('出处登记：upstreams.yml 写了这份技能的路径', () => {
        expect(UPSTREAMS).toContain(`packages/skills/bundled/${name}/SKILL.md`)
      })
    })
  }

  it('trend-research 的报告：每条带链接、平台、日期、来自哪一路；按话题 / 情绪 / 平台分组', () => {
    const md = readBundledSkill('trend-research').markdown
    expect(md).toContain('[标题](链接) · Reddit · 2026-10-03 · 负面 · 来自浏览器只读')
    expect(md).toContain('情绪：')
    expect(md).toContain('平台：')
    expect(md).toContain('这不等于没人在聊')
  })

  it('trend-research 的危机说明：五格、不说无可奉告、不承诺、不写完成式、时间由人填', () => {
    const md = readBundledSkill('trend-research').markdown
    const section = splitSections(splitFrontmatter(md).body).find(
      (s) => s.heading === '危机说明的固定格式',
    )
    expect(section).toBeDefined()
    const text = section?.body ?? ''
    expect(text).toContain('agency-agents `marketing/marketing-pr-communications-manager.md`')
    for (const cell of [
      '我们知道什么',
      '还不知道什么',
      '现在在做什么',
      '受影响的人现在可以怎么办',
      '下一次更新什么时候',
    ])
      expect(text).toContain(cell)
    expect(text).toContain('不说「无可奉告」')
    expect(text).toContain('**不承诺**')
    expect(text).toContain('时间由人在卡上填')
    expect(text).toContain('一次最多三条主信息')
    // 上游的承诺式模板句没有搬进来
    expect(text).not.toMatch(/top priority|taking it seriously|首要任务|高度重视/i)
  })

  it('social-research 的爆款：跟账号自己比、中位数、三档倍数、不到 10 条置信低', () => {
    const md = readBundledSkill('social-research').markdown
    expect(md).toContain('跟账号自己比，不跟别人比')
    expect(md).toContain('基线用中位数')
    expect(md).toContain('5 倍以上「大爆」、2 到 5 倍「明显」、1.5 到 2 倍「小爆」')
    expect(md).toContain('不够 10 条的，结论只能算方向')
  })

  it('upstreams.yml 登记了三家（ported、钉提交）', () => {
    for (const id of ['last30days-skill', 'social-media-research-skills', 'agency-agents']) {
      expect(UPSTREAMS).toContain(`  - id: ${id}\n    kind: ported`)
    }
    expect(UPSTREAMS).toContain('pinned_commit: 83294689da3832c0a9f223221148c411fd3eacc0')
  })
})
