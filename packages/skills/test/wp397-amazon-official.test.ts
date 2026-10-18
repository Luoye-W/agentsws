/**
 * WP397（docs/106 §13，A13）：Amazon 官方卖家技能 12 本——原样收录、旁注另放、入库时拼。
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  AUTHORIZATION_PHRASE_EXCEPTIONS,
  BUNDLED_SKILLS_DIR,
  demoteHeadings,
  findAuthorizationPhrases,
  listBundledSkills,
  readBundledSkill,
  readOfficialSkillMeta,
  splitFrontmatter,
  splitSections,
} from '../src/index.js'
import { makeSkills } from './helpers.js'

const sha = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex')

/** 上游 `skills/` 下的 12 本（钉 8d90d3b）。 */
export const AMAZON_OFFICIAL_UPSTREAM = [
  'fba-inbound-management',
  'finance-month-end-closer',
  'invite-secondary-users',
  'listing-buyability',
  'listing-compliance',
  'listing-issues',
  'listing-searchability',
  'listing-troubleshooter',
  'seller-analytics',
  'sp-api-knowledge',
  'stockout-prevention',
  'support-case-helper',
] as const
export const AMAZON_OFFICIAL = AMAZON_OFFICIAL_UPSTREAM.map((n) => `amazon-sp-${n}`)
const COMMIT = '8d90d3b7c1537254b53c82651ac31fdbf0089368'

