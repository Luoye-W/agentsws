/**
 * 转发器的三个小存储口的 KV 实现（官方托管 / 自建 Docker 两档共用）。
 *
 * 转发器替商家存的东西只有三样：配对密钥哈希、对话计数、留言密文。
 * 三样都是小 KV——不需要 SQL，只需要一个「取 / 放 / 删 / 按前缀列」的口。
 * Node 档给 JSON 文件实现（deploy 包），DO 档给 `storage.sql` 的一张 KV 表。
 */
import type { Iso8601 } from '@agentsws/contracts'
import { type PairingStore, pairingHash } from './node.js'
import type { OfflineBox, OfflineItem } from './offline-box.js'
import { type CounterStore, MemoryCounterStore } from './quota.js'

/** 最小 KV 口（同步；DO 的 sql 与 Node 的内存 map 都装得下）。 */
export interface RelayKv {
  get(key: string): string | undefined
  put(key: string, value: string): void
  delete(key: string): void
  /** 按前缀列（留言箱与计数桶用）。 */
  list(prefix: string): { key: string; value: string }[]
}

/** 内存 KV（测试 / 单进程）。 */
export class MemoryKv implements RelayKv {
  private readonly map = new Map<string, string>()
  get(key: string): string | undefined {
    return this.map.get(key)
  }
  put(key: string, value: string): void {
    this.map.set(key, value)
  }
  delete(key: string): void {
    this.map.delete(key)
  }
  list(prefix: string): { key: string; value: string }[] {
    return [...this.map]
      .filter(([k]) => k.startsWith(prefix))
      .map(([key, value]) => ({ key, value }))
  }
}

/* ── 配对密钥哈希（之后只存哈希，明文只打印一次） ─────────────────────── */

const PAIRING_PREFIX = 'pairing:'

export class KvPairingStore implements PairingStore {
  constructor(private readonly kv: RelayKv) {}
  hash(workspace: string): string | undefined {
    return this.kv.get(PAIRING_PREFIX + workspace)
  }
  putHash(workspace: string, hash: string): void {
    this.kv.put(PAIRING_PREFIX + workspace, hash)
  }
}

export { pairingHash }

/* ── 对话计数 ──────────────────────────────────────────────────────── */

const COUNT_PREFIX = 'chatcount:'
const VISITED_PREFIX = 'chatvisit:'

export class KvCounterStore implements CounterStore {
  constructor(private readonly kv: RelayKv) {}
  count(workspace: string, month: string): number {
    const raw = this.kv.get(`${COUNT_PREFIX}${workspace}|${month}`)
    return raw === undefined ? 0 : Number(raw)
  }
  bump(workspace: string, month: string, by: number): void {
    const key = `${COUNT_PREFIX}${workspace}|${month}`
    this.kv.put(key, String((Number(this.kv.get(key) ?? '0') || 0) + by))
  }
  lastCountedAt(workspace: string, visitor: string): Iso8601 | undefined {
    return this.kv.get(`${VISITED_PREFIX}${workspace}|${visitor}`)
  }
  noteCounted(workspace: string, visitor: string, at: Iso8601): void {
    this.kv.put(`${VISITED_PREFIX}${workspace}|${visitor}`, at)
  }
}

/* ── 离线留言箱（密文；取走即删） ───────────────────────────────────── */

const OFFLINE_PREFIX = 'offline:'

export class KvOfflineBox implements OfflineBox {
  constructor(
    private readonly kv: RelayKv,
    private readonly maxItems = 50,
  ) {}
  put(workspace: string, item: OfflineItem): void {
    this.kv.put(`${OFFLINE_PREFIX}${workspace}|${item.id}`, JSON.stringify(item))
    // 满了顶最旧的（按 created_at 排，不动上限语义）
    const all = this.list(workspace)
    while (all.length > this.maxItems) {
      const oldest = all.sort((a, b) => a.created_at.localeCompare(b.created_at))[0]
      if (oldest === undefined) break
      this.kv.delete(`${OFFLINE_PREFIX}${workspace}|${oldest.id}`)
      all.splice(
        all.findIndex((i) => i.id === oldest.id),
        1,
      )
    }
  }
  take(workspace: string): OfflineItem[] {
    const all = this.list(workspace)
    for (const item of all) this.kv.delete(`${OFFLINE_PREFIX}${workspace}|${item.id}`)
    return all
  }
  count(workspace: string): number {
    return this.list(workspace).length
  }
  private list(workspace: string): OfflineItem[] {
    return this.kv
      .list(`${OFFLINE_PREFIX}${workspace}|`)
      .map(({ value }) => JSON.parse(value) as OfflineItem)
  }
}

export { MemoryCounterStore }
