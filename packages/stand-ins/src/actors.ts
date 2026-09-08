import type {
  ApprovalBus,
  ApprovalItem,
  Clock,
  DecisionAction,
  Iso8601,
  PersonId,
  WorkspaceId,
} from '@agentsws/contracts'
import type { Random } from '@agentsws/kernel'
import { StandInError } from './errors.js'

/** 合成人的"人类改法"库：命中就替换；一条都没命中时追加 `fallback`。 */
export interface ActorEditRule {
  find: string
  replace: string
}

export const DEFAULT_EDIT_RULES: ActorEditRule[] = [
  { find: 'we will get back to you', replace: 'we will reply within 24 hours' },
  { find: 'Sorry for the inconvenience', replace: 'Sorry about this — we will make it right' },
  { find: 'Best regards', replace: 'Kind regards' },
  { find: '我们会尽快', replace: '我们会在 24 小时内' },
  { find: '请您耐心等待', replace: '感谢您的耐心' },
]

/** 一条都没命中时的兜底改动，保证 `approve_edited` 的 payload 与原文确实不同。 */
export const DEFAULT_EDIT_FALLBACK = '\n\n— reviewed by ops'

export type ActorPolicy =
  | { kind: 'always_approve' }
  | { kind: 'edit_pct'; pct: number }
  | { kind: 'reject_rules'; patterns: string[] }
  | { kind: 'slow'; latency_ms: { min: number; max: number }; base?: ActorPolicy }

export interface ActorSpec {
  person_id: PersonId
  workspace_id: WorkspaceId
  policy: ActorPolicy
  /** 26 §1 的 DSL 允许策略与驳回规则并存；驳回规则先于策略判断。 */
  reject_rules?: string[]
  /** 与 `slow` 等价的写法；两者都给时取 `latency`。 */
  latency?: { min: number; max: number }
  edits?: ActorEditRule[]
  lane?: 'mine' | 'scope' | 'unclaimed'
}

export interface ActorDecisionRecord {
  person_id: PersonId
  item_id: string
  kind: ApprovalItem['kind']
  action: DecisionAction | 'skipped'
  at: Iso8601
  queued_at: Iso8601
  latency_ms: number
  edited: boolean
  reason?: string
  error?: string
}

interface Scheduled {
  item_id: string
  queued_at: Iso8601
  decide_at_ms: number
  latency_ms: number
}

export interface ActorPoolOptions {
  clock: Clock
  random: Random
  bus?: ApprovalBus
  editRules?: ActorEditRule[]
  editFallback?: string
}

const DECIDABLE: ReadonlySet<ApprovalItem['state']> = new Set<ApprovalItem['state']>([
  'pending',
  'in_review',
])

/**
 * 26 §3 合成人：审批策略机器人。给它一个 `ApprovalBus` 与 `Clock`，
 * `tick(now)` 就按策略处理收件箱里的待办 —— 用来驱动采纳率、升级与 L1→L3 晋级。
 * 随机（是否编辑、延迟多久）全部经注入的 seed；不给 latency 时当场决定。
 */
export class ActorPool {
  private readonly clock: Clock
  private readonly random: Random
  private readonly editRules: ActorEditRule[]
  private readonly editFallback: string
  private readonly specs = new Map<PersonId, ActorSpec>()
  private readonly scheduled = new Map<PersonId, Map<string, Scheduled>>()
  private readonly log: ActorDecisionRecord[] = []
  private bus: ApprovalBus | undefined

  constructor(opts: ActorPoolOptions) {
    this.clock = opts.clock
    this.random = opts.random
    this.bus = opts.bus
    this.editRules = opts.editRules ?? DEFAULT_EDIT_RULES
    this.editFallback = opts.editFallback ?? DEFAULT_EDIT_FALLBACK
  }

  attach(bus: ApprovalBus): void {
    this.bus = bus
  }

