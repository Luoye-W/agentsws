/**
 * 离线留言箱（WP124 §B）：本机不在线（或免费额度到顶）时，访客留言暂存转发器，
 * 本机上线后拉走并清除。
 *
 * 三条纪律：
 * 1. **加密暂存**：箱子只存**密文**（`sealed`）。加密在本机与转发器共认的那把
 *    配对密钥上做（宿主层提供 `seal` / `open`），箱子自己不碰明文——转发器
 *    「看得到过路内容但不落盘」，留言是唯一的例外，落下去的也必须是看不懂的。
 * 2. **最多 7 天**：超期的留言在被扫到时丢弃（不投递、不计数）。
 * 3. **条数上限**：一个工作区最多留 N 条（默认 50），满了新留言顶掉最旧的——
 *    留言是兜底不是归档，不能被刷爆。
 */
import type { Iso8601 } from '@agentsws/contracts'

/** 留言最长暂存时间。 */
export const OFFLINE_TTL_MS = 7 * 24 * 60 * 60 * 1000

/** 每个工作区最多暂存多少条。 */
export const OFFLINE_MAX_ITEMS = 50

export interface OfflineItem {
  id: string
  /** 密文（宿主层用配对密钥封的；箱子与转发器都打不开它）。 */
  sealed: string
  created_at: Iso8601
}

export interface OfflineBox {
  put(workspace: string, item: OfflineItem): void
  /** 取出全部并**清除**（拉走即删，不留第二份）。 */
  take(workspace: string): OfflineItem[]
  count(workspace: string): number
}

export class MemoryOfflineBox implements OfflineBox {
  private readonly items = new Map<string, OfflineItem[]>()

  put(workspace: string, item: OfflineItem): void {
    const list = this.items.get(workspace) ?? []
    list.push(item)
    // 满了顶掉最旧的：留言是兜底，不是无限归档
    while (list.length > OFFLINE_MAX_ITEMS) list.shift()
    this.items.set(workspace, list)
  }

  take(workspace: string): OfflineItem[] {
    const list = this.items.get(workspace) ?? []
    this.items.set(workspace, [])
    return list
  }

  count(workspace: string): number {
    return (this.items.get(workspace) ?? []).length
  }
}

export interface SweepInput {
  box: OfflineBox
  workspace: string
  now: Iso8601
}

/** 把超期的留言扫掉（Node 宿主的定时器 / DO 的 alarm 调它）。 */
export function sweepExpired(input: SweepInput): number {
  const all = input.box.take(input.workspace)
  const fresh = all.filter(
    (item) => Date.parse(input.now) - Date.parse(item.created_at) < OFFLINE_TTL_MS,
  )
  for (const item of fresh) input.box.put(input.workspace, item)
  return all.length - fresh.length
}
