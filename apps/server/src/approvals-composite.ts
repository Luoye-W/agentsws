/*
 * demo（挂了模拟世界）里有两本审批账：
 *
 * - **世界的**（`mount.approvals`）：demo 铺的演示卡都在这本账上，批了由世界的
 *   执行器把变更应用到模拟数据上（改价、上架、发文章……）。
 * - **服务进程自己的**（`txn.approvals`）：运行中的服务（红人起草开发信、议价、
 *   验收……）stage 出来的卡落在这本账上，批了走服务进程的执行器
 *   （`backendApply` → 演练拦截 → `deliverOutbound`）——发送的硬闸也在这条路上。
 *
 * 界面与网关读的是同一份 `deps.approvals`。以前 demo 只读世界那一本，于是
 * 服务进程 stage 的卡**永远进不了队列**——没人能批，主线自然走不通
 * （66 复测 #19「已发 0 · 回信 0」的真正根因：卡根本无处可批）。
 *
 * 这本合成账只做三件事：**读合并**（去重后按队列同样的次序排）、**写各回各家**
 * （卡片住在哪一本，决定 / 撤回就落到哪一本）、**生产零影响**（没挂世界时
 * 根本不会走到这里，服务进程那一本就是唯一的一本）。
 */
import type {
  ApprovalBus,
  ApprovalItem,
  ApprovalState,
  CreateApprovalInput,
  DecideInput,
} from '@agentsws/contracts'

const PRIORITY_RANK = { immediate: 0, queue: 1, digest: 2 } as const

/** 与 `packages/txn` 队列同一份次序：优先级 → 到期 → 提出时间。 */
function byQueueOrder(a: ApprovalItem, b: ApprovalItem): number {
  const ms = (v: string | undefined) => (v === undefined ? Number.NaN : Date.parse(v))
  return (
    PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
    ms(a.due_at ?? a.expires_at ?? a.created_at) - ms(b.due_at ?? b.expires_at ?? b.created_at) ||
    ms(a.created_at) - ms(b.created_at)
  )
}

export function compositeApprovals(primary: ApprovalBus, secondary: ApprovalBus): ApprovalBus {
  /** 卡片住哪一本：先问主账（世界的），没有再看服务进程的。 */
  const ownerOf = async (id: string): Promise<ApprovalBus | undefined> => {
    if ((await primary.get(id)) !== undefined) return primary
    if ((await secondary.get(id)) !== undefined) return secondary
    return undefined
  }
  const owned = async (id: string, what: string): Promise<ApprovalBus> => {
    const bus = await ownerOf(id)
    if (bus === undefined) throw new Error(`${what}：两本账里都没有这张卡（${id}）`)
    return bus
  }

  return {
    // 人主动提的卡（网关那条路）：落在主账上——demo 里它要能被世界的执行器应用。
    create: <P>(input: CreateApprovalInput<P>) => primary.create(input),

    async get(id) {
      return (await primary.get(id)) ?? (await secondary.get(id))
    },

    async queue(filter) {
      const [a, b] = await Promise.all([primary.queue(filter), secondary.queue(filter)])
      const seen = new Set<string>()
      return [...a, ...b]
        .filter((i) => (seen.has(i.id) ? false : (seen.add(i.id), true)))
        .sort(byQueueOrder)
    },

    async decide(id, by, input: DecideInput) {
      return (await owned(id, '决定')).decide(id, by, input)
    },
    async decideBatch(entries, by, input) {
      // 按住属分两拨，各自批量，结果按原来的顺序合回去。
      const buses = await Promise.all(entries.map((e) => ownerOf(e.id)))
      const out: { id: string; item?: ApprovalItem; error?: unknown }[] = entries.map((e) => ({
        id: e.id,
      }))
      for (const bus of new Set(buses)) {
        if (bus === undefined) continue
        const idx: number[] = []
        buses.forEach((b, i) => {
          if (b === bus) idx.push(i)
        })
        const mine: { id: string; decision_token: string }[] = []
        for (const i of idx) {
          const entry = entries[i]
          if (entry !== undefined) mine.push(entry)
        }
        const part = await bus.decideBatch(mine, by, input)
        idx.forEach((original, k) => {
          const row = part[k]
          if (row !== undefined) out[original] = row
        })
      }
      for (let i = 0; i < out.length; i += 1) {
        const row = out[i]
        if (row === undefined) continue
        if (row.item === undefined && row.error === undefined)
          out[i] = { id: row.id, error: '两本账里都没有这张卡' }
      }
      return out
    },
    async claim(id, by) {
      return (await owned(id, '认领')).claim(id, by)
    },
    async release(id, by) {
      return (await owned(id, '释放')).release(id, by)
    },
    async withdraw(id, by) {
      return (await owned(id, '撤回')).withdraw(id, by)
    },
    async retryApply(id, by) {
      return (await owned(id, '重试')).retryApply(id, by)
    },
    async history(id) {
      return (await owned(id, '历史')).history(id)
    },
    async escalate(now) {
      const [a, b] = await Promise.all([primary.escalate(now), secondary.escalate(now)])
      return [...a, ...b]
    },
    async expire(now) {
      const [a, b] = await Promise.all([primary.expire(now), secondary.expire(now)])
      return [...a, ...b]
    },
  } satisfies ApprovalBus
}
