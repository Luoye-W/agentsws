/**
 * 05 §4（09-08 修订，31 §3.1）：EffectiveConfig 按**单个 Assignment**算，不做跨 Assignment 并集。
 * scopes 原样生效；额度按该 Assignment 的 role 解析；自动化等级取该 Assignment 的当前状态。
 */
import type { ChangeKind, Level, RiskClass, WriteActionSpec } from '@agentsws/contracts'
import { KIND_RISK, resolveMandate } from '@agentsws/core'
import {
  type EffectiveAction,
  type EffectiveAutomation,
  type EffectiveConfig,
  type EffectiveConfigInput,
  RoleError,
} from './types.js'

const LEVEL_ORDER: readonly Level[] = ['L1', 'L2', 'L3']
const levelIndex = (l: Level) => LEVEL_ORDER.indexOf(l)
const minLevel = (a: Level, b: Level): Level => (levelIndex(a) <= levelIndex(b) ? a : b)

/**
 * 动作 id 与 ChangeKind **名字对不上**的那几个（WP73）。
 *
 * 去前缀那一招对 `stage_post` / `stage_broadcast` 这种名字管用，对
 * `approve_member`（→ `community_membership`）与 `moderate`
 * （→ `community_moderation`）不管用：它们是动词，kind 是名词。
 *
 * 对不上的后果不是"报错"，是**悄悄降级**：`riskClassOf` 兜底成 `high`，
 * 于是职责 yml 里写着 `initial: L2` 的入群审核实际上永远落在 L1
 * （31 §3.4 只让 low 风险超过 L1）。56 §2 那一行"入群审核 L2"因此成了一句
 * 写在文件里、机器不认的话。这张表把它接上。
 *
 * **只加不删**：加一条等于承认"这个动作改的是那一类东西"，删一条会把一个
 * 动作悄悄推回 high。
 */
const KIND_ALIAS: Readonly<Record<string, ChangeKind>> = {
  approve_member: 'community_membership',
  moderate: 'community_moderation',
  /*
   * WP75（57 §1）：投放那两个。与上面两条是同一种错，只是成因不同——
   * 这两个动作 id 与 kind 名字对不上是因为 57 §1 写的是 `campaign_create` /
   * `ad_pause`，而仓里那两个 kind 从第一版起就叫 `create_campaign` / `pause_ad`
   * （契约 `ADS_KIND_ALIASES` 里有对照）。
   *
   * 不接上的后果与入群审核那一条逐字相同：`pause_ads` 对不上 kind →
   * `riskClassOf` 兜底 `high` → 31 §3.4 只让 low 超过 L1 → **止损永远落在 L1**。
   * 而止损是 04 §5 里唯一一条"该自动"的写动作：广告在烧钱的时候，Agent 反而
   * 要等人点头才能踩刹车。
   */
  stage_campaign: 'create_campaign',
  pause_ads: 'pause_ad',
  // WP78（60 §1）：公关那三个写动作的名字与 kind 也对不上（同样是动词 vs 名词）。
  //
  // `stage_external_post` 没写成 `stage_post`，是因为 `stage_post` 这个动作 id
  // 社媒九条职责已经在用了（→ `social_post`），而这张表是**按动作 id 全局查的**：
  // 写成同一个名字，两条职责里必有一条判错。名字不同不是洁癖，是这张表的形状要求。
  draft_release: 'press_release',
  stage_external_post: 'community_post',
  flag_mention: 'mention_triage',
}

/** 动作 id → 15 §2 的 ChangeKind：去掉 `stage_` / `draft_` / `propose_` 前缀后对表。 */
export function changeKindOf(actionId: string): ChangeKind | undefined {
  const alias = KIND_ALIAS[actionId]
  if (alias !== undefined) return alias
  const base = actionId.replace(/^(stage|draft|propose|apply)_/, '')
  return base in KIND_RISK ? (base as ChangeKind) : undefined
}

/**
 * 31 §3.4：每个动作的风险等级。对不上 ChangeKind 时按最严解释：
 * 只有 `outbound_message`（查单回复类）算 low，其余一律 high（= 永远人审）。
 */
