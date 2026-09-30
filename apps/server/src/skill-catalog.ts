/**
 * WP209：技能页「先分类、再展开」要的那几格——**按岗位分组**的真源在这里。
 *
 * `learning.summaries` 回的是「版本、三层改动、待审数」（WP29）；这里只往每一行上**加**几格：
 *
 * - `display_name` / `summary` / `description`：SKILL.md frontmatter 里的（没有就不回，
 *   工作台退回英文 id）；
 * - `roles`：职责 yml 的 `skills:` 反查——哪几条职责在用它；
 * - `positions`：那几条职责挂在哪几个岗位下，并上 frontmatter 的 `positions`（只加的可选字段）。
 *   挂在 `common.*` 上的算「通用」（`common`）；挂在超过一半岗位上的也只进「通用」；只挂在没进任何岗位模板的职责上、或者谁都没挂的
 *   → 也归「通用」；
 * - `in_use`：本人名下有没撤销的职责在用它（「只看我在用的」）；
 * - `sections[].body`：段落正文（搜索要搜到正文）。
 *
 * 纯函数：事实（岗位模板、职责定义、本人职责、frontmatter）由调用方现查了传进来，
 * 所以同一份输入永远同一份输出，单测不用起服务进程。
 */
import type { SkillPositionRef, SkillRoleRef, SkillSummary } from '@agentsws/api'
import type { Frontmatter } from '@agentsws/skills'

/** 「通用」这一组的 id（不是一个真岗位）。 */
export const COMMON_POSITION_ID = 'common'
export const COMMON_POSITION_NAME = { zh: '通用', en: 'General' } as const

export interface SkillCatalogFacts {
  /** 岗位模板（`org.positions()`），顺序就是技能页上岗位组的顺序。 */
  positions: readonly {
    id: string
    name: { zh: string; en: string }
    roles: readonly { role: string }[]
  }[]
  /** 职责定义（`roles.roles.list()`）。 */
  roles: readonly {
    id: string
    name: { zh: string; en: string }
    skills: readonly { name: string }[]
  }[]
  /** 本人名下没撤销的职责 id。 */
  held_roles: readonly string[]
  frontmatterOf(name: string): Frontmatter | undefined
  sectionBody?(name: string, section_id: string): string | undefined
  /** 已经拆掉的岗位模板（`SUPERSEDED_POSITION_IDS`）：反查时跳过。 */
  superseded?: readonly string[]
}

/** `common.owner` / `common.member`：每个岗位都带的公共职责，不算任何一个岗位的。 */
export function isCommonRole(role_id: string): boolean {
  return role_id.startsWith('common.')
}

/** frontmatter `positions: b2b, ads` → `['b2b', 'ads']`（逗号或空白分隔）。 */
export function parsePositionsField(value: string | undefined): string[] {
  if (value === undefined) return []
  return value
    .split(/[,，\s]+/)
    .map((s) => s.trim())
    .filter((s) => s !== '')
}

function pair(
  zh: string | undefined,
  en: string | undefined,
): { zh: string; en: string } | undefined {
  const z = zh?.trim() ?? ''
  const e = en?.trim() ?? ''
  if (z === '' && e === '') return undefined
  return { zh: z === '' ? e : z, en: e === '' ? z : e }
}

export function enrichSkillSummaries(
  list: readonly SkillSummary[],
  facts: SkillCatalogFacts,
): SkillSummary[] {
  const skip = new Set(facts.superseded ?? [])
  const positions = facts.positions.filter((p) => !skip.has(p.id))
  const held = new Set(facts.held_roles)
  const positionsOfRole = (role_id: string): string[] =>
    positions.filter((p) => p.roles.some((r) => r.role === role_id)).map((p) => p.id)
  const minePositions = new Set(
    positions.filter((p) => p.roles.some((r) => held.has(r.role))).map((p) => p.id),
  )

  return list.map((summary) => {
    const fm = facts.frontmatterOf(summary.name)
    const extra = fm?.extra ?? {}

    const roles: SkillRoleRef[] = facts.roles
      .filter((r) => r.skills.some((s) => s.name === summary.name))
      .map((r) => ({
        role_id: r.id,
        name: { zh: r.name.zh, en: r.name.en },
        position_ids: positionsOfRole(r.id),
        mine: held.has(r.id),
      }))

    const ids = new Set<string>()
    for (const r of roles) {
      // `common.*`（公司设置与授权、工作区成员）每个岗位都带着一份——算它们的岗位，
      // 「工作台入门」就会出现在全部十个岗位里。它们一律归「通用」。
      if (isCommonRole(r.role_id)) ids.add(COMMON_POSITION_ID)
      else for (const id of r.position_ids) ids.add(id)
    }
    for (const id of parsePositionsField(extra.positions)) ids.add(id)
    // Fable 09-30：挂在**超过一半**岗位上的（「品牌话术」挂在 7 / 10 个岗位上）就是通用技能——
    // 只进「通用」，不在每个岗位组里重复一遍。卡上的职责小标签照旧列全（`roles` 不动）。
    const spread = [...ids].filter((id) => positions.some((p) => p.id === id)).length
    if (positions.length > 0 && spread * 2 > positions.length) {
      ids.clear()
      ids.add(COMMON_POSITION_ID)
    }
    if (ids.size === 0) ids.add(COMMON_POSITION_ID)

    // 岗位模板的顺序在前，frontmatter 里写了但模板里没有的（拼错 / 还没上线的岗位）按字母排后面，
    // 「通用」永远最后
    const known = positions.filter((p) => ids.has(p.id))
    const unknown = [...ids]
      .filter((id) => id !== COMMON_POSITION_ID && !positions.some((p) => p.id === id))
      .sort()
    const refs: SkillPositionRef[] = [
      ...known.map((p) => ({
        id: p.id,
        name: { zh: p.name.zh, en: p.name.en },
        mine: minePositions.has(p.id),
      })),
      ...unknown.map((id) => ({ id, name: { zh: id, en: id }, mine: false })),
      ...(ids.has(COMMON_POSITION_ID)
        ? [{ id: COMMON_POSITION_ID, name: { ...COMMON_POSITION_NAME }, mine: false }]
        : []),
    ]

    const display_name = pair(extra.display_name, extra.display_name_en)
    const one_line = pair(extra.summary, extra.summary_en)
    const sectionBody = facts.sectionBody
    return {
      ...summary,
      sections: summary.sections.map((s) => {
        if (s.body !== undefined || sectionBody === undefined) return s
        const body = sectionBody(summary.name, s.id)
        return body === undefined ? s : { ...s, body }
      }),
      ...(display_name === undefined ? {} : { display_name }),
      ...(one_line === undefined ? {} : { summary: one_line }),
      ...(fm?.description === undefined ? {} : { description: fm.description }),
      positions: refs,
      roles,
      in_use: roles.some((r) => r.mine),
    }
  })
}
