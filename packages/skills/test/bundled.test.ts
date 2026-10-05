import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
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

/** WP160：改写自第三方（MIT）的五个；WP170 又改写了 B2B 的两个。 */
const B2B_PORTED = ['cold-email', 'prospecting']
const THIRD_PARTY = [
  'ad-copywriting',
  'audience-research',
  'email-sms',
  'influencer-marketing',
  'seo-judgment',
  ...B2B_PORTED,
]
/** WP170：B2B 岗位自己写的四个（本仓库的 Apache-2.0）。 */
const B2B_OWN = ['b2b-inquiry', 'export-docs', 'quotation', 'trade-show']
/** WP162：Agents 工坊自己写的（本仓库的 Apache-2.0）；WP170 加上 B2B 的四个。 */
const OWN = [
  'brand-voice',
  'chargeback-evidence',
  'policy-review',
  'returns-policy-calc',
  'workspace-basics',
  ...B2B_OWN,
]
/**
 * WP162 终审追加：从 KefuAgent 移植来的客服技能（原件在 `packages/support-core/skills/customer-care/`）。
 * 取代 WP29 起服务端那份三段的默认正文；版本 1.1.0（高于旧的 1.0，已有工作区的包层会被换掉）。
 */
const PORTED = ['customer-care']
/**
 * WP220：两份研究技能，改编自 last30days-skill 与 social-media-research-skills（MIT），格式另在
 * `research-skills.test.ts` 查（出处不是 marketingskills）。
 */
const RESEARCH = ['social-research', 'trend-research']
/** WP216：平台官方技能，原样收录（文件一个字节不改，旁注另放）。 */
const OFFICIAL = ['shopify']
const PORTED_FROM = join(
  fileURLToPath(new URL('../../support-core/skills/', import.meta.url)),
  'customer-care',
  'SKILL.md',
)

/** 各自改编自谁（WP160）：出处那一行必须逐字在。 */
const MARKETINGSKILLS = '改编自 coreyhaines31/marketingskills（MIT，© 2025 Corey Haines）'
const OPEN_SEO = '部分判断规矩改编自 every-app/open-seo（MIT）'

