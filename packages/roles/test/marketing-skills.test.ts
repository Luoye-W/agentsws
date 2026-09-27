import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BUNDLED_ROLES_DIR, loadBundledRole, loadBundledRoles } from '../src/index.js'

/**
 * WP160：五个营销技能挂在哪些职责上，职责拿得到、正文也真的在。
 *
 * 正文住在 `@agentsws/skills` 的 `bundled/<name>/SKILL.md`；本包不依赖那个包，
 * 这里按仓库里的相对路径确认文件在（技能包那边的测试管正文能不能被解析）。
 */
const BUNDLED_SKILLS_DIR = join(BUNDLED_ROLES_DIR, '..', '..', 'skills', 'bundled')

const EXPECTED: Record<string, string[]> = {
  'dtc.content': ['seo-judgment'],
  'ads.meta': ['ad-copywriting', 'audience-research'],
  'ads.google': ['ad-copywriting', 'audience-research'],
  'ads.tiktok': ['ad-copywriting', 'audience-research'],
  'ads.x': ['ad-copywriting', 'audience-research'],
  'dtc.email-marketing': ['email-sms'],
  'kol.tiktok': ['influencer-marketing'],
  'kol.instagram': ['influencer-marketing'],
  'kol.youtube': ['influencer-marketing'],
  'kol.facebook': ['influencer-marketing'],
  'kol.x': ['influencer-marketing'],
}

const MARKETING = [...new Set(Object.values(EXPECTED).flat())].sort()

describe('WP160 五个营销技能：职责拿得到', () => {
  for (const [roleId, names] of Object.entries(EXPECTED)) {
    it(`${roleId} 登记了 ${names.join(' / ')}，按需加载`, () => {
      const skills = loadBundledRole(roleId).skills
      for (const name of names) {
        const ref = skills.find((s) => s.name === name)
        expect(ref, `${roleId} 缺 ${name}`).toBeDefined()
        expect(ref?.tier).toBe('open')
        expect(ref?.load).toBe('on_demand')
      }
    })
  }

  it('五个技能的正文都在技能包里', () => {
    expect(MARKETING).toEqual([
      'ad-copywriting',
      'audience-research',
      'email-sms',
      'influencer-marketing',
      'seo-judgment',
    ])
    for (const name of MARKETING) {
      expect(existsSync(join(BUNDLED_SKILLS_DIR, name, 'SKILL.md')), name).toBe(true)
    }
  })

  it('红人营销五条渠道共用同一个技能，不各起一份', () => {
    const kol = loadBundledRoles().filter((r) => r.id.startsWith('kol.'))
    expect(kol).toHaveLength(5)
    for (const role of kol) {
      expect(role.skills.map((s) => s.name)).toEqual(['influencer-marketing'])
    }
  })
})