describe('WP397 Amazon 官方技能：原样收录', () => {
  it('12 本都在，目录名 = amazon-sp-<上游名>', () => {
    const names = listBundledSkills()
    for (const n of AMAZON_OFFICIAL) expect(names, n).toContain(n)
    expect(names.filter((n) => n.startsWith('amazon-sp-')).sort()).toEqual(
      [...AMAZON_OFFICIAL].sort(),
    )
  })

  for (const upstream of AMAZON_OFFICIAL_UPSTREAM) {
    const name = `amazon-sp-${upstream}`
    describe(name, () => {
      const meta = readOfficialSkillMeta(name)
      const root = join(BUNDLED_SKILLS_DIR, name)

      it('旁注：Amazon 官方仓库、Apache-2.0、钉提交、路径对得上；入库名换成目录名', () => {
        expect(meta?.upstream).toMatchObject({
          publisher: 'Amazon',
          repo: 'amzn/selling-partner-agentic-toolkit',
          commit: COMMIT,
          path: `skills/${upstream}`,
          license: 'Apache-2.0',
        })
        expect(meta?.name).toBe(name)
        expect(meta?.frontmatter).toMatchObject({
          license: 'Apache-2.0',
          origin: 'official',
          positions: 'amazon-ops',
        })
      })

      it('官方文件一个字节没改：sha256 与登记的一致；LICENSE 原样带着', () => {
        expect(Object.keys(meta?.sha256 ?? {}).sort()).toEqual(
          ['LICENSE', 'SKILL.md', ...(meta?.references ?? [])].sort(),
        )
        for (const [file, hash] of Object.entries(meta?.sha256 ?? {})) {
          expect(sha(join(root, file)), file).toBe(hash)
        }
        expect(readFileSync(join(root, 'LICENSE'), 'utf8')).toContain(
          'Copyright Amazon.com, Inc. or its affiliates.',
        )
        // 上游的 eval/（要上游的模拟服务器）不搬；我们的考题在 evals/
        expect(existsSync(join(root, 'eval'))).toBe(false)
        expect(existsSync(join(root, 'scripts'))).toBe(false)
      })

      it('拼出来的那一份：name 是目录名、上游原名记在 upstream_name；前言在最前', () => {
        const md = readBundledSkill(name).markdown
        const { frontmatter, body } = splitFrontmatter(md)
        expect(frontmatter.name).toBe(name)
        expect(frontmatter.extra.upstream_name).toBe(upstream)
        expect(frontmatter.extra.metadata).toBeUndefined()
        const headings = splitSections(body)
          .map((s) => s.heading)
          .filter((h) => h !== '')
        expect(headings[0]).toBe('Agents 工坊里怎么用这本（以本段为准）')
        expect(headings[1]).toContain('Amazon 官方正文（amzn/selling-partner-agentic-toolkit')
        expect(new Set(headings).size).toBe(headings.length)
        const official = splitFrontmatter(readFileSync(join(root, 'SKILL.md'), 'utf8')).body.trim()
        expect(md).toContain(demoteHeadings(official))
      })

      it('前言六条规矩都在：没连上照实说、出卡、不给定价建议、数字不编、14 天、带前缀的兄弟名', () => {
        const md = readBundledSkill(name).markdown
        expect(md).toContain('连上 Amazon 店铺后才能做')
        expect(md).toContain('写动作一律出卡：预览 → 人批 → 回读')
        expect(md).toContain('自动化级别只由职责设置决定，这本技能不改变它')
        expect(md).toContain('不给定价建议')
        expect(md).toContain('数字不编')
        expect(md).toContain('可售天数少于 14 天')
        expect(md).toContain('`amazon-sp-` 前缀')
      })

      it('授权字样：只有逐字登记的那一句「禁止」放行，别处一个都没有', () => {
        const md = readBundledSkill(name).markdown
        expect(findAuthorizationPhrases(md, AUTHORIZATION_PHRASE_EXCEPTIONS[name] ?? [])).toEqual(
          [],
        )
      })

      it('考题：出卡 / 数字不编 / 没连上照实说 三类都有，每条规矩都在正文里', () => {
        const { markdown, evals } = readBundledSkill(name)
        expect(evals.length).toBeGreaterThanOrEqual(3)
        expect(new Set(evals.map((e) => e.id)).size).toBe(evals.length)
        const kinds = new Set(evals.map((e) => e.kind))
        expect(kinds).toContain('approval')
        expect(kinds).toContain('numbers')
        expect(evals.some((e) => e.must_include.includes('连上 Amazon 店铺后才能做'))).toBe(true)
        for (const e of evals) {
          expect(e.from, e.id).toBeTruthy()
          for (const piece of e.must_include)
            expect(markdown, `${e.id} 缺：${piece}`).toContain(piece)
        }
      })
    })
  }

  it('专项规矩：FBA 入库报金额人手动确认；开工单不确认不提交；月结只读、税交专业人士', () => {
    expect(readBundledSkill('amazon-sp-fba-inbound-management').markdown).toContain(
      'FBA 入库确认运费：金额写清楚、人手动确认',
    )
    expect(readBundledSkill('amazon-sp-support-case-helper').markdown).toContain(
      '开工单不确认不提交',
    )
    expect(readBundledSkill('amazon-sp-finance-month-end-closer').markdown).toContain(
      '税务会计结论交专业人士',
    )
  })

  it('例外表只给原样收录的技能用，放行的整句在官方正文里逐字存在', () => {
    for (const [name, sentences] of Object.entries(AUTHORIZATION_PHRASE_EXCEPTIONS)) {
      expect(readOfficialSkillMeta(name), name).toBeDefined()
      const official = readFileSync(join(BUNDLED_SKILLS_DIR, name, 'SKILL.md'), 'utf8')
      for (const s of sentences) expect(official, s).toContain(s)
    }
  })

  it('加载器吃得进去：入库后按目录名 resolve 得回来', async () => {
    const { skills } = makeSkills()
    const skill = readBundledSkill('amazon-sp-stockout-prevention')
    await skills.registry.putFromMarkdown({
      markdown: skill.markdown,
      tier: 'package',
      owner: 'package',
      version: '1.0.0',
    })
    const resolved = await skills.registry.resolve('amazon-sp-stockout-prevention', {
      person_id: 'p_1',
      workspace_id: 'ws_1',
      role_id: 'amz.store',
    })
    expect(resolved?.markdown).toContain('## 官方参考：price-change-guardrails')
  })
})

describe('WP397 上游登记与第三方声明', () => {
  const upstreams = readFileSync(
    fileURLToPath(new URL('../../../upstreams.yml', import.meta.url)),
    'utf8',
  )
  it('upstreams.yml：仓库、钉住的提交与收录路径', () => {
    expect(upstreams).toContain('repo: amzn/selling-partner-agentic-toolkit')
    expect(upstreams).toContain(`pinned_commit: ${COMMIT}`)
  })
  it('THIRD-PARTY-NOTICES：Apache-2.0 声明与 Amazon 版权行', () => {
    const notices = readFileSync(join(BUNDLED_SKILLS_DIR, 'THIRD-PARTY-NOTICES'), 'utf8')
    expect(notices).toContain('amzn/selling-partner-agentic-toolkit')
    expect(notices).toContain('Copyright Amazon.com, Inc. or its affiliates.')
    expect(notices).toContain('Licensed under the Apache License, Version 2.0')
  })
})
