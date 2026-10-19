/**
 * WP428（决策 1244 改）：**够条件 → 建议开全自动**——通用积木的接线这一半（判定在 `@agentsws/roles` 的
 * `evaluateAutopilot`）。
 *
 * 一条职责的一类卡（`AutopilotScope.change_kinds`），人最近 N 张都原样批了、没出事 → 出一张建议卡
 * 「这类可以交给 AI 全自动了」，卡上说清凭什么、开了 AI 能多做什么、什么不变；人点「开全自动」才开，
 * 随时能关（`set(..., false)`）。开着时这类卡里有一张施行失败（出事）→ 自动关掉并说一声。
 *
 * 复用现有的那一套，不另造：
 * - 历史 = 审批总线里这条职责的同类卡（`proposer.assignment_id` + 账本 kind），只认人真点过的；
 * - 建议卡 = 选择题策略卡（`policy_change` + 两个选项），和红人合并卡同一种；
 * - 开关挂在「岗位 × 这一类」上（`autopilot.json`，跟着数据目录），与 L1 / L2 / L3 档位并存：
 *   档位管「这张卡要不要人批」，全自动管「AI 能不能自己推进到下一步、不出卡」。花钱的仍归额度管。
 *
 * 这一单只在红人上真开（`kol.advance_stage`）；别的职责要用，往 `AUTOPILOT_SCOPES` 加一行、
 * 在它的工具 / 服务里问一句 `isOn`。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type {
  ApprovalItem,
  Clock,
  CreateApprovalInput,
  EventEnvelope,
  PersonId,
  WorkspaceId,
} from '@agentsws/contracts'
import { autopilotOutcomeOf, evaluateAutopilot } from '@agentsws/roles'

/** 一类可以交给 AI 全自动的事。 */
export interface AutopilotScope {
  id: string
  /** 哪些职责有这一类（职责 id 前缀）。 */
  role_prefix: string
  /** 卡上与设置里的名字。 */
  title: string
  /** 哪几种账本卡算「同类」（`staged_change` 载荷里的 `kind`）。 */
  change_kinds: readonly string[]
  /** 这几种卡在人话里叫什么（卡上「凭什么」那句用）。 */
  kinds_label: string
  /** 要连着原样批准几张。 */
  needed: number
  /** 开了之后 AI 能多做什么。 */
  grants: string
  /** 开了也不变的。 */
  keeps: string
}

export const KOL_AUTOPILOT_SCOPE = 'kol.advance_stage'

export const AUTOPILOT_SCOPES: readonly AutopilotScope[] = [
  {
    id: KOL_AUTOPILOT_SCOPE,
    role_prefix: 'kol.',
    title: '红人合作推进到「谈成 / 已寄样」',
    change_kinds: ['kol_collaboration', 'kol_sample'],
    kinds_label: '建合作 / 议价 / 寄样',
    needed: 10,
    grants: 'AI 可以自己把合作推进到「谈成」「已寄样」，不用每次等你点',
    keeps: '花钱的（报价、寄样成本、付款）照旧出卡，受这条职责的额度管',
  },
]

export const AUTOPILOT_CARD_FORM = 'autopilot_suggestion'

export interface AutopilotView {
  scope_id: string
  title: string
  grants: string
  keeps: string
  on: boolean
  since?: string
  eligible: boolean
  streak: number
  needed: number
  why: string
}

interface ScopeState {
  on?: { since: string; by: string; card_id?: string }
  off_at?: string
  declined_at?: string
  suggested?: { card_id: string; at: string }
}

interface AutopilotFile {
  version: 1
  states: Record<string, ScopeState>
}

export interface AutopilotOptions {
  clock: Clock
  dir?: string
  /** 这个品牌的账本卡（`staged_change`）。 */
  listChangeCards(workspace_id: WorkspaceId): ApprovalItem[]
  createCard(input: CreateApprovalInput<unknown>): Promise<ApprovalItem<unknown>>
  appendEvent(e: Omit<EventEnvelope, 'id' | 'at'> & { at?: string }): void
}

export interface Autopilot {
  isOn(workspace_id: WorkspaceId, assignment_id: string, scope_id: string): boolean
  /** 这条职责有哪几类能全自动、开没开、够不够条件。 */
  status(workspace_id: WorkspaceId, assignment_id: string, role_id: string): AutopilotView[]
  /** 开 / 关。开要够条件（最近 N 张原样批准）；关随时。 */
  set(input: {
    workspace_id: WorkspaceId
    assignment_id: string
    role_id: string
    scope_id: string
    on: boolean
    by: PersonId
  }): AutopilotView
  /** 每张卡定了之后喊一声：建议卡 → 开 / 记下先不开；同类卡 → 看够不够条件、出没出事。 */
  afterDecided(item: ApprovalItem): Promise<void>
}

