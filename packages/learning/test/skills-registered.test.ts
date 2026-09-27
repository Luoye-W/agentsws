/**
 * WP162 §4：**登记即要有正文**。
 *
 * 职责 YAML 的 `skills:` 只写名字；名字对不上正文，那一本就永远进不了模型
 * （always 的少一段 persona，按需的索引里不列、读也读不到），而且不报错——
 * 09-27 Fable 核实时 `brand-voice` 挂在 19 条职责上，仓库里一个字的正文都没有。
 *
 * 这里扫全部职责 YAML（内置 `packages/roles/roles`、模拟包 `packs/<包>/roles`、职责包
 * `role-packs/<包>/roles`）：每个登记的技能名，要么在 `packages/skills/bundled/` 里有正文，
 * 要么在 `DYNAMIC_SKILL_SOURCES` 里写明正文从哪来。
 */
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BUNDLED_ROLES_DIR, loadRole } from '@agentsws/roles'
import { DYNAMIC_SKILL_SOURCES, listBundledSkills } from '@agentsws/skills'
import { describe, expect, it } from 'vitest'

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))

function ymlUnder(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) ymlUnder(p, out)
    else if (/\.ya?ml$/.test(e.name)) out.push(p)
  }
  return out
}

function subRoles(parent: string): string[] {
  const dir = join(ROOT, parent)
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .flatMap((d) => ymlUnder(join(dir, d.name, 'roles')))
}

const FILES = [...ymlUnder(BUNDLED_ROLES_DIR), ...subRoles('packs'), ...subRoles('role-packs')]

/** 技能名 → 登记它的职责（`文件里的 id`）。 */
const registered = new Map<string, string[]>()
for (const file of FILES) {
  const role = loadRole(file)
  for (const s of role.skills) {
    const list = registered.get(s.name) ?? []
    list.push(role.id)
    registered.set(s.name, list)
  }
}

describe('登记即要有正文（WP162 §4）', () => {
  it('扫得到三处的职责 YAML', () => {
    expect(FILES.some((f) => f.includes('/packages/roles/roles/'))).toBe(true)
    expect(FILES.some((f) => f.includes('/packs/'))).toBe(true)
    expect(FILES.some((f) => f.includes('/role-packs/'))).toBe(true)
    expect(registered.size).toBeGreaterThan(5)
  })

  const bundled = new Set(listBundledSkills())
  for (const [name, roles] of [...registered].sort(([a], [b]) => a.localeCompare(b))) {
    it(`${name}（${roles.length} 条职责）：包里有正文，或写明了动态来源`, () => {
      const source = DYNAMIC_SKILL_SOURCES[name]
      expect(
        bundled.has(name) || (source !== undefined && source.trim().length > 20),
        `${name} 登记在 ${roles.join('、')}，但 packages/skills/bundled/${name}/SKILL.md 不存在，也不在 DYNAMIC_SKILL_SOURCES 里`,
      ).toBe(true)
    })
  }

  it('动态来源表里的名字不和包里的重名（两处都有就说不清以谁为准）', () => {
    for (const name of Object.keys(DYNAMIC_SKILL_SOURCES)) expect(bundled.has(name)).toBe(false)
  })
})