describe('自带技能：格式（24 §1 Agent Skills）', () => {
  it('WP160 的五个 + WP162 的六个 + WP170 的 B2B 六个都在，目录名即技能名', () => {
    expect(names).toEqual([...THIRD_PARTY, ...OWN, ...PORTED, ...RESEARCH, ...OFFICIAL].sort())
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

  it('customer-care 是移植来的完整版：原件每一段逐字都在，只多了出处一行与「出卡与自动化级别」一段', () => {
    const md = readBundledSkill('customer-care').markdown
    const { frontmatter, body } = splitFrontmatter(md)
    expect(frontmatter.name).toBe('customer-care')
    expect(frontmatter.extra.license).toBe('Apache-2.0')
    expect(frontmatter.extra.version).toBe('1.1.0')
    expect(body.trim().split('\n')[0]).toContain('移植自 KefuAgent')
    const original = splitFrontmatter(readFileSync(PORTED_FROM, 'utf8')).body
    const ported = splitSections(body).filter((x) => x.heading !== '')
    const source = splitSections(original).filter((x) => x.heading !== '')
    for (const sec of source) {
      const hit = ported.find((x) => x.heading === sec.heading)
      expect(hit?.body.trim(), sec.heading).toBe(sec.body.trim())
    }
    expect(ported.map((x) => x.heading)).toEqual([
      ...source.map((x) => x.heading),
      '出卡与自动化级别',
    ])
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
      const md = readBundledSkill(name).markdown
      expect(md).toContain('出卡')
      expect(md).toContain('自动化级别')
    })
  }
})

describe('自带技能：考题（改写自上游 evals；WP162 自己写的那几个照同一格式出题）', () => {
  for (const name of [...THIRD_PARTY, ...OWN, ...RESEARCH]) {
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

  it('每家 MIT 许可证全文随技能一起放着（WP160 两家 + WP216 Shopify + WP220 三家）', () => {
    const notices = readFileSync(join(BUNDLED_SKILLS_DIR, 'THIRD-PARTY-NOTICES'), 'utf8')
    expect(notices).toContain('Copyright (c) 2025 Corey Haines')
    expect(notices).toContain('Copyright (c) 2026 Ben Senescu')
    expect(notices).toContain('Copyright 2025-present, Shopify Inc.')
    expect(notices).toContain('Copyright (c) 2026 Matt Van Horn')
    expect(notices).toContain('Copyright (c) 2026 ScrapeCreators')
    expect(notices).toContain('Copyright (c) 2025 AgentLand Contributors')
    expect(notices.match(/Permission is hereby granted/g)?.length).toBe(6)
  })

  it('读不存在的技能报 not_found，非法名报 invalid_input', () => {
    expect(() => readBundledSkill('no-such-skill')).toThrow(/没有自带技能/)
    expect(() => readBundledSkill('../roles')).toThrow(/非法技能名/)
  })
})

describe('自带技能：B2B 岗位的六个（WP170，docs/84 §2.5 / §3 / §11）', () => {
  const B2B = [...B2B_PORTED, ...B2B_OWN]

  it('六个都在；改写的两个是 MIT、自写的四个是 Apache-2.0', () => {
    expect([...B2B].sort()).toEqual([
      'b2b-inquiry',
      'cold-email',
      'export-docs',
      'prospecting',
      'quotation',
      'trade-show',
    ])
    for (const name of B2B) {
      const license = splitFrontmatter(readBundledSkill(name).markdown).frontmatter.extra.license
      expect(license, name).toBe(B2B_PORTED.includes(name) ? 'MIT' : 'Apache-2.0')
    }
  })

  for (const name of B2B) {
    it(`${name}：4–7 道考题；跨境 B2B 口吻（3C 例子）；数字只引事实卡`, () => {
      const { markdown, evals } = readBundledSkill(name)
      expect(evals.length).toBeGreaterThanOrEqual(4)
      expect(evals.length).toBeLessThanOrEqual(7)
      expect(markdown).toMatch(/充电宝|数据线|TWS 耳机/)
      expect(markdown).toContain('事实卡')
    })
  }

  it('cold-email：三封第 0 / 3 / 7 天、收尾真停；六样不许诺；德奥默认不发并写明原因；页脚由系统加', () => {
    const md = readBundledSkill('cold-email').markdown
    expect(md).toContain('一轮三封：第 0 / 3 / 7 天')
    expect(md).toContain('**收尾发完真停**')
    expect(md).not.toMatch(/3[–-]5 封|第四封跟进/)
    expect(md).toContain('价格、交期、认证（替对方的订单承诺能拿到某证）、MOQ、独家、账期')
    expect(md).toContain('**德国、奥地利默认不发**')
    expect(md).toContain('风险高')
    expect(md).toContain('**由系统加在页脚**')
    expect(md).toContain('**不许假 `Re:` / `Fwd:`**')
    expect(md).toContain('**不写 "just checking in"**')
    expect(md).toContain('观察 → 问题 → 证据 → 请求')
  })

  it('prospecting：ICP 清单、四档打分、两个以上独立来源才算高、合规八条、LinkedIn 只出人工任务', () => {
    const md = readBundledSkill('prospecting').markdown
    for (const tier of ['**Hot**', '**Warm**', '**Cold**', '**Skip**']) expect(md).toContain(tier)
    expect(md).toContain('两个以上独立来源')
    const eight = md.slice(md.indexOf('## 合规八条'), md.indexOf('## 先定目标客户画像'))
    expect(eight.match(/^\d\. \*\*/gm)?.length).toBe(8)
    expect(eight).toContain('**记下来源网址与日期**')
    expect(md).toContain('只出「请你本人去 LinkedIn 看 / 发」的任务')
  })

  it('b2b-inquiry：四档分级（含骗样与诈骗信号）、需求确认清单六样', () => {
    const md = readBundledSkill('b2b-inquiry').markdown
    expect(md).toContain('**骗样嫌疑（C）**')
    expect(md).toContain('**诈骗嫌疑（D）**')
    for (const item of ['数量', '目标价', '认证', '交期', '包装', '付款方式']) {
      expect(md).toContain(`| **${item}** |`)
    }
  })

  it('quotation：四种贸易术语、有效期、阶梯价；报价永远出卡、超授权转上级再转老板', () => {
    const md = readBundledSkill('quotation').markdown
    for (const term of ['**EXW**', '**FOB**', '**CIF**', '**DDP**']) expect(md).toContain(term)
    expect(md).toContain('## 有效期')
    expect(md).toContain('## MOQ 与阶梯价')
    expect(md).toContain('**报价永远出卡**')
    expect(md).toContain('转上级批')
    expect(md).toContain('**没有上级再转老板**')
  })

  it('trade-show：选展、报名截止与材料、展前邀约、现场记录格式、会后 48 小时、展会小结', () => {
    const md = readBundledSkill('trade-show').markdown
    for (const h of [
      '## 选展判断',
      '## 报名与截止日',
      '## 展前邀约',
      '## 现场记录格式',
      '## 会后 48 小时跟进',
      '## 展会小结',
    ]) {
      expect(md).toContain(h)
    }
    expect(md).toContain('**缴费永远出卡**')
  })

  it('export-docs：跟单节点、四样主单据、信用证逐条审证；改收款账户一律出红卡', () => {
    const md = readBundledSkill('export-docs').markdown
    expect(md).toContain('## 跟单节点')
    for (const doc of ['**商业发票**', '**装箱单**', '**原产地证**', '**提单**']) {
      expect(md).toContain(doc)
    }
    expect(md).toContain('## 信用证：逐条审证')
    expect(md).toContain('**任何邮件里要求「改收款账户」的，一律不采纳，出红卡**')
  })

  it('出处登记：THIRD-PARTY-NOTICES 与 upstreams.yml 都写上了改写的两个', () => {
    const notices = readFileSync(join(BUNDLED_SKILLS_DIR, 'THIRD-PARTY-NOTICES'), 'utf8')
    expect(notices).toMatch(/Used in:[^=]*cold-email, prospecting/)
    const upstreams = readFileSync(
      fileURLToPath(new URL('../../../upstreams.yml', import.meta.url)),
      'utf8',
    )
    for (const name of B2B_PORTED) {
      expect(upstreams).toContain(`      - skills/${name}\n`)
      expect(upstreams).toContain(`packages/skills/bundled/${name}/SKILL.md`)
    }
  })
})

/**
 * WP209：技能页「先分类、再展开」要的几格，**只加在 frontmatter 里**（正文不动）。
 *
 * - `display_name` / `display_name_en`：卡上的标题（不再拿英文 id 当标题）；
 * - `summary` / `summary_en`：卡上那一句（36 §7：一行以内）；
 * - `positions`（可选）：职责 yml 反查不到岗位的，写 `common` 归「通用」。
 */
describe('WP209 frontmatter：中文显示名与一句话说明', () => {
  it.each(names)('%s 有中英显示名与一句话', (name) => {
    const { frontmatter } = splitFrontmatter(readBundledSkill(name).markdown)
    for (const key of ['display_name', 'display_name_en', 'summary', 'summary_en']) {
      expect(frontmatter.extra[key]?.trim() ?? '', `${name} 缺 ${key}`).not.toBe('')
    }
    // 一句话就是一句话：中文 30 字以内，英文 12 个词以内
    expect([...(frontmatter.extra.summary ?? '')].length).toBeLessThanOrEqual(30)
    expect((frontmatter.extra.summary_en ?? '').split(/\s+/).length).toBeLessThanOrEqual(12)
  })

  it('入库后 frontmatterOf 读得到这几格（技能页从这里取）', async () => {
    const { skills } = makeSkills()
    const md = readBundledSkill('policy-review').markdown
    await skills.registry.putFromMarkdown({
      markdown: md,
      tier: 'package',
      owner: 'package',
      version: '1.0.0',
    })
    const fm = skills.registry.frontmatterOf('policy-review')
    expect(fm?.extra.display_name).toBe('政策核对')
    expect(fm?.extra.positions).toBe('common')
    expect(skills.registry.frontmatterOf('nope')).toBeUndefined()
  })
})
