/**
 * WP397（docs/106 §13.2 / §13.4）：Amazon 运营岗位的改写技能——SeaLeap（MIT）挑选改写的一批，
 * 加上我们自己写的库存公式与岗位知识（素材来自 kangise/ecommerce-ai-skills，CC0）。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  BUNDLED_SKILLS_DIR,
  findAuthorizationPhrases,
  listBundledSkills,
  readBundledSkill,
  readOfficialSkillMeta,
  splitFrontmatter,
  splitSections,
} from '../src/index.js'
import { makeSkills } from './helpers.js'

const SEALEAP_COMMIT = '1283764556e61cbe56c600bbe504b8731b2254cb'

/** 我们的名字 → SeaLeap 上游目录（只从 amazon-official/ 与 public-research/ 挑；广告类一本不搬）。 */
export const SEALEAP: Readonly<Record<string, string>> = {
  'amazon-fba-reimbursement': 'public-research/sealeap-amazon-fba-reimbursement-audit',
  'amazon-data-kiosk-recon': 'public-research/sealeap-amazon-data-kiosk-reconciliation',
  'amazon-case-tracking': 'public-research/sealeap-amazon-support-case-tracking',
  'amazon-sqp-recon': 'public-research/sealeap-amazon-sqp-period-reconciliation',
  'amazon-multichannel': 'public-research/sealeap-amazon-multichannel-operations',
  'amazon-eu-packaging': 'public-research/sealeap-amazon-ppwr-packaging-audit',
  'amazon-connection-check': 'public-research/sealeap-amazon-selling-partner-connector',
  'amazon-listing-optimizer': 'amazon-official/sealeap-amazon-listing-optimizer',
  'amazon-brand-prep-listing': 'amazon-official/sealeap-amazon-brand-preparation-listing',
  'amazon-peak-season': 'amazon-official/sealeap-amazon-peak-season-readiness',
  'amazon-global-expansion': 'amazon-official/sealeap-amazon-global-growth-planning',
  'amazon-localization': 'amazon-official/sealeap-amazon-localization-marketing',
  'amazon-brand-stage': 'amazon-official/sealeap-amazon-brand-growth-navigator',
  'amazon-brand-tools-promo': 'amazon-official/sealeap-amazon-brand-tool-promotion-mix',
  'amazon-ce-category': 'amazon-official/sealeap-amazon-consumer-electronics-category-growth',
}
/** 我们自己写的（本仓库 Apache-2.0；素材出处写在正文第一行）。 */
export const AMAZON_OWN = ['amazon-inventory', 'amazon-ops-playbook'] as const

/** 用户可见文字不提数据供应商（docs/106；数据来源不对用户说）。 */
const VENDORS = [
  'Sorftime',
  'sorftime',
  '卖家精灵',
  'SellerSprite',
  'Helium',
  'Jungle Scout',
  'Keepa',
  'DataForSEO',
  'Apify',
]
/** docs/106 §13.4：这些做法不进任何技能。 */
const BANNED_PRACTICES = ['拆变体', '低于 4 星', '低于4星', '填竞品品牌名', 'sealeap.cn']

