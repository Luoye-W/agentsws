/**
 * 岗位汇总页（docs/113 §2.1）：官网「岗位」页那十个岗位（`i18n/roles.ts`，网址用它的英文 id），
 * 每个岗位一页，列头上 `positions` 里写了这个岗位的教程。一篇都没有的岗位不出页。
 */
import { ROLES, type Role } from '../i18n/roles.js'
import { siteCatalog } from './catalog.js'
import type { HelpDoc } from './help.js'
import type { Lang } from './markdown.js'

export interface RoleHub {
  role: Role
  own: HelpDoc[]
  general: HelpDoc[]
}

export function roleHub(id: string, lang: Lang): RoleHub | undefined {
  const role = ROLES[lang].find((r) => r.id === id)
  if (role === undefined) return undefined
  const guides = siteCatalog().guides[lang]
  const own = guides.filter((d) => d.positions.includes(role.position))
  if (own.length === 0) return undefined
  const general = guides.filter((d) => d.positions.length === 0 && d.roles.length === 0)
  return { role, own, general }
}

/** 有教程的岗位 id（顺序照「岗位」页）。 */
export function hubIds(lang: Lang = 'zh'): string[] {
  return ROLES[lang].filter((r) => roleHub(r.id, lang) !== undefined).map((r) => r.id)
}
