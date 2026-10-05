import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BUNDLED_ROLES_DIR, loadBundledRole, loadBundledRoles } from '../src/index.js'

/**
 * WP220：两份研究技能挂在哪、Reddit 取数路由接到哪几条职责（Luoye 10-05）。
 *
 * - `trend-research`（话题与舆情研究、危机说明格式）→ 公共关系四条，`pr.monitoring` 必挂；
 * - `social-research`（爆款帖、评论、竞品拆解）→ 社媒运营的内容渠道（群聊类与已拆分的 `social.meta` 不挂）；
 * - 涉及 Reddit 的四条（`pr.monitoring` / `pr.reddit` / `pr.forums` / `social.reddit`）挂只读工具 `read_reddit`；
 * - `pr.forums` 的浏览器白名单保留 `*.reddit.com`（只读）。
 */
const BUNDLED_SKILLS_DIR = join(BUNDLED_ROLES_DIR, '..', '..', 'skills', 'bundled')

const TREND = ['pr.forums', 'pr.monitoring', 'pr.press', 'pr.reddit']
const SOCIAL = [
  'social.facebook',
  'social.instagram',
  'social.linkedin',
  'social.reddit',
  'social.threads',
  'social.tiktok',
  'social.x',
  'social.youtube',
]
const REDDIT_DUTIES = ['pr.forums', 'pr.monitoring', 'pr.reddit', 'social.reddit']

describe('WP220 研究技能的挂载', () => {
  it('正文都在技能包里', () => {
    for (const name of ['trend-research', 'social-research'])
      expect(existsSync(join(BUNDLED_SKILLS_DIR, name, 'SKILL.md')), name).toBe(true)
  })

  it('trend-research 挂在公共关系四条上（品牌监控必挂），按需加载', () => {
    const got = loadBundledRoles()
      .filter((r) => r.skills.some((s) => s.name === 'trend-research'))
      .map((r) => r.id)
      .sort()
    expect(got).toEqual(TREND)
    const ref = loadBundledRole('pr.monitoring').skills.find((s) => s.name === 'trend-research')
    expect(ref).toMatchObject({ tier: 'open', load: 'on_demand' })
  })

  it('social-research 挂在社媒内容渠道上，按需加载；群聊类与 social.meta 不挂', () => {
    const got = loadBundledRoles()
      .filter((r) => r.skills.some((s) => s.name === 'social-research'))
      .map((r) => r.id)
      .sort()
    expect(got).toEqual(SOCIAL)
    for (const id of SOCIAL)
      expect(loadBundledRole(id).skills.find((s) => s.name === 'social-research')?.load).toBe(
        'on_demand',
      )
  })

  it('涉及 Reddit 的四条挂了只读工具 read_reddit；别的职责一条都没有', () => {
    const got = loadBundledRoles()
      .filter((r) => r.grounding.some((g) => g.tool === 'read_reddit'))
      .map((r) => r.id)
      .sort()
    expect(got).toEqual(REDDIT_DUTIES)
  })

  it('pr.forums 的浏览器白名单保留 *.reddit.com（只读，Luoye 10-05）', () => {
    expect(loadBundledRole('pr.forums').browser_scope).toContain('*.reddit.com')
  })

  it('研究的例子：品牌监控「这周大家在聊什么」、TikTok「拆一下竞品这个月的爆款」', () => {
    expect(loadBundledRole('pr.monitoring').quick_prompts?.map((p) => p.id)).toContain('week_buzz')
    expect(loadBundledRole('social.tiktok').task_examples?.map((e) => e.id)).toContain(
      'rival_outliers',
    )
  })
})
