import type {
  Clock,
  DecisionAction,
  DeliveryChannel,
  DeliveryProvider,
  Iso8601,
  PersonId,
} from '@agentsws/contracts'
import { StandInError } from './errors.js'

export interface DeliveredItem {
  id: string
  title: string
  summary: string
  view: 'full' | 'redacted'
  decision_token: string
  actions: string[]
}

export interface DeliveryRecord {
  external_id: string
  channel: DeliveryChannel
  to: PersonId
  item: DeliveredItem
  sent_at: Iso8601
  /** `refresh` 写进来的最新状态（"已由 × 处理" / expired）。 */
  state: string
  refreshed_at?: Iso8601
}

const DECISION_ACTIONS: ReadonlySet<string> = new Set<DecisionAction>([
  'approve',
  'approve_edited',
  'reject',
  'redirect',
  'defer',
  'withdraw',
])

export interface InboxDeliveryOptions {
  channel: DeliveryChannel
  clock: Clock
}

/**
 * 26 §3 inbox delivery / 18 §3 + 14 §7 投递：记录投递、可被合成人回调、可刷新。
 * 「回调只做一件事：带 decision_token 与动作」——`parseCallback` 只认这三个字段，其余一律丢弃。
 */
export class InboxDelivery implements DeliveryProvider {
  readonly channel: DeliveryChannel
  private readonly clock: Clock
  private readonly records: DeliveryRecord[] = []
  private seq = 0

  constructor(opts: InboxDeliveryOptions) {
    this.channel = opts.channel
    this.clock = opts.clock
  }

  async deliver(item: DeliveredItem, to: PersonId): Promise<{ external_id?: string }> {
    this.seq += 1
    const external_id = `${this.channel}_${this.seq}`
    this.records.push({
      external_id,
      channel: this.channel,
      to,
      item: { ...item, actions: [...item.actions] },
      sent_at: this.clock.now(),
      state: 'sent',
    })
    return { external_id }
  }

  async refresh(external_id: string, state: string): Promise<void> {
    const rec = this.records.find((r) => r.external_id === external_id)
    if (!rec) throw new StandInError('not_found', `投递不存在：${external_id}`, { external_id })
    rec.state = state
    rec.refreshed_at = this.clock.now()
  }

  parseCallback(
    payload: unknown,
  ): { item_id: string; decision_token: string; action: string } | undefined {
    let raw: unknown = payload
    if (typeof raw === 'string') {
      try {
        raw = JSON.parse(raw)
      } catch {
        return undefined
      }
    }
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
    const o = raw as Record<string, unknown>
    const item_id = o.item_id
    const decision_token = o.decision_token
    const action = o.action
    if (typeof item_id !== 'string' || item_id.length === 0) return undefined
    if (typeof decision_token !== 'string' || decision_token.length === 0) return undefined
    if (typeof action !== 'string' || !DECISION_ACTIONS.has(action)) return undefined
    return { item_id, decision_token, action }
  }

  // ---------- 观察面 ----------

  all(): DeliveryRecord[] {
    return this.records.map((r) => ({ ...r, item: { ...r.item } }))
  }

  get length(): number {
    return this.records.length
  }

  /** 某个人的收件箱。 */
  inbox(person: PersonId): DeliveryRecord[] {
    return this.all().filter((r) => r.to === person)
  }

  forItem(item_id: string): DeliveryRecord[] {
    return this.all().filter((r) => r.item.id === item_id)
  }

  clear(): void {
    this.records.length = 0
  }
}
