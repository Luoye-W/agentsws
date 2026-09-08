import type {
  ApprovalItem,
  Mandate,
  ProvenanceState,
  RunId,
  StagedChange,
} from '@agentsws/contracts'
import type {
  ApprovalContext,
  ApprovalFilter,
  ChangeFilter,
  Reservation,
  TokenRecord,
  TxnStore,
} from './types.js'
import { ms, refKey } from './util.js'

/** 内存实现（接口化，便于以后换 SQLite）。存的是深拷贝，调用方拿到的对象改不动内部状态。 */
export class MemoryTxnStore implements TxnStore {
  private approvals = new Map<string, ApprovalItem>()
  private order: string[] = []
  private history = new Map<string, ApprovalItem[]>()
  private events = new Map<string, string[]>()
  private tokens = new Map<string, TokenRecord>()
  private changes = new Map<string, StagedChange>()
  private changeOrder: string[] = []
  private mandates = new Map<string, Mandate>()
  private contexts = new Map<string, ApprovalContext>()
  private approved = new Set<string>()
  private reservations = new Map<string, Reservation>()
  private provenance = new Map<RunId, ProvenanceState>()

  private clone<T>(v: T): T {
    return structuredClone(v)
  }

  putApproval(item: ApprovalItem): void {
    if (!this.approvals.has(item.id)) this.order.push(item.id)
    this.approvals.set(item.id, this.clone(item))
  }
  getApproval(id: string): ApprovalItem | undefined {
    const it = this.approvals.get(id)
    return it ? this.clone(it) : undefined
  }
  listApprovals(filter: ApprovalFilter = {}): ApprovalItem[] {
    const out: ApprovalItem[] = []
    for (const id of this.order) {
      const it = this.approvals.get(id)
      if (!it) continue
      if (filter.workspace_id && it.workspace_id !== filter.workspace_id) continue
      if (filter.kind && it.kind !== filter.kind) continue
      if (filter.role_id && it.role_id !== filter.role_id) continue
      if (filter.dedupe_key && it.dedupe_key !== filter.dedupe_key) continue
      if (filter.state && !filter.state.includes(it.state)) continue
      out.push(this.clone(it))
    }
    return out
  }
  pushRevision(item: ApprovalItem): void {
    const list = this.history.get(item.id) ?? []
    list.push(this.clone(item))
    this.history.set(item.id, list)
  }
  revisions(id: string): ApprovalItem[] {
    return (this.history.get(id) ?? []).map((i) => this.clone(i))
  }
  pushEventId(item_id: string, event_id: string): void {
    const list = this.events.get(item_id) ?? []
    list.push(event_id)
    this.events.set(item_id, list)
  }
  eventIds(item_id: string): string[] {
    return [...(this.events.get(item_id) ?? [])]
  }

  putToken(t: TokenRecord): void {
    this.tokens.set(t.token, { ...t })
  }
  getToken(token: string): TokenRecord | undefined {
    const t = this.tokens.get(token)
    return t ? { ...t } : undefined
  }
  tokensFor(item_id: string): TokenRecord[] {
    return [...this.tokens.values()].filter((t) => t.item_id === item_id).map((t) => ({ ...t }))
  }
  revokeTokensFor(item_id: string): void {
    for (const t of this.tokens.values()) if (t.item_id === item_id) t.revoked = true
  }

  putChange(c: StagedChange): void {
    if (!this.changes.has(c.id)) this.changeOrder.push(c.id)
    this.changes.set(c.id, this.clone(c))
  }
  getChange(id: string): StagedChange | undefined {
    const c = this.changes.get(id)
    return c ? this.clone(c) : undefined
  }
  listChanges(filter: ChangeFilter = {}): StagedChange[] {
    const out: StagedChange[] = []
    for (const id of this.changeOrder) {
      const c = this.changes.get(id)
      if (!c) continue
      if (filter.workspace_id && c.workspace_id !== filter.workspace_id) continue
      if (filter.kind && c.kind !== filter.kind) continue
      if (filter.run_id && c.run_id !== filter.run_id) continue
      if (filter.assignment_id && c.assignment_id !== filter.assignment_id) continue
      if (filter.change_set_id && c.change_set_id !== filter.change_set_id) continue
      if (filter.status && !filter.status.includes(c.status)) continue
      if (filter.target && refKey(c.target) !== refKey(filter.target)) continue
      if (filter.since && ms(c.created_at) < ms(filter.since)) continue
      out.push(this.clone(c))
    }
    return out
  }
  putMandate(change_id: string, m: Mandate): void {
    this.mandates.set(change_id, this.clone(m))
  }
  getMandate(change_id: string): Mandate | undefined {
    const m = this.mandates.get(change_id)
    return m ? this.clone(m) : undefined
  }
  putContext(item_id: string, ctx: ApprovalContext): void {
    this.contexts.set(item_id, this.clone(ctx))
  }
  getContext(item_id: string): ApprovalContext | undefined {
    const c = this.contexts.get(item_id)
    return c ? this.clone(c) : undefined
  }

  markApproved(change_id: string): void {
    this.approved.add(change_id)
  }
  isApproved(change_id: string): boolean {
    return this.approved.has(change_id)
  }

  reserve(counter: string, change_id: string, amount: number): Reservation {
    const r: Reservation = { counter, change_id, amount, state: 'held' }
    this.reservations.set(change_id, r)
    return { ...r }
  }
  reservationOf(change_id: string): Reservation | undefined {
    const r = this.reservations.get(change_id)
    return r ? { ...r } : undefined
  }
  countReserved(counter: string): number {
    let n = 0
    for (const r of this.reservations.values())
      if (r.counter === counter && r.state !== 'released') n += r.amount
    return n
  }
  commitReservation(change_id: string): void {
    const r = this.reservations.get(change_id)
    if (r) r.state = 'committed'
  }
  releaseReservation(change_id: string): void {
    const r = this.reservations.get(change_id)
    if (r) r.state = 'released'
  }

  putProvenance(state: ProvenanceState): void {
    this.provenance.set(state.run_id, this.clone(state))
  }
  getProvenance(run_id: RunId): ProvenanceState | undefined {
    const p = this.provenance.get(run_id)
    return p ? this.clone(p) : undefined
  }
}
