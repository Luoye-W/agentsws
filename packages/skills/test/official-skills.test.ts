/**
 * WP216：平台官方技能（Shopify 的 `shopify`）——原样收录、旁注另放、入库时拼。
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isPlatformSkill, PLATFORM_KITS } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import {
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

describe('WP216 Shopify 官方技能：原样收录', () => {
  const meta = readOfficialSkillMeta('shopify')
  const root = join(BUNDLED_SKILLS_DIR, 'shopify')

  it('旁注在：上游是 Shopify 官方仓库、MIT、钉了 tag 与提交', () => {
    expect(meta?.upstream).toMatchObject({
      publisher: 'Shopify',
      repo: 'Shopify/Shopify-AI-Toolkit',
      tag: 'v2.1.0',
      commit: '8692e6a449ff7f088a0c3883a357688aba9a3235',
      license: 'MIT',
    })
  })

  it('官方文件一个字节没改：每个文件的 sha256 与上游登记的一致', () => {
    expect(Object.keys(meta?.sha256 ?? {}).sort()).toEqual(
      ['LICENSE', 'SKILL.md', ...(meta?.references ?? [])].sort(),
    )
    for (const [file, hash] of Object.entries(meta?.sha256 ?? {})) {
      expect(sha(join(root, file)), file).toBe(hash)
    }
  })

  it('官方许可证原文随技能放着；上报脚本与钩子一个都没带进来', () => {
    expect(readFileSync(join(root, 'LICENSE'), 'utf8')).toContain(
      'Copyright 2025-present, Shopify Inc.',
    )
    expect(existsSync(join(root, 'scripts'))).toBe(false)
    expect(existsSync(join(root, 'hooks'))).toBe(false)
    expect(existsSync(join(root, 'package.json'))).toBe(false)
  })

  it('拼出来的那一份：官方 name / description + 我们的键；官方的 hooks 不进来', () => {
    const { frontmatter, body } = splitFrontmatter(readBundledSkill('shopify').markdown)
    expect(frontmatter.name).toBe('shopify')
    expect(frontmatter.description).toContain('Build anything on Shopify')
    expect(frontmatter.extra).toMatchObject({
      license: 'MIT',
      tier: 'open',
      version: '1.17.1',
      display_name: 'Shopify 官方（Liquid）',
      positions: 'site',
    })
    expect(frontmatter.extra.hooks).toBeUndefined()
    expect(body).not.toContain('track-telemetry.sh')
  })

  it('段落：规矩在最前，官方正文与三份参考各一段，段名唯一', () => {
    const { body } = splitFrontmatter(readBundledSkill('shopify').markdown)
    const headings = splitSections(body)
      .map((s) => s.heading)
      .filter((h) => h !== '')
    expect(headings).toEqual([
      'Agents 工坊里怎么用这本（以本段为准）',
      'Shopify 官方正文（Shopify/Shopify-AI-Toolkit v2.1.0，原样收录）',
      '官方参考：liquid（references/liquid.md，原样收录）',
      '官方参考：custom-data（references/custom-data.md，原样收录）',
      '官方参考：admin（references/admin.md，原样收录）',
    ])
  })

  it('官方正文与参考的每一行都在（只是标题降了两级）', () => {
    const md = readBundledSkill('shopify').markdown
    const official = splitFrontmatter(readFileSync(join(root, 'SKILL.md'), 'utf8')).body.trim()
    expect(md).toContain(demoteHeadings(official))
    for (const ref of meta?.references ?? []) {
      expect(md).toContain(demoteHeadings(readFileSync(join(root, ref), 'utf8').trim()))
    }
  })

  it('我们的规矩：不跑官方脚本、不发用户原话、只跑 shopify theme 那几条、出卡、自动化级别、事实卡', () => {
    const md = readBundledSkill('shopify').markdown
    expect(md).toContain('`scripts/*.mjs` 在这里没有，也不要去找、去跑')
    expect(md).toContain('用户原话不出门')
    expect(md).toContain('`shopify.docs.search`')
    expect(md).toContain('`shopify theme check --output json`')
    expect(md).toContain('`push --unpublished`')
    expect(md).toContain('出卡')
    expect(md).toContain('自动化级别')
    expect(md).toContain('事实卡')
    expect(findAuthorizationPhrases(md)).toEqual([])
  })

  it('加载器吃得进去：入库后 resolve 回来五段都在', async () => {
    const { skills } = makeSkills()
    const skill = readBundledSkill('shopify')
    await skills.registry.putFromMarkdown({
      markdown: skill.markdown,
      tier: 'package',
      owner: 'package',
      version: '1.17.1',
    })
    const resolved = await skills.registry.resolve('shopify', {
      person_id: 'p_1',
      workspace_id: 'ws_1',
      role_id: 'site.shopify-theme',
    })
    expect(resolved?.layers_applied).toEqual(['package'])
    expect(resolved?.markdown).toContain('## 官方参考：liquid')
    expect(skills.registry.frontmatterOf('shopify')?.extra.display_name).toBe(
      'Shopify 官方（Liquid）',
    )
  })
})

describe('WP216 平台套件与自带技能对得上', () => {
  it('PLATFORM_KITS 里每一本官方技能都在包里，而且是原样收录的那种（有旁注）', () => {
    const bundled = listBundledSkills()
    for (const kit of PLATFORM_KITS) {
      for (const name of kit.skills) {
        expect(bundled, name).toContain(name)
        expect(readOfficialSkillMeta(name)?.upstream.repo, name).toBe(kit.skill_source?.repo)
        expect(kit.skill_source?.install).toBe('bundled')
      }
    }
  })

  it('反过来：有官方旁注的技能都登记在某个平台下（不然它会对所有品牌生效）', () => {
    for (const name of listBundledSkills()) {
      if (readOfficialSkillMeta(name) !== undefined) expect(isPlatformSkill(name), name).toBe(true)
    }
  })
})

describe('WP216 demoteHeadings', () => {
  it('围栏外降两级、最多六级；围栏里的 # 不动', () => {
    const src = ['# A', '## B', '#### C', '##### D', '```toml', '# keep', '```', 'text #x'].join(
      '\n',
    )
    expect(demoteHeadings(src).split('\n')).toEqual([
      '### A',
      '#### B',
      '###### C',
      '###### D',
      '```toml',
      '# keep',
      '```',
      'text #x',
    ])
  })
})

/** 上游登记：每周例程靠它发现官方新版本（docs/42）。 */
describe('WP216 upstreams.yml 登记了 Shopify 官方技能', () => {
  const upstreams = readFileSync(
    fileURLToPath(new URL('../../../upstreams.yml', import.meta.url)),
    'utf8',
  )
  it('仓库、钉住的提交与收录路径都写着', () => {
    expect(upstreams).toContain('repo: Shopify/Shopify-AI-Toolkit')
    expect(upstreams).toContain('pinned_commit: 8692e6a449ff7f088a0c3883a357688aba9a3235')
    expect(upstreams).toContain('packages/skills/bundled/shopify/agentsws.json')
  })
})
