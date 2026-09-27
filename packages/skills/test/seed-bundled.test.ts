/**
 * WP162：自带技能入库（包基础层）。
 *
 * 钉住四件事：
 * 1. 头一回全部种进去，`resolve` 读得到（包层不分工作区）；
 * 2. 同一个版本再种一次 → 全部跳过，不多一条历史；
 * 3. 包里版本新了 → 只换包层；公司层的记录与个人层的覆盖一个字不动，照旧压在上面；
 * 4. 之前按工作区种过的那一份（WP29 的 customer-care）原样认得。
 */
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  BUNDLED_SKILLS_DIR,
  bundledSkillVersion,
  compareSkillVersions,
  listBundledSkills,
  readBundledSkill,
  seedBundledSkills,
} from '../src/index.js'
import { makeSkills } from './helpers.js'

const actor = (workspace_id: string) => ({ person_id: 'p_1', workspace_id, role_id: 'dtc.support' })

describe('版本号', () => {
  it('按段比数字，缺的段当 0', () => {
    expect(compareSkillVersions('1.0', '1.0.0')).toBe(0)
    expect(compareSkillVersions('1.0.1', '1.0')).toBe(1)
    expect(compareSkillVersions('1.2.10', '1.2.9')).toBe(1)
    expect(compareSkillVersions('0.9', '1.0.0')).toBe(-1)
  })

  it('frontmatter 没写 version 的按 1.0（customer-care）', () => {
    expect(bundledSkillVersion(readBundledSkill('customer-care').markdown)).toBe('1.0')
    expect(bundledSkillVersion(readBundledSkill('email-sms').markdown)).toBe('1.0.0')
  })
})

describe('seedBundledSkills', () => {
  it('头一回：全部入包层，任何工作区都 resolve 得到', async () => {
    const { skills } = makeSkills()
    const out = await seedBundledSkills(skills.registry)
    expect(out.seeded).toEqual(listBundledSkills())
    expect(out.replaced).toEqual([])
    for (const name of listBundledSkills()) {
      for (const ws of ['ws_1', 'ws_2']) {
        const r = await skills.registry.resolve(name, actor(ws))
        expect(r?.layers_applied, `${name}@${ws}`).toEqual(['package'])
      }
      const stored = await skills.registry.get(name, 'package')
      expect(stored?.owner).toBe('package')
      expect(stored?.version).toBe(bundledSkillVersion(readBundledSkill(name).markdown))
    }
  })

  it('同一版本再种一次：全部跳过', async () => {
    const { skills } = makeSkills()
    await seedBundledSkills(skills.registry)
    const again = await seedBundledSkills(skills.registry)
    expect(again.seeded).toEqual([])
    expect(again.replaced).toEqual([])
    expect(again.skipped).toEqual(listBundledSkills())
  })

  it('包里版本新了：只换包层，公司层与个人覆盖不动、照旧压在上面', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wp162-bundled-'))
    cpSync(join(BUNDLED_SKILLS_DIR, 'email-sms'), join(dir, 'email-sms'), { recursive: true })
    const { skills } = makeSkills()
    await seedBundledSkills(skills.registry, { dir })

    // 公司层写了自己的一段；个人层把「你做什么」那一段追加了一句
    await skills.registry.putFromMarkdown({
      markdown: '---\nname: email-sms\n---\n\n## 公司的规矩\n\n周末不群发。\n',
      tier: 'company',
      owner: 'p_owner' as never,
      version: '1.0',
      workspace_id: 'ws_1',
    })
    const section = (await skills.registry.get('email-sms', 'package'))?.sections.find(
      (s) => s.heading === '你做什么',
    )
    expect(section).toBeDefined()
    await skills.registry.setOverlay({
      skill: 'email-sms',
      tier: 'personal',
      owner: 'p_1',
      base_version: '1.0.0',
      version: 0,
      ops: [{ op: 'append', section_id: section?.id ?? '', body: '我习惯先看退订率。' }],
    } as never)

    const path = join(dir, 'email-sms', 'SKILL.md')
    const md = readFileSync(path, 'utf8')
    writeFileSync(
      path,
      md
        .replace('version: 1.0.0', 'version: 1.1.0')
        .replace('## 你做什么', '## 你做什么\n\n（新版）'),
    )
    const out = await seedBundledSkills(skills.registry, { dir })
    expect(out.replaced).toEqual(['email-sms'])
    expect((await skills.registry.get('email-sms', 'package'))?.version).toBe('1.1.0')

    const company = await skills.registry.get('email-sms', 'company', { workspace_id: 'ws_1' })
    expect(company?.version).toBe('1.0')
    const r = await skills.registry.resolve('email-sms', actor('ws_1'))
    expect(r?.markdown).toContain('（新版）')
    expect(r?.markdown).toContain('周末不群发。')
    expect(r?.markdown).toContain('我习惯先看退订率。')
    expect(r?.layers_applied).toEqual(['package', 'company', 'personal'])
  })

  it('WP29 按工作区种过的 customer-care：认得，同版本不重种', async () => {
    const { skills } = makeSkills()
    await skills.registry.putFromMarkdown({
      markdown: readBundledSkill('customer-care').markdown,
      tier: 'package',
      owner: 'package',
      version: '1.0',
      workspace_id: 'ws_1',
    })
    const out = await seedBundledSkills(skills.registry)
    expect(out.skipped).toContain('customer-care')
    expect(out.seeded).not.toContain('customer-care')
  })

  it('被本人排除的技能照旧读不到', async () => {
    const { skills } = makeSkills()
    await seedBundledSkills(skills.registry)
    await skills.registry.exclude('email-sms', 'p_1', true)
    expect(await skills.registry.resolve('email-sms', actor('ws_1'))).toBeUndefined()
  })
})