export function riskClassOf(action: Pick<WriteActionSpec, 'id' | 'kind'>): RiskClass {
  const kind = changeKindOf(action.id)
  if (kind) return KIND_RISK[kind]
  return action.kind === 'outbound_message' ? 'low' : 'high'
}

export function effectiveConfig(input: EffectiveConfigInput): EffectiveConfig {
  const { assignment, role, policy } = input
  if (assignment.role_id !== role.id)
    throw new RoleError(
      'invalid_input',
      `assignment ${assignment.id} is for role ${assignment.role_id}, got ${role.id}`,
    )
  if (assignment.revoked_at)
    throw new RoleError(
      'forbidden',
      `assignment ${assignment.id} was revoked at ${assignment.revoked_at}`,
    )
  // 05 §3：Role 升 major 后要重新确认，不能拿旧分配继续用新定义。
  const major = (v: string) => v.split('.')[0]
  if (major(role.version) !== major(assignment.role_version))
    throw new RoleError(
      'conflict',
      `role ${role.id} is at ${role.version} but assignment ${assignment.id} was granted at ${assignment.role_version}; re-confirm the assignment`,
    )

  const connected = new Set(input.connected ?? [])
  const missing = role.connectors.filter((c) => c.required && !connected.has(c.kind))

  const actions: EffectiveAction[] = role.actions.map((action) => ({
    id: action.id,
    target: action.target,
    kind: action.kind,
    mandate: resolveMandate(
      action.mandate,
      policy?.mandates[action.id],
      assignment.mandate_overrides?.[action.id],
    ),
    risk_class: riskClassOf(action),
    route_to: action.route_to,
    requires_record_read: action.requires_record_read ?? false,
    protected_fields: action.protected_fields ?? [],
    review_cannot_be_disabled: action.review_cannot_be_disabled ?? false,
  }))

  const riskByAction = new Map(actions.map((a) => [a.id, a.risk_class]))
  const automation: Record<string, EffectiveAutomation> = {}
  for (const [actionId, spec] of Object.entries(role.automation)) {
    const recorded = assignment.automation_state[actionId]?.level ?? spec.initial
    const risk = riskByAction.get(actionId) ?? 'high'
    const byCeiling = minLevel(recorded, spec.ceiling)
    // 31 §3.4：v1 只有 low 风险可以超过 L1；采纳率不解锁自动执行。
    const level: Level = risk === 'low' ? byCeiling : 'L1'
    const clampedBy =
      level !== recorded
        ? risk === 'low'
          ? ('ceiling' as const)
          : ('risk_class' as const)
        : undefined
    automation[actionId] = {
      level,
      recorded_level: recorded,
      ceiling: spec.ceiling,
      hard_ceiling: spec.hard_ceiling ?? false,
      risk_class: risk,
      ...(clampedBy ? { clamped_by: clampedBy } : {}),
    }
  }

  const needsRanges = role.scopes.some((s) => s.range === 'assigned')

  return {
    assignment_id: assignment.id,
    person_id: assignment.person_id,
    workspace_id: assignment.workspace_id,
    role_id: role.id,
    role_version: role.version,
    scopes: role.scopes.map((s) => ({ ...s, ops: [...s.ops] })),
    connectors: role.connectors.map((c) => ({ ...c, grants: [...c.grants] })),
    missing_connectors: missing.map((c) => c.kind),
    actions,
    automation,
    skills: role.skills.map((s) => ({ ...s })),
    grounding: role.grounding ?? [],
    // WP82：没填 = 空 = 这条职责开不了浏览器（55 §3 的白名单是"允许"表）
    browser_scope: [...(role.browser_scope ?? [])],
    ...(role.persona !== undefined ? { persona: role.persona } : {}),
    ranges: [...assignment.ranges],
    ...(assignment.range_groups === undefined || assignment.range_groups.length === 0
      ? {}
      : { range_groups: [...assignment.range_groups] }),
    home_blocks: role.home_blocks.map((b) => ({ ...b })),
    notifications: role.notifications.map((n) => ({ ...n })),
    ready: missing.length === 0,
    unassigned_range: needsRanges && assignment.ranges.length === 0,
  }
}
