import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  BUNDLED_SKILLS_DIR,
  findAuthorizationPhrases,
  listBundledSkills,
  readBundledSkill,
  splitFrontmatter,
  splitSections,
} from '../src/index.js'
import { makeSkills } from './helpers.js'

const names = listBundledSkills()

/** WP160：改写自第三方（MIT）的五个。 */
const THIRD_PARTY = [
  'ad-copywriting',
  'audience-research',
  'email-sms',
  'influencer-marketing',
  'seo-judgment',
]
/** WP162：Agents 工坊自己写的（本仓库的 Apache-2.0）。 */
const OWN = [
  'brand-voice',
  'chargeback-evidence',
  'policy-review',
  'returns-policy-calc',
  'workspace-basics',
]
/**
 * WP29 起服务端自带的那一份（原来写死在 `apps/server/src/learning.ts`），WP162 原样搬进来。
 * frontmatter 与正文**一个字节不改**：它是 always 技能，改一个字，客服那几条职责的
 * 提示词字节就变，已有 overlay 的 `base_version`（`1.0`）也对不上。所以格式规矩对它放宽。
 */
const LEGACY = ['customer-care']

/** 各自改编自谁（WP160）：出处那一行必须逐字在。 */
const MARKETINGSKILLS = '改编自 coreyhaines31/marketingskills（MIT，© 2025 Corey Haines）'
const OPEN_SEO = '部分判断规矩改编自 every-app/open-seo（MIT）'

describe('自带技能：格式（24 §1 Agent Skills）', () => {
  it('WP160 的五个 + WP162 的六个都在，目录名即技能名', () => {
    expect(names).toEqual([...THIRD_PARTY, ...OWN, ...LEGACY].sort())
  })

  for (const name of THIRD_PARTY) {
    describe(name, () => {
      const skill = readBundledSkill(name)

      it('frontmatter：name 与目录一致，license / tier / version / description 都在', () => {
        const { frontmatter } = splitFrontmatter(skill.markdown)
        expect(frontmatter.name).toBe(name)
        expect(frontmatter.description?.length ?? 0).toBeGreaterThan(20)
        expect(frontmatter.extra.license).toBe('MIT')
        expect(frontmatter.extra.tier).toBe('open')
        expect(frontmatter.extra.version).toMatch(/^\d+\.\d+\.\d+$/)
      })

      it('按 ## 切段，段标题唯一且不少于 6 段', () => {
        const { body } = splitFrontmatter(skill.markdown)
        const headings = splitSections(body)
          .map((s) => s.heading)
          .filter((h) => h !== '')
        expect(headings.length).toBeGreaterThanOrEqual(6)
        expect(new Set(headings).size).toBe(headings.length)
      })

      it('加载器吃得进去：入库后 resolve 回来每一段都在', async () => {
        const { skills } = makeSkills()
        await skills.registry.putFromMarkdown({
          markdown: skill.markdown,
          tier: 'package',
          owner: 'package',
          version: '1.0.0',
          evals: skill.evals.map((e) => e.id),
        })
        const resolved = await skills.registry.resolve(name, {
          person_id: 'p_1',
          workspace_id: 'ws_1',
          role_id: 'dtc.content',
        })
        expect(resolved?.layers_applied).toEqual(['package'])
        const { body } = splitFrontmatter(skill.markdown)
        for (const s of splitSections(body)) {
          if (s.heading !== '') expect(resolved?.markdown).toContain(`## ${s.heading}`)
        }
        expect((await skills.registry.get(name, 'package'))?.evals.length).toBe(skill.evals.length)
      })

      it('出处写在正文第一行（MIT 要求保留版权声明）', () => {
        const { body } = splitFrontmatter(skill.markdown)
        const first = body.trim().split('\n')[0] ?? ''
        expect(first).toContain(MARKETINGSKILLS)
      })

      it('没有附录目录：加载器只读 SKILL.md，附录一律并进正文', () => {
        expect(existsSync(join(BUNDLED_SKILLS_DIR, name, 'references'))).toBe(false)
      })

      it('不沿用上游的产品营销文件，读的是我们的品牌档案与事实卡', () => {
        expect(skill.markdown).not.toContain('product-marketing')
        expect(skill.markdown).toContain('品牌档案')
        expect(skill.markdown).toContain('事实卡')
      })

      it('正文里没有真实联系方式', () => {
        expect(skill.markdown).not.toMatch(/[\w.+-]+@[\w-]+\.[a-z]{2,}/i)
        expect(skill.markdown).not.toMatch(/\+?\d[\d\s-]{9,}\d/)
      })
    })
  }
})