describe('WP397 Amazon 改写技能：都在、格式对', () => {
  const names = listBundledSkills()
  it('SeaLeap 改写的与我们自己写的都在包里；amazon-* 里除了官方的就是这两组', () => {
    const amazon = names.filter((n) => n.startsWith('amazon-') && !n.startsWith('amazon-sp-'))
    expect(amazon.sort()).toEqual([...Object.keys(SEALEAP), ...AMAZON_OWN].sort())
  })

  for (const name of [...Object.keys(SEALEAP), ...AMAZON_OWN]) {
    describe(name, () => {
      const adapted = name in SEALEAP
      const skill = readBundledSkill(name)
      const { frontmatter, body } = splitFrontmatter(skill.markdown)
      const first = body.trim().split('\n')[0] ?? ''

      it('frontmatter：名字、许可证、版本、岗位、显示名与核对日期', () => {
        expect(frontmatter.name).toBe(name)
        expect(frontmatter.description?.length ?? 0).toBeGreaterThan(20)
        expect(frontmatter.extra.license).toBe(adapted ? 'MIT' : 'Apache-2.0')
        expect(frontmatter.extra.tier).toBe('open')
        expect(frontmatter.extra.version).toMatch(/^\d+\.\d+\.\d+$/)
        expect(frontmatter.extra.positions).toBe('amazon-ops')
        expect(frontmatter.extra.display_name?.length ?? 0).toBeGreaterThan(1)
        expect(frontmatter.extra.display_name_en?.length ?? 0).toBeGreaterThan(1)
        expect(frontmatter.extra.verified_at).toMatch(/^\d{4}-\d{2}-\d{2}$/)
        expect(readOfficialSkillMeta(name)).toBeUndefined()
        if (adapted) expect(frontmatter.extra.origin).toBe('adapted')
      })

      it('正文第一行写出处（仓库 + 路径 + 提交 + 核对日期）', () => {
        if (adapted) {
          expect(first).toContain('改编自 xjli360/sealeap-amazon-skills（MIT，© 2026 SeaLeap）')
          expect(first).toContain(`amazon-skills/${SEALEAP[name]}/`)
          expect(first).toContain(SEALEAP_COMMIT)
          expect(first).toContain(`上游核对日期 ${frontmatter.extra.verified_at}`)
        } else {
          expect(first).toContain('Agents 工坊自带的基础版')
          expect(first).toContain('kangise/ecommerce-ai-skills（CC0）')
        }
      })

      it('按 ## 切段不少于 6 段、段名唯一；有出卡那一段；没有附录目录和脚本', () => {
        const headings = splitSections(body)
          .map((s) => s.heading)
          .filter((h) => h !== '')
        expect(headings.length).toBeGreaterThanOrEqual(6)
        expect(new Set(headings).size).toBe(headings.length)
        expect(headings).toContain('出卡与自动化级别')
        if (adapted) expect(headings).toContain('四档怎么对上我们的出卡')
        expect(existsSync(join(BUNDLED_SKILLS_DIR, name, 'references'))).toBe(false)
        expect(existsSync(join(BUNDLED_SKILLS_DIR, name, 'scripts'))).toBe(false)
      })

      it('规矩：自动化级别不由技能授权；会话授权那条改成逐条出卡；数字不编', () => {
        const md = skill.markdown
        expect(md).toContain('自动化级别只由职责设置决定，这本技能不改变它')
        expect(md).toContain('不知道')
        if (adapted) expect(md).toContain('**这里不用**')
        expect(findAuthorizationPhrases(md)).toEqual([])
      })

      it('不提数据供应商、不带推广链接、§13.4 不采用的做法一条都没有', () => {
        const md = skill.markdown
        for (const v of VENDORS) expect(md, v).not.toContain(v)
        for (const b of BANNED_PRACTICES) expect(md, b).not.toContain(b)
        // SeaLeap 只出现在出处那一行
        expect(body.split('\n').filter((l) => l.includes('SeaLeap')).length).toBe(adapted ? 1 : 0)
        expect(md).not.toMatch(/[\w.+-]+@[\w-]+\.[a-z]{2,}/i)
        if (md.includes('Posts')) expect(md).toContain('Posts 已停')
        if (md.includes('Early Reviewer')) expect(md).toContain('Early Reviewer 已停')
      })

      it('考题：出卡 / 数字不编 / 合规三类都有，每条规矩都在正文里', () => {
        expect(skill.evals.length).toBeGreaterThanOrEqual(3)
        expect(new Set(skill.evals.map((e) => e.id)).size).toBe(skill.evals.length)
        const kinds = new Set(skill.evals.map((e) => e.kind))
        for (const k of ['approval', 'numbers', 'compliance'] as const) expect(kinds).toContain(k)
        for (const e of skill.evals) {
          expect(e.from, e.id).toBeTruthy()
          for (const piece of e.must_include) {
            expect(skill.markdown, `${e.id} 缺：${piece}`).toContain(piece)
          }
        }
      })

      it('加载器吃得进去：入库后 resolve 回来每一段都在', async () => {
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
          role_id: 'amz.store',
        })
        for (const s of splitSections(body)) {
          if (s.heading !== '') expect(resolved?.markdown).toContain(`## ${s.heading}`)
        }
      })
    })
  }
})

describe('WP397 出处登记', () => {
  const notices = readFileSync(join(BUNDLED_SKILLS_DIR, 'THIRD-PARTY-NOTICES'), 'utf8')
  const upstreams = readFileSync(
    fileURLToPath(new URL('../../../upstreams.yml', import.meta.url)),
    'utf8',
  )
  it('THIRD-PARTY-NOTICES：SeaLeap 的 MIT 全文与 NOTICE、每本都列在 Used in；kangise 的 CC0', () => {
    expect(notices).toContain('xjli360/sealeap-amazon-skills')
    expect(notices).toContain('Copyright (c) 2026 SeaLeap')
    expect(notices).toContain('are not relicensed under the MIT License')
    for (const name of Object.keys(SEALEAP)) expect(notices, name).toContain(name)
    expect(notices).toContain('kangise/ecommerce-ai-skills')
    expect(notices).toContain('CC0 1.0 Universal')
  })
  it('upstreams.yml：两个上游都钉了提交', () => {
    expect(upstreams).toContain('repo: xjli360/sealeap-amazon-skills')
    expect(upstreams).toContain(`pinned_commit: ${SEALEAP_COMMIT}`)
    expect(upstreams).toContain('repo: kangise/ecommerce-ai-skills')
    expect(upstreams).toContain('pinned_commit: b1a727c3b2c2d27f2793e0d0fcd655ea446ba635')
  })
})
