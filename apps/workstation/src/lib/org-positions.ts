/**
 * WP235（Fable 10-06 Windows 真机）：公司页「岗位」页签的分块与「真在做的职责」。
 *
 * 公司页以前把出厂的十一个模板全列出来（连「普通成员」都在），用户真正在做的岗位淹在里面；
 * 合并也是对模板整包操作。现在：
 *
 * - **你们的岗位**：有人在做的岗位 + 自建岗位。合并 / 移动 / 拆出只在这一块里；
 * - **可以加的岗位（模板）**：没人在做的出厂模板，折叠收着；
 * - 「负责人」（页顶身份卡）与「普通成员」（底座身份）不进岗位清单。
 *
 * 规则与服务端 `org.ts` 的 `dutiesInUse` 同一条：模板只算有人做的那几条，自建岗位整份都算。
 */
import { mergedPositionName } from '@agentsws/contracts'
import type { OrgPositionView } from '@/lib/api'

/** 「负责人」那个岗位行的 id（身份，在页顶，不在岗位清单里）。 */
export const OWNER_POSITION = 'owner'
/** 「普通成员」：只有底座职责的那一行，是身份不是岗位。 */
export const MEMBER_POSITION = 'member'

const isBase = (role_id: string): boolean => role_id.startsWith('common.')

/** 这个岗位真在做的职责（按岗位行的顺序）。老服务端没给 `role_ids` 时退回整份清单。 */
export function dutiesInUse(p: OrgPositionView): OrgPositionView['roles'] {
  const duties = p.roles.filter((r) => !isBase(r.role_id))
  if (p.source === 'custom') return duties
  if (p.holders.some((h) => h.role_ids === undefined)) return duties
  const held = new Set(p.holders.flatMap((h) => h.role_ids ?? []))
  return duties.filter((r) => held.has(r.role_id))
}

/** 「你们的岗位」与「可以加的岗位（模板）」两块。 */
export function splitPositions(positions: readonly OrgPositionView[]): {
  ours: OrgPositionView[]
  templates: OrgPositionView[]
} {
  const listed = positions.filter((p) => p.id !== OWNER_POSITION && p.id !== MEMBER_POSITION)
  const ours = listed.filter((p) => p.source === 'custom' || p.holders.length > 0)
  return { ours, templates: listed.filter((p) => !ours.includes(p)) }
}

/**
 * 合并后那个岗位的建议名：目标是自建岗位就沿用它的名字；目标是模板（会另建一个）就按两边真在做的
 * 职责起——都是同一个渠道叫「Reddit 运营」，否则沿用目标的名字。
 */
export function suggestMergedName(
  from: OrgPositionView,
  into: OrgPositionView,
  lang: 'zh' | 'en' = 'zh',
): string {
  const fallback = lang === 'en' && into.name_en !== '' ? into.name_en : into.name
  if (into.source === 'custom') return fallback
  return mergedPositionName(
    [...dutiesInUse(into), ...dutiesInUse(from)].map((r) => r.role_id),
    fallback,
    lang,
  )
}
