/**
 * WP320：记忆的「账本」——每一条记忆是谁记的、从哪次运行来的、为什么记；每一次新增 / 改动 /
 * 合并 / 删除记一笔（可回溯）；人删掉的 AI 记忆留一块「墓碑」（AI 以后别再记回来）。
 *
 * 为什么不放在技能库里：技能库的段（`SkillSection`）是契约里的东西，改它要动契约；而这里记的
 * 全是「这条记忆的来历」，不是记忆本身。记忆正文仍然只有一份——住在技能库那一层里。
 *
 * 事件日志（21 §1）照样每次落一条 `memory.*`（谁、哪一层、哪条、为什么，**不带正文**）；
 * 这本账多存一份短正文，只给本人界面上那个「记住了：……」小提醒和记忆面板的「来源」用，跟着
 * 数据目录落盘（`memory-persist.ts`），不出这台机器。
 */
import type { Iso8601, PersonId, RunId, SkillTier, WorkspaceId } from '@agentsws/contracts'

/**
 * 为什么记这一条：
 * - `asked` 人明确说了「记住」；`preference` / `correction` / `fact` AI 自己从对话里提炼的
 *   （稳定偏好 / 被纠正过的做法 / 稳定事实）；
 * - `manual` 人在记忆面板里手写；`merge` AI 把新说法并进一条旧的；
 * - `position_merge` / `position_copy` 岗位合并 / 拆出时搬过来的（docs/54 §6.4）。
 */
export type MemoryReason =
  | 'asked'
  | 'preference'
  | 'correction'
  | 'fact'
  | 'manual'
  | 'merge'
  | 'position_merge'
  | 'position_copy'

/** 一条记忆的来历。 */
export interface MemoryProvenance {
  /** 人写的就是那个人；AI 记的就是替谁记的（那次运行是谁起的）。 */
  by: PersonId
  at: Iso8601
  written_by: 'person' | 'ai'
  run_id?: RunId
  matter_id?: string
  reason?: MemoryReason
}

/** 账上的一笔。 */
export interface MemoryChange {
  id: string
  at: Iso8601
  kind: 'added' | 'updated' | 'merged' | 'removed'
  entry_id: string
  tier: SkillTier
  /** 公司层是品牌（工作区）id，其余是岗位 / 职责 / 部门 id。 */
  scope_id: string
  workspace_id: WorkspaceId
  /** 这条记忆现在的样子（截短，给小提醒用）；删掉的是删之前的样子。 */
  text: string
  by: PersonId
  written_by: 'person' | 'ai'
  run_id?: RunId
  matter_id?: string
  reason?: MemoryReason
}

export interface MemoryTombstone {
  workspace_id: WorkspaceId
  tier: SkillTier
  scope_id: string
  text: string
  at: Iso8601
}

export interface MemoryBookSnapshot {
  provenance: Record<string, MemoryProvenance>
  journal: MemoryChange[]
  tombstones: MemoryTombstone[]
}

export interface MemoryBook {
  provenance(entry_id: string): MemoryProvenance | undefined
  setProvenance(entry_id: string, p: MemoryProvenance): void
  dropProvenance(entry_id: string): void
  record(change: Omit<MemoryChange, 'id'>): MemoryChange
  /**
   * 按时间正序；`since` **含等于**——同一毫秒里可能记了好几笔（模拟世界的钟还是停着的），
   * 不含等于就会漏掉；调用方按 `id` 去重。
   */
  changes(filter?: {
    since?: Iso8601
    workspace_id?: WorkspaceId
    by?: PersonId
    written_by?: 'person' | 'ai'
    limit?: number
  }): MemoryChange[]
  tombstone(t: MemoryTombstone): void
  tombstones(filter: { workspace_id: WorkspaceId; tier: SkillTier; scope_id: string }): string[]
  snapshot(): MemoryBookSnapshot
  restore(s: Partial<MemoryBookSnapshot>): void
  onChange(listener: () => void): () => void
}

/** 账上最多留多少笔（再早的只在事件日志里）。 */
export const MEMORY_JOURNAL_MAX = 300
/** 墓碑最多留多少块。 */
export const MEMORY_TOMBSTONE_MAX = 300
/** 小提醒那一句最长多少字。 */
export const MEMORY_NOTICE_TEXT_MAX = 80

/** 正文 → 一行短句（小提醒与账上的 `text`）。 */
export function shortMemoryText(body: string, max = MEMORY_NOTICE_TEXT_MAX): string {
  const line = body.replace(/\s+/gu, ' ').trim()
  const chars = [...line]
  return chars.length <= max ? line : `${chars.slice(0, max - 1).join('')}…`
}

export function createMemoryBook(
  options: { journalMax?: number; tombstoneMax?: number } = {},
): MemoryBook {
  const journalMax = options.journalMax ?? MEMORY_JOURNAL_MAX
  const tombstoneMax = options.tombstoneMax ?? MEMORY_TOMBSTONE_MAX
  const provenance = new Map<string, MemoryProvenance>()
  let journal: MemoryChange[] = []
  let tombstones: MemoryTombstone[] = []
  let seq = 0
  const listeners = new Set<() => void>()
  const changed = (): void => {
    for (const l of listeners) {
      try {
        l()
      } catch {
        // 听的人出错不影响记账
      }
    }
  }
  return {
    provenance: (id) => {
      const p = provenance.get(id)
      return p === undefined ? undefined : { ...p }
    },
    setProvenance(id, p) {
      provenance.set(id, { ...p })
      changed()
    },
    dropProvenance(id) {
      if (provenance.delete(id)) changed()
    },
    record(change) {
      seq += 1
      const full: MemoryChange = {
        ...change,
        id: `mch_${Date.parse(change.at).toString(36)}_${seq.toString(36)}`,
      }
      journal.push(full)
      if (journal.length > journalMax) journal = journal.slice(journal.length - journalMax)
      changed()
      return { ...full }
    },
    changes(filter = {}) {
      const since = filter.since === undefined ? undefined : Date.parse(filter.since)
      const out = journal.filter(
        (c) =>
          (since === undefined || Number.isNaN(since) || Date.parse(c.at) >= since) &&
          (filter.workspace_id === undefined || c.workspace_id === filter.workspace_id) &&
          (filter.by === undefined || c.by === filter.by) &&
          (filter.written_by === undefined || c.written_by === filter.written_by),
      )
      const limited = filter.limit === undefined ? out : out.slice(-filter.limit)
      return limited.map((c) => ({ ...c }))
    },
    tombstone(t) {
      tombstones.push({ ...t })
      if (tombstones.length > tombstoneMax)
        tombstones = tombstones.slice(tombstones.length - tombstoneMax)
      changed()
    },
    tombstones: (f) =>
      tombstones
        .filter(
          (t) =>
            t.workspace_id === f.workspace_id && t.tier === f.tier && t.scope_id === f.scope_id,
        )
        .map((t) => t.text),
    snapshot: () => ({
      provenance: Object.fromEntries([...provenance].map(([k, v]) => [k, { ...v }])),
      journal: journal.map((c) => ({ ...c })),
      tombstones: tombstones.map((t) => ({ ...t })),
    }),
    restore(s) {
      provenance.clear()
      for (const [k, v] of Object.entries(s.provenance ?? {})) provenance.set(k, { ...v })
      journal = (s.journal ?? []).slice(-journalMax).map((c) => ({ ...c }))
      tombstones = (s.tombstones ?? []).slice(-tombstoneMax).map((t) => ({ ...t }))
      seq = journal.length
    },
    onChange(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}
