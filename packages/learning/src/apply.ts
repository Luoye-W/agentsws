/**
 * 采纳落地（24 §2 表第一行「个人化修改 → 直接写个人 overlay，版本 +1，可回滚」）。
 *
 * 这一步是学习回路里**唯一**会改技能的地方，而且只有在人按了"采纳"之后才走到。
 * 落下去的每一段都带出处：`origin: 'learned'` + `learned_from.lessons`，
 * 所以界面上能标出"Agent 于 9-7 根据 3 次纠正改的"，也能整体回滚（06 §3.4 纪律）。
 *
 * 驳回不是什么都不做：语义键进黑名单，同类经验以后不再提。
 */
import type { Iso8601, Overlay, OverlayOp, PersonId, SkillTier } from '@agentsws/contracts'
import { invalidInput } from './errors.js'
import type { LessonProposalCard, ProposalOption } from './proposals.js'
import { OPTION_NONE } from './proposals.js'
import type { PooledLesson, RejectedKey } from './types.js'

/** 学习回路能落到的三层（`package` 是上游包，学不进去）。 */
export type LearnableTier = Extract<SkillTier, 'company' | 'department' | 'personal'>

export interface OverlayWriter {
  getOverlay(skill: string, tier: SkillTier, owner: string): Overlay | undefined
  setOverlay(overlay: Overlay): Promise<Overlay>
  /** 该层的技能记录（有就把 version 的 patch +1）。 */
  get(
    name: string,
    tier: SkillTier,
    scope?: { workspace_id?: string; scope_id?: string; owner?: PersonId },
  ): Promise<{ name: string; version: string; sections: unknown[] } | undefined>
  /** 把该层技能的版本换成新的（24 §2「版本 +1，可回滚」）；没有这一层就什么都不做。 */
  bumpVersion?(
    name: string,
    tier: SkillTier,
    version: string,
    scope?: { workspace_id?: string; scope_id?: string; owner?: PersonId },
  ): Promise<string | undefined>
}

export interface LessonMarker {
  mark(id: string, status: PooledLesson['status'], at?: Iso8601): PooledLesson
  rejectKey(entry: Omit<RejectedKey, 'at'> & { at?: Iso8601 }): RejectedKey
}

export interface LessonDecision {
  proposal: LessonProposalCard
  action: 'accept' | 'reject' | 'ignore'
  /** 选中的候选改法；`none` = 都不要（等价于 reject 的"这一版不要"，但不进黑名单） */
  selected_option_id?: string
  /** 「编辑后采纳」：人改过的文本，优先于候选改法的 body */
  edited_text?: string
  /** 落到哪一层（按指导作用域）；缺省个人层 */
  tier?: LearnableTier
  /** 该层 overlay 的 owner：个人 = person_id，部门 = department_id，公司 = workspace_id */
  owner: string
  by: PersonId
  at: Iso8601
  /** overlay 的 base_version（上游当前版本）；不给就沿用已有 overlay 的那个 */
  base_version?: string
  reason?: string
}

export interface ApplyLessonResult {
  status: 'applied' | 'declined' | 'ignored'
  ops: OverlayOp[]
  overlay?: Overlay
  /** 技能新版本（该层有技能记录时 patch +1；只有 overlay 时是 overlay 的序号） */
  skill_version?: string
  overlay_version?: number
  /** 进了黑名单的语义键（驳回时） */
  blacklisted?: string
  lessons: string[]
}

/** `1.4` → `1.4.1`；`1.4.2` → `1.4.3`；非语义版本原样加 `+1` 后缀。 */
export function bumpPatch(version: string): string {
  const m = /^(\d+)\.(\d+)(?:\.(\d+))?$/.exec(version.trim())
  if (m === null) return `${version}+1`
  const patch = m[3] === undefined ? 1 : Number.parseInt(m[3], 10) + 1
  return `${m[1]}.${m[2]}.${patch}`
}

