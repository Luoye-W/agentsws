import type { ObjectRef, ProvenanceState, RunId } from '@agentsws/contracts'

/**
 * 15 §6 Provenance："只能对本次运行见过的实体动手"。只证明"读过"，不证明"有权"（关系授权门禁另做）。
 * 09-08（评审 A12）：被 staged change 引用的 id 钉住，不参与淘汰。
 */
export const PROVENANCE_CAP = 200

export class Provenance {
  private seen = new Map<string, string[]>()
  private readFull = new Set<string>()
  private pinned = new Set<string>()
  readonly evicted: ObjectRef[] = []

  constructor(
    readonly run_id: RunId,
    readonly cap = PROVENANCE_CAP,
  ) {}

  static from(state: ProvenanceState): Provenance {
    const p = new Provenance(state.run_id)
    for (const [t, ids] of Object.entries(state.seen)) p.seen.set(t, [...ids])
    for (const id of state.read_full) p.readFull.add(id)
    return p
  }

  private key(ref: ObjectRef) {
    return `${ref.type}:${ref.id}`
  }

  /** 读处理器调用：工具结果里出现的实体 */
  see(refs: Iterable<ObjectRef>, opts?: { full?: boolean }): void {
    for (const ref of refs) {
      const list = this.seen.get(ref.type) ?? []
      const idx = list.indexOf(ref.id)
      if (idx >= 0) list.splice(idx, 1)
      list.push(ref.id)
      while (list.length > this.cap) {
        const victimIdx = list.findIndex((id) => !this.pinned.has(`${ref.type}:${id}`))
        if (victimIdx < 0) break
        const [victim] = list.splice(victimIdx, 1)
        if (victim !== undefined) this.evicted.push({ type: ref.type, id: victim })
      }
      this.seen.set(ref.type, list)
      if (opts?.full) this.readFull.add(this.key(ref))
    }
  }

  /** stage 时调用：目标进 pinned，不再淘汰 */
  pin(ref: ObjectRef): void {
    this.pinned.add(this.key(ref))
  }

  has(ref: ObjectRef): boolean {
    return (this.seen.get(ref.type) ?? []).includes(ref.id)
  }
  hasFull(ref: ObjectRef): boolean {
    return this.readFull.has(this.key(ref))
  }

  /** 写 / 呈现前检查；返回未见过的 */
  missing(refs: Iterable<ObjectRef>): ObjectRef[] {
    return [...refs].filter((r) => !this.has(r))
  }

  toState(at: string): ProvenanceState {
    const seen: Record<string, string[]> = {}
    for (const [t, ids] of this.seen) seen[t] = [...ids]
    return { run_id: this.run_id, seen, read_full: [...this.readFull], recorded_at: at }
  }
}
