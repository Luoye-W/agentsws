/**
 * Profile 与公开级别（41 §1.3）。
 *
 * 纯函数：默认值、补丁合并、按问方身份过滤。没有 IO、不产生时间——`updated_at` 由调用方给。
 *
 * 一条纪律：**公开级别本身只有本人看得到**。别人拿到的 `VisibleProfile` 里没有 `disclosure`
 * ——否则"我把日程藏起来了"这件事本身就成了一条泄漏。
 */
import type { Iso8601, PersonId, WorkspaceId } from '@agentsws/contracts'
import {
  COLLEAGUES_CEILING,
  DEFAULT_AVAILABILITY,
  DEFAULT_DISCLOSURE,
  type DisclosureLevel,
  type PersonProfile,
  PROFILE_FIELDS,
  type ProfileField,
  type ProfilePatch,
  type ProfileRecord,
  type ProfileSkill,
  type Relation,
  type VisibleProfile,
} from './types.js'

/** 一个人没设过任何东西时的 profile（41 §1.3 默认列）。 */
export function defaultProfile(input: {
  workspace_id: WorkspaceId
  person_id: PersonId
  at: Iso8601
}): ProfileRecord {
  return {
    schema_version: 1,
    workspace_id: input.workspace_id,
    person_id: input.person_id,
    skills: [],
    contact_policy: { prefer: 'secretary' },
    availability: cloneAvailability(DEFAULT_AVAILABILITY),
    disclosure: { ...DEFAULT_DISCLOSURE },
    updated_at: input.at,
  }
}

function cloneAvailability(a: ProfileRecord['availability']): ProfileRecord['availability'] {
  return {
    rules: a.rules.map((r) => ({ days: [...r.days], from: r.from, to: r.to })),
    default_minutes: a.default_minutes,
    ...(a.max_meetings_per_day === undefined
      ? {}
      : { max_meetings_per_day: a.max_meetings_per_day }),
  }
}

/**
 * 级别的强弱：`self` < `colleagues` < `workspace`（越往右看得见的人越多）。
 * 41 §1.3 里"日程明细"那一行没有"全工作区"那一格，所以它被 {@link COLLEAGUES_CEILING} 压住。
 */
const RANK: Record<DisclosureLevel, number> = { self: 0, colleagues: 1, workspace: 2 }

export function clampLevel(field: ProfileField, level: DisclosureLevel): DisclosureLevel {
  if (COLLEAGUES_CEILING.includes(field) && level === 'workspace') return 'colleagues'
  return level
}

/** 问方看不看得见这个级别的东西。 */
export function visibleTo(level: DisclosureLevel, relation: Relation): boolean {
  if (relation === 'self') return true
  if (relation === 'colleague') return RANK[level] >= RANK.colleagues
  return RANK[level] >= RANK.workspace
}

function mergeContact(
  prev: ProfileRecord['contact_policy'],
  patch: ProfilePatch['contact_policy'],
): ProfileRecord['contact_policy'] {
  if (patch === undefined) return { ...prev }
  const note = patch.note ?? prev.note
  return {
    prefer: patch.prefer ?? prev.prefer,
    ...(note === undefined || note === '' ? {} : { note }),
  }
}

function mergeAvailability(
  prev: ProfileRecord['availability'],
  patch: ProfilePatch['availability'],
): ProfileRecord['availability'] {
  if (patch === undefined) return cloneAvailability(prev)
  const rules = (patch.rules ?? prev.rules).map((r) => ({
    days: [...r.days],
    from: r.from,
    to: r.to,
  }))
  const cap = patch.max_meetings_per_day ?? prev.max_meetings_per_day
  return {
    rules,
    default_minutes: patch.default_minutes ?? prev.default_minutes,
    ...(cap === undefined ? {} : { max_meetings_per_day: cap }),
  }
}

/** 合并补丁：只覆盖给了的字段；`disclosure` 逐字段合并并按上限收紧。 */
export function applyProfilePatch(
  prev: ProfileRecord,
  patch: ProfilePatch,
  at: Iso8601,
): ProfileRecord {
  const disclosure = { ...prev.disclosure }
  for (const field of PROFILE_FIELDS) {
    const wanted = patch.disclosure?.[field]
    if (wanted !== undefined) disclosure[field] = clampLevel(field, wanted)
  }
  return {
    ...prev,
    skills: patch.skills === undefined ? prev.skills : dedupeSkills(patch.skills),
    contact_policy: mergeContact(prev.contact_policy, patch.contact_policy),
    availability: mergeAvailability(prev.availability, patch.availability),
    disclosure,
    updated_at: at,
  }
}

/** 同名只留一条（本人写的赢过算出来的）。 */
export function dedupeSkills(skills: readonly ProfileSkill[]): ProfileSkill[] {
  const order: Record<ProfileSkill['source'], number> = { self: 0, skill: 1, memory: 2 }
  const byName = new Map<string, ProfileSkill>()
  for (const s of skills) {
    const key = s.name.trim().toLowerCase()
    if (key === '') continue
    const prev = byName.get(key)
    if (prev === undefined || order[s.source] < order[prev.source]) byName.set(key, { ...s })
  }
  return [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

/**
 * 按问方身份过滤出他看得到的那一份。
 *
 * 藏起来的字段进 `hidden_fields`——界面上照着它写"这个要问本人"，而不是假装那个字段不存在。
 */
export function visibleProfile(profile: PersonProfile, relation: Relation): VisibleProfile {
  const hidden: ProfileField[] = []
  const can = (field: ProfileField): boolean => {
    const ok = visibleTo(profile.disclosure[field], relation)
    if (!ok) hidden.push(field)
    return ok
  }
  const positions = can('positions')
  const ranges = can('ranges')
  // in_progress / agenda_detail 不在 profile 上，但要让问方知道它们被藏了
  can('in_progress')
  can('agenda_detail')
  const skills = can('skills')
  const availability = can('availability')
  const contact = can('contact')
  return {
    person_id: profile.person_id,
    name: profile.name,
    relation,
    hidden_fields: hidden,
    ...(positions ? { positions: profile.positions } : {}),
    ...(ranges ? { ranges: profile.ranges } : {}),
    ...(skills ? { skills: profile.skills.filter((s) => s.hidden !== true) } : {}),
    ...(availability ? { availability: profile.availability } : {}),
    ...(contact ? { contact_policy: profile.contact_policy } : {}),
    ...(relation === 'self' ? { disclosure: profile.disclosure } : {}),
  }
}

/** 问方与被问者的关系。跨工作区（20 Join）后置，所以不在同一个工作区就是外人。 */
export function relationOf(input: {
  viewer: PersonId
  subject: PersonId
  same_workspace: boolean
}): Relation {
  if (input.viewer === input.subject) return 'self'
  return input.same_workspace ? 'colleague' : 'outsider'
}