function optionOf(
  proposal: LessonProposalCard,
  id: string | undefined,
): ProposalOption | undefined {
  const wanted = id ?? proposal.options.find((o) => o.id !== OPTION_NONE)?.id
  const hit = proposal.options.find((o) => o.id === wanted)
  if (hit === undefined || hit.id === OPTION_NONE) return undefined
  return hit as ProposalOption
}

/**
 * 把一个决定落下去。
 *
 * - `accept` + 某个候选（或"编辑后采纳"）→ 写 overlay、技能版本 +1、lesson 记 accepted
 * - `accept` + `none`（都不要）→ 不写 overlay，lesson 记 ignored（置信度衰减，不进黑名单）
 * - `reject` → 不写 overlay，lesson 记 refuted，语义键进黑名单
 * - `ignore`（稍后 / 没理）→ 置信度 ×0.7
 */
export async function applyLessonDecision(
  decision: LessonDecision,
  deps: { registry: OverlayWriter; pool?: LessonMarker },
): Promise<ApplyLessonResult> {
  const { proposal } = decision
  const lessons = [...proposal.lessons]

  if (decision.action === 'reject') {
    for (const id of lessons) deps.pool?.mark(id, 'refuted', decision.at)
    deps.pool?.rejectKey({
      workspace_id: proposal.workspace_id,
      semantic_key: proposal.semantic_key,
      skill: proposal.skill,
      reason: decision.reason ?? 'rejected_by_person',
      by: decision.by,
      at: decision.at,
    })
    return {
      status: 'declined',
      ops: [],
      blacklisted: proposal.semantic_key,
      lessons,
    }
  }

  if (decision.action === 'ignore') {
    for (const id of lessons) deps.pool?.mark(id, 'ignored', decision.at)
    return { status: 'ignored', ops: [], lessons }
  }

  const option = optionOf(proposal, decision.selected_option_id)
  if (option === undefined) {
    // "都不要"：这一版不要，但不是"这条经验错了"——不进黑名单
    for (const id of lessons) deps.pool?.mark(id, 'ignored', decision.at)
    return { status: 'ignored', ops: [], lessons }
  }

  const body = (decision.edited_text ?? option.body).trim()
  if (body === '') throw invalidInput('采纳的正文不能为空')

  const tier: LearnableTier = decision.tier ?? 'personal'
  const existing = deps.registry.getOverlay(proposal.skill, tier, decision.owner)
  const op: OverlayOp = {
    op: option.op,
    section_id: option.section_id,
    body,
    origin: 'learned',
    learned_from: { lessons, at: decision.at },
  }
  // 同一段已经学过一条：换掉那一条，不叠成两条（否则技能会越长越啰嗦）
  const ops: OverlayOp[] = [
    ...(existing?.ops ?? []).filter(
      (o) => !(o.section_id === op.section_id && o.origin === 'learned'),
    ),
    op,
  ]

  const scope = ownerScope(tier, decision.owner)
  const skillAtTier = await deps.registry.get(proposal.skill, tier, scope)
  const base_version =
    decision.base_version ?? existing?.base_version ?? skillAtTier?.version ?? '0.0.0'

  const overlay = await deps.registry.setOverlay({
    skill: proposal.skill,
    tier,
    owner: decision.owner,
    ops,
    base_version,
    version: existing?.version ?? 0,
  })

  for (const id of lessons) deps.pool?.mark(id, 'accepted', decision.at)

  // 24 §2：这一层有自己的技能记录时，版本 patch +1（可回滚到上一版）
  let skill_version: string | undefined
  if (skillAtTier !== undefined) {
    const next = bumpPatch(skillAtTier.version)
    skill_version = (await deps.registry.bumpVersion?.(proposal.skill, tier, next, scope)) ?? next
  }

  return {
    status: 'applied',
    ops,
    overlay,
    overlay_version: overlay.version,
    ...(skill_version === undefined ? {} : { skill_version }),
    lessons,
  }
}

function ownerScope(
  tier: LearnableTier,
  owner: string,
): { workspace_id?: string; scope_id?: string; owner?: PersonId } {
  if (tier === 'personal') return { owner }
  if (tier === 'department') return { scope_id: owner }
  return { workspace_id: owner }
}