describe('自带技能：Agents 工坊自己写的（WP162）', () => {
  for (const name of OWN) {
    describe(name, () => {
      const skill = readBundledSkill(name)

      it('frontmatter：name 与目录一致，license 是本仓库的 Apache-2.0，tier / version / description 都在', () => {
        const { frontmatter } = splitFrontmatter(skill.markdown)
        expect(frontmatter.name).toBe(name)
        expect(frontmatter.description?.length ?? 0).toBeGreaterThan(20)
        expect(frontmatter.extra.license).toBe('Apache-2.0')
        expect(frontmatter.extra.tier).toBe('open')
        expect(frontmatter.extra.version).toMatch(/^\d+\.\d+\.\d+$/)
      })

      it('按 ## 切段，段标题唯一且不少于 5 段；第一行说明公司层优先', () => {
        const { body } = splitFrontmatter(skill.markdown)
        const headings = splitSections(body)
          .map((s) => s.heading)
          .filter((h) => h !== '')
        expect(headings.length).toBeGreaterThanOrEqual(5)
        expect(new Set(headings).size).toBe(headings.length)
        expect(body.trim().split('\n')[0]).toContain('Agents 工坊自带的基础版')
      })

      it('数字只引事实卡；没有真实联系方式；不是改编来的（不挂第三方出处）', () => {
        expect(skill.markdown).toContain('事实卡')
        expect(skill.markdown).not.toMatch(/[\w.+-]+@[\w-]+\.[a-z]{2,}/i)
        expect(skill.markdown).not.toMatch(/\+?\d[\d\s-]{9,}\d/)
        expect(skill.markdown).not.toContain('改编自')
      })
    })
  }

  it('customer-care 原样搬进来：三段都在，没写 version（入库按 1.0，与 WP29 起的一致）', () => {
    const { frontmatter, body } = splitFrontmatter(readBundledSkill('customer-care').markdown)
    expect(frontmatter.name).toBe('customer-care')
    expect(frontmatter.extra.version).toBeUndefined()
    expect(
      splitSections(body)
        .map((s) => s.heading)
        .filter((h) => h !== ''),
    ).toEqual(['回答顺序', '退货窗口计算', '回信语气'])
  })
})

describe('自带技能：守卫（WP160 改写规矩第一条）', () => {
  it('守卫本身认得出授权字样（含英文、大小写不敏感）', () => {
    expect(findAuthorizationPhrases('授权后可自动执行；Upload directly via CSV')).toEqual([
      '授权后可自动',
      'upload directly',
    ])
    expect(findAuthorizationPhrases('每一次群发都出卡等人批。')).toEqual([])
  })

  for (const name of names) {
    it(`${name}：没有「自动发送 / 自动发布 / 直接上传 / without approval」这类授权字样`, () => {
      expect(findAuthorizationPhrases(readBundledSkill(name).markdown)).toEqual([])
    })

    it(`${name}：写明出卡、写明自动化级别不由技能授权`, () => {
      // customer-care 原样搬来、一个字节不改（见 LEGACY 的注释），它用「改动一律先提再做」说同一件事
      if (LEGACY.includes(name)) return
      const md = readBundledSkill(name).markdown
      expect(md).toContain('出卡')
      expect(md).toContain('自动化级别')
    })
  }
})

describe('自带技能：考题（改写自上游 evals；WP162 自己写的那几个照同一格式出题）', () => {
  for (const name of [...THIRD_PARTY, ...OWN]) {
    it(`${name}：至少 3 条，覆盖出卡 / 数字不编 / 合规，每条的规矩都在正文里`, () => {
      const { markdown, evals } = readBundledSkill(name)
      expect(evals.length).toBeGreaterThanOrEqual(3)
      expect(new Set(evals.map((e) => e.id)).size).toBe(evals.length)
      const kinds = new Set(evals.map((e) => e.kind))
      for (const k of ['approval', 'numbers', 'compliance'] as const) expect(kinds).toContain(k)
      for (const e of evals) {
        expect(e.must_include.length).toBeGreaterThan(0)
        for (const piece of e.must_include) {
          expect(markdown, `${e.id} 缺规矩：${piece}`).toContain(piece)
        }
      }
    })
  }

  it('seo-judgment 另带 open-seo 的出处', () => {
    if (!names.includes('seo-judgment')) return
    expect(readBundledSkill('seo-judgment').markdown).toContain(OPEN_SEO)
  })

  it('两家 MIT 许可证全文随技能一起放着', () => {
    const notices = readFileSync(join(BUNDLED_SKILLS_DIR, 'THIRD-PARTY-NOTICES'), 'utf8')
    expect(notices).toContain('Copyright (c) 2025 Corey Haines')
    expect(notices).toContain('Copyright (c) 2026 Ben Senescu')
    expect(notices.match(/Permission is hereby granted/g)?.length).toBe(2)
  })

  it('读不存在的技能报 not_found，非法名报 invalid_input', () => {
    expect(() => readBundledSkill('no-such-skill')).toThrow(/没有自带技能/)
    expect(() => readBundledSkill('../roles')).toThrow(/非法技能名/)
  })
})