  add(spec: ActorSpec): void {
    if (spec.policy.kind === 'edit_pct' && (spec.policy.pct < 0 || spec.policy.pct > 100)) {
      throw new StandInError('invalid_input', 'edit_pct 必须在 [0, 100]', { pct: spec.policy.pct })
    }
    this.specs.set(spec.person_id, spec)
    this.scheduled.set(spec.person_id, new Map())
  }

  list(): ActorSpec[] {
    return [...this.specs.values()]
  }

  decisions(): ActorDecisionRecord[] {
    return [...this.log]
  }

  /**
   * 推进到 `now`：先把新进队列的待办按策略延迟排期，再处理所有到点的。
   * 返回本次做出的决定（含跳过与失败）。
   */
  async tick(now?: Iso8601): Promise<ActorDecisionRecord[]> {
    const bus = this.bus
    if (!bus) throw new StandInError('invalid_input', '合成人未绑定 ApprovalBus（先调 attach）')
    const at = now ?? this.clock.now()
    const atMs = Date.parse(at)
    if (!Number.isFinite(atMs)) throw new StandInError('invalid_input', `不是 ISO-8601 时刻：${at}`)
    const made: ActorDecisionRecord[] = []

    for (const spec of this.specs.values()) {
      const queue = await bus.queue({
        workspace_id: spec.workspace_id,
        person_id: spec.person_id,
        lane: spec.lane ?? 'mine',
      })
      const pending = this.scheduled.get(spec.person_id) ?? new Map<string, Scheduled>()
      this.scheduled.set(spec.person_id, pending)
      const live = new Set<string>()

      for (const item of queue) {
        if (!DECIDABLE.has(item.state)) continue
        live.add(item.id)
        if (pending.has(item.id)) continue
        const latency_ms = this.sampleLatency(spec)
        pending.set(item.id, {
          item_id: item.id,
          queued_at: at,
          decide_at_ms: atMs + latency_ms,
          latency_ms,
        })
      }
      for (const id of [...pending.keys()]) if (!live.has(id)) pending.delete(id)

      for (const entry of [...pending.values()].sort((a, b) => a.decide_at_ms - b.decide_at_ms)) {
        if (entry.decide_at_ms > atMs) continue
        const item = queue.find((i) => i.id === entry.item_id)
        if (!item) {
          pending.delete(entry.item_id)
          continue
        }
        const record = await this.decideOne(bus, spec, item, entry, at)
        pending.delete(entry.item_id)
        this.log.push(record)
        made.push(record)
      }
    }
    return made
  }

  private async decideOne(
    bus: ApprovalBus,
    spec: ActorSpec,
    item: ApprovalItem,
    entry: Scheduled,
    at: Iso8601,
  ): Promise<ActorDecisionRecord> {
    const base = {
      person_id: spec.person_id,
      item_id: item.id,
      kind: item.kind,
      at,
      queued_at: entry.queued_at,
      latency_ms: entry.latency_ms,
    }
    const token = tokenFor(item, spec.person_id)
    if (!token) {
      return { ...base, action: 'skipped', edited: false, reason: '没有可用的 decision_token' }
    }

    const verdict = this.verdict(spec, item)
    try {
      if (verdict.action === 'reject') {
        await bus.decide(item.id, spec.person_id, {
          decision_token: token,
          action: 'reject',
          via: 'workstation',
          reason: verdict.reason as string,
        })
        return { ...base, action: 'reject', edited: false, reason: verdict.reason as string }
      }
      if (verdict.action === 'approve_edited') {
        await bus.decide(item.id, spec.person_id, {
          decision_token: token,
          action: 'approve_edited',
          via: 'workstation',
          edited_payload: verdict.edited_payload,
        })
        return { ...base, action: 'approve_edited', edited: true }
      }
      await bus.decide(item.id, spec.person_id, {
        decision_token: token,
        action: 'approve',
        via: 'workstation',
      })
      return { ...base, action: 'approve', edited: false }
    } catch (e) {
      return {
        ...base,
        action: 'skipped',
        edited: false,
        error: e instanceof Error ? e.message : String(e),
      }
    }
  }