export function isAutopilotCard(item: ApprovalItem): boolean {
  return (
    item.kind === 'policy_change' &&
    (item.payload as { form?: unknown } | undefined)?.form === AUTOPILOT_CARD_FORM
  )
}

const keyOf = (ws: string, asg: string, scope: string): string => `${ws}|${asg}|${scope}`

export function createAutopilot(options: AutopilotOptions): Autopilot {
  const file = options.dir === undefined ? undefined : join(options.dir, 'autopilot.json')
  let state: AutopilotFile = { version: 1, states: {} }
  if (file !== undefined && existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<AutopilotFile>
      state = { version: 1, states: parsed.states ?? {} }
    } catch {
      // 读坏了从「都没开」开始——宁可少开，不多开
    }
  }
  const flush = (): void => {
    if (file === undefined) return
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  }
  const get = (k: string): ScopeState => state.states[k] ?? {}
  const put = (k: string, next: ScopeState): void => {
    state.states[k] = next
    flush()
  }

  const scopesOf = (role_id: string): AutopilotScope[] =>
    AUTOPILOT_SCOPES.filter((s) => role_id.startsWith(s.role_prefix))

  const historyOf = (ws: WorkspaceId, assignment_id: string, scope: AutopilotScope) =>
    options
      .listChangeCards(ws)
      .filter(
        (i) =>
          i.proposer.assignment_id === assignment_id &&
          scope.change_kinds.includes(String((i.payload as { kind?: unknown })?.kind ?? '')),
      )
      .map(autopilotOutcomeOf)
      .filter((h) => h !== undefined)

  const emit = (ws: WorkspaceId, type: string, payload: Record<string, unknown>): void => {
    options.appendEvent({
      schema_version: 1,
      workspace_id: ws,
      type: type as EventEnvelope['type'],
      actor: { kind: 'system', id: 'autopilot' },
      correlation: { trace_id: `tr_autopilot_${options.clock.now()}` },
      payload,
    })
  }

  const viewOf = (ws: WorkspaceId, assignment_id: string, scope: AutopilotScope): AutopilotView => {
    const s = get(keyOf(ws, assignment_id, scope.id))
    const verdict = evaluateAutopilot(historyOf(ws, assignment_id, scope), { needed: scope.needed })
    return {
      scope_id: scope.id,
      title: scope.title,
      grants: scope.grants,
      keeps: scope.keeps,
      on: s.on !== undefined,
      ...(s.on === undefined ? {} : { since: s.on.since }),
      eligible: verdict.eligible,
      streak: verdict.streak,
      needed: verdict.needed,
      why: verdict.why,
    }
  }

  const suggest = async (item: ApprovalItem, scope: AutopilotScope): Promise<void> => {
    const ws = item.workspace_id
    const assignment_id = item.proposer.assignment_id
    if (assignment_id === undefined) return
    const k = keyOf(ws, assignment_id, scope.id)
    const s = get(k)
    if (s.on !== undefined) return
    // 人说过「先不开」/ 关过：之后要重新连着原样批满一轮才再提
    const since = [s.declined_at, s.off_at, s.suggested?.at]
      .filter((x): x is string => x !== undefined)
      .sort()
      .at(-1)
    const verdict = evaluateAutopilot(historyOf(ws, assignment_id, scope), {
      needed: scope.needed,
      ...(since === undefined ? {} : { since }),
    })
    if (!verdict.eligible) return
    const person =
      item.decision?.by !== undefined && item.decision.by !== 'mandate'
        ? item.decision.by
        : item.routing.recipients[0]?.person
    if (person === undefined) return
    const card = await options.createCard({
      workspace_id: ws,
      schema_version: 1,
      kind: 'policy_change',
      role_id: item.role_id,
      subject: { object: { type: 'assignment', id: assignment_id } },
      dedupe_key: `${ws}:autopilot:${assignment_id}:${scope.id}:${options.clock.now()}`,
      title: `这类可以交给 AI 全自动了：${scope.title}`,
      summary: `凭什么：${verdict.why}（${scope.kinds_label}）。开了之后：${scope.grants}。不变的：${scope.keeps}。随时能关。`,
      payload: {
        form: AUTOPILOT_CARD_FORM,
        scope_id: scope.id,
        assignment_id,
        streak: verdict.streak,
        needed: verdict.needed,
        sample_ids: verdict.sample_ids,
        options: [
          { id: 'on', label: '开全自动' },
          { id: 'not_now', label: '先不开' },
        ],
      },
      evidence: {
        source_events: [],
        provenance: { seen: verdict.sample_ids.map((id) => ({ type: 'approval', id })) },
        precheck: {},
      },
      proposer: { kind: 'system', id: 'autopilot', assignment_id },
      automation: { level_at_creation: 'L1' },
      routing: {
        recipients: [{ person: person as PersonId, via: 'role_holder' }],
        rule: 'role_holder',
        escalation: { after_hours: 72, business_hours: true, chain: [], escalated_at: [] },
        separation_of_duties: false,
      },
      priority: 'queue',
      options: [
        { id: 'on', label: '开全自动' },
        { id: 'not_now', label: '先不开' },
      ],
    } as CreateApprovalInput<unknown>)
    put(k, { ...s, suggested: { card_id: card.id, at: options.clock.now() } })
    emit(ws, 'autopilot.suggested', {
      scope_id: scope.id,
      assignment_id,
      approval_item_id: card.id,
      streak: verdict.streak,
    })
  }

  /**
   * 开着时这类卡有一张施行失败了（出事）→ 先关掉、说一声；人确认没事再开。
   * 施行在决定之后才跑，所以这一条在每次问「开着没」和每张卡定了之后都查一遍。
   */
  const tripIfIncident = (
    ws: WorkspaceId,
    assignment_id: string,
    scope: AutopilotScope,
  ): boolean => {
    const k = keyOf(ws, assignment_id, scope.id)
    const s = get(k)
    if (s.on === undefined) return false
    const since = s.on.since
    const failed = historyOf(ws, assignment_id, scope).find(
      (h) => h.outcome === 'failed' && h.at >= since,
    )
    if (failed === undefined) return false
    const { on: _was, ...rest } = s
    put(k, { ...rest, off_at: options.clock.now() })
    emit(ws, 'autopilot.turned_off', {
      scope_id: scope.id,
      assignment_id,
      reason: 'incident',
      approval_item_id: failed.id,
    })
    return true
  }

  return {
    isOn(workspace_id, assignment_id, scope_id) {
      const scope = AUTOPILOT_SCOPES.find((x) => x.id === scope_id)
      if (scope === undefined) return false
      if (tripIfIncident(workspace_id, assignment_id, scope)) return false
      return get(keyOf(workspace_id, assignment_id, scope_id)).on !== undefined
    },

    status(workspace_id, assignment_id, role_id) {
      return scopesOf(role_id).map((scope) => viewOf(workspace_id, assignment_id, scope))
    },

    set(input) {
      const scope = scopesOf(input.role_id).find((s) => s.id === input.scope_id)
      if (scope === undefined) throw new Error(`这条职责没有「${input.scope_id}」这一类全自动`)
      const k = keyOf(input.workspace_id, input.assignment_id, scope.id)
      const s = get(k)
      const at = options.clock.now()
      if (input.on) {
        const view = viewOf(input.workspace_id, input.assignment_id, scope)
        if (s.on === undefined && !view.eligible) throw new Error(`还不够条件：${view.why}`)
        if (s.on === undefined) put(k, { ...s, on: { since: at, by: input.by } })
      } else if (s.on !== undefined) {
        const { on: _was, ...rest } = s
        put(k, { ...rest, off_at: at })
      }
      emit(input.workspace_id, input.on ? 'autopilot.turned_on' : 'autopilot.turned_off', {
        scope_id: scope.id,
        assignment_id: input.assignment_id,
        by: input.by,
      })
      return viewOf(input.workspace_id, input.assignment_id, scope)
    },

    async afterDecided(item) {
      if (isAutopilotCard(item)) {
        const p = item.payload as { scope_id?: unknown; assignment_id?: unknown }
        if (typeof p.scope_id !== 'string' || typeof p.assignment_id !== 'string') return
        const k = keyOf(item.workspace_id, p.assignment_id, p.scope_id)
        const s = get(k)
        const at = options.clock.now()
        const approved = item.state === 'approved' || item.state === 'approved_edited'
        const chose = item.decision?.selected_option_id
        if (approved && (chose === undefined || chose === 'on')) {
          const by = item.decision?.by
          put(k, {
            ...s,
            on: { since: at, by: by === undefined ? 'unknown' : String(by), card_id: item.id },
          })
          emit(item.workspace_id, 'autopilot.turned_on', {
            scope_id: p.scope_id,
            assignment_id: p.assignment_id,
            approval_item_id: item.id,
          })
        } else if (item.decision !== undefined && item.state !== 'deferred') {
          put(k, { ...s, declined_at: at })
        }
        return
      }
      if (item.kind !== 'staged_change') return
      const assignment_id = item.proposer.assignment_id
      if (assignment_id === undefined) return
      const kind = String((item.payload as { kind?: unknown })?.kind ?? '')
      for (const scope of AUTOPILOT_SCOPES) {
        if (!item.role_id.startsWith(scope.role_prefix) || !scope.change_kinds.includes(kind))
          continue
        if (tripIfIncident(item.workspace_id, assignment_id, scope)) continue
        await suggest(item, scope)
      }
    },
  }
}