  /** 纯判定（不写总线）：驳回规则先判，再按策略决定通过 / 编辑通过。 */
  private verdict(
    spec: ActorSpec,
    item: ApprovalItem,
  ): { action: DecisionAction; reason?: string; edited_payload?: unknown } {
    const patterns = [
      ...(spec.reject_rules ?? []),
      ...(spec.policy.kind === 'reject_rules' ? spec.policy.patterns : []),
      ...(spec.policy.kind === 'slow' && spec.policy.base?.kind === 'reject_rules'
        ? spec.policy.base.patterns
        : []),
    ]
    const hay = haystack(item)
    const hit = patterns.find((p) => hay.includes(normalizePattern(p)))
    if (hit !== undefined) {
      return { action: 'reject', reason: `命中驳回规则：${hit}` }
    }
    const effective =
      spec.policy.kind === 'slow'
        ? (spec.policy.base ?? { kind: 'always_approve' as const })
        : spec.policy
    if (effective.kind === 'edit_pct') {
      if (this.random() * 100 < effective.pct) {
        return { action: 'approve_edited', edited_payload: this.applyEdits(item.payload) }
      }
      return { action: 'approve' }
    }
    return { action: 'approve' }
  }

  /** 从"人类改法"库改写 payload 里的所有字符串字段。 */
  applyEdits(payload: unknown): unknown {
    let touched = false
    const walk = (v: unknown): unknown => {
      if (typeof v === 'string') {
        let out = v
        for (const rule of this.editRules) {
          if (out.includes(rule.find)) {
            out = out.split(rule.find).join(rule.replace)
            touched = true
          }
        }
        return out
      }
      if (Array.isArray(v)) return v.map(walk)
      if (v !== null && typeof v === 'object') {
        const o: Record<string, unknown> = {}
        for (const [k, val] of Object.entries(v as Record<string, unknown>)) o[k] = walk(val)
        return o
      }
      return v
    }
    const edited = walk(payload)
    if (touched) return edited
    if (edited !== null && typeof edited === 'object' && !Array.isArray(edited)) {
      const o = edited as Record<string, unknown>
      for (const k of ['body', 'text', 'message', 'summary']) {
        if (typeof o[k] === 'string') return { ...o, [k]: `${o[k] as string}${this.editFallback}` }
      }
      return { ...o, ops_note: this.editFallback.trim() }
    }
    return typeof edited === 'string' ? `${edited}${this.editFallback}` : edited
  }

  private sampleLatency(spec: ActorSpec): number {
    const range = spec.latency ?? (spec.policy.kind === 'slow' ? spec.policy.latency_ms : undefined)
    if (!range) return 0
    if (range.max < range.min) {
      throw new StandInError('invalid_input', 'latency 范围非法（max < min）', range)
    }
    return Math.round(range.min + this.random() * (range.max - range.min))
  }
}

function tokenFor(item: ApprovalItem, person: PersonId): string | undefined {
  const usable = item.deliveries.filter(
    (d) => d.to === person && d.status !== 'expired' && d.status !== 'failed',
  )
  return usable.at(-1)?.decision_token
}

function normalizePattern(p: string): string {
  // 26 §1 的 `contains:补偿` 与裸串 `补偿` 都支持
  return p.startsWith('contains:') ? p.slice('contains:'.length) : p
}

function haystack(item: ApprovalItem): string {
  return [item.title, item.summary, stringify(item.payload)].join('\n')
}

function stringify(v: unknown): string {
  if (typeof v === 'string') return v
  if (v === null || v === undefined) return ''
  if (Array.isArray(v)) return v.map(stringify).join('\n')
  if (typeof v === 'object')
    return Object.values(v as Record<string, unknown>)
      .map(stringify)
      .join('\n')
  return String(v)
}
