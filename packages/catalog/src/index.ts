/**
 * `@agentsws/catalog`：工具箱与查重（40 §2）。
 *
 * 一条线：**别人做过的自动化看得见 → 建之前先查 → 好东西往上浮**。
 *
 * 这个包只放判定与那一小块自有状态，不放接线：它不认识调度器、不认识技能库、
 * 不认识审批总线、不认识 HTTP。条目由宿主用回调（{@link CatalogSource}）喂进来，
 * 接线在 `apps/server/src/catalog-index.ts`。
 *
 * 两条纪律：
 * - **查重不改任何东西**：`similar` / `duplicates` / `promotionCandidates` 都是只读，
 *   建不建、合不合、提不提，都是人在卡片上按的。
 * - **理由留痕**：选了"我这个不一样，仍新建"必须写一句为什么，那句话进目录，
 *   下次别人查得到（也是晋升判据里的负样本）。
 */
import type { Clock, WorkspaceId } from '@agentsws/contracts'
import { promotionCandidates } from './promote.js'
import { DUPLICATE_THRESHOLD, findDuplicates, findSimilar, matchesText } from './similar.js'
import { SqliteCatalogStore } from './sqlite-store.js'
import { type CatalogStore, MemoryCatalogStore } from './store.js'
import type {
  CatalogEntry,
  CatalogFilter,
  CatalogLayer,
  CatalogNote,
  CatalogOrigin,
  CatalogSource,
  DuplicatePair,
  PromotionCandidate,
  SimilarHit,
  SimilarQuery,
} from './types.js'

export * from './join-compare.js'
export * from './org-keys.js'
export * from './org-merge.js'
export * from './promote.js'
export * from './similar.js'
export * from './sqlite-store.js'
export * from './store.js'
export * from './types.js'

export interface CatalogIndexOptions {
  clock: Clock
  /** 不给就是内存档（demo 与测试）。 */
  store?: CatalogStore
  sources?: readonly CatalogSource[]
}

/** "仍新建"时要写的那句话至少多长（40 §5 E4：必须写理由，不能是敷衍的一个字）。 */
export const MIN_REASON_LENGTH = 8

export class CatalogIndex {
  readonly store: CatalogStore
  readonly #clock: Clock
  readonly #sources: CatalogSource[]

  constructor(options: CatalogIndexOptions) {
    this.#clock = options.clock
    this.store = options.store ?? new MemoryCatalogStore()
    this.#sources = [...(options.sources ?? [])]
  }

  register(source: CatalogSource): void {
    this.#sources.push(source)
  }

  /**
   * 记一条"没有家的条目"（对话里定制的卡、指导落成的规矩）。有家的不走这条。
   */
  record(entry: CatalogEntry): void {
    this.store.put({
      workspace_id: entry.workspace_id,
      entry_id: entry.id,
      entry,
      at: this.#clock.now(),
    })
  }

  /** 各来源拉一遍，盖上目录自己的注记（层 / 理由 / 被谁取代）。 */
  async entries(workspace_id: WorkspaceId): Promise<CatalogEntry[]> {
    const notes = new Map(this.store.list(workspace_id).map((n) => [n.entry_id, n]))
    const all: CatalogEntry[] = []
    const seen = new Set<string>()
    for (const source of this.#sources) {
      const list = await source.list({ workspace_id })
      for (const entry of list) {
        if (entry.workspace_id !== workspace_id) continue
        seen.add(entry.id)
        all.push(applyNote(entry, notes.get(entry.id)))
      }
    }
    // 目录自己保管的那些（来源回调管不到的 kind）
    for (const note of notes.values()) {
      if (note.entry === undefined || seen.has(note.entry_id)) continue
      if (note.entry.workspace_id !== workspace_id) continue
      all.push(applyNote(note.entry, note))
    }
    all.sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id))
    return all
  }

  async list(filter: CatalogFilter): Promise<CatalogEntry[]> {
    const all = await this.entries(filter.workspace_id)
    return all.filter((e) => {
      if (filter.kind !== undefined && !filter.kind.includes(e.kind)) return false
      if (filter.layer !== undefined && !filter.layer.includes(e.layer)) return false
      if (filter.owner !== undefined && e.owner !== filter.owner) return false
      if (filter.position_id !== undefined && !e.used_by_positions.includes(filter.position_id))
        return false
      if (filter.include_superseded !== true && e.superseded_by !== undefined) return false
      if (filter.text !== undefined && !matchesText(e, filter.text)) return false
      return true
    })
  }

  /** 建之前先查（40 §2.2 第 2 条）。 */
  async similar(query: SimilarQuery): Promise<SimilarHit[]> {
    return findSimilar(query, await this.entries(query.workspace_id))
  }

  /** 疑似重复的成对（周复盘那一段与工具箱的高亮用同一份）。 */
  async duplicates(
    workspace_id: WorkspaceId,
    options: { threshold?: number; limit?: number } = {},
  ): Promise<DuplicatePair[]> {
    return findDuplicates(await this.entries(workspace_id), {
      threshold: options.threshold ?? DUPLICATE_THRESHOLD,
      ...(options.limit === undefined ? {} : { limit: options.limit }),
    })
  }

  /** 好东西往上浮：被 ≥ 2 个岗位采用或周复盘点名 → Wilson 下界判要不要出卡。 */
  async promotionCandidates(input: {
    workspace_id: WorkspaceId
    named_in_review?: Iterable<string>
    to_layer?: CatalogLayer
  }): Promise<PromotionCandidate[]> {
    const entries = await this.entries(input.workspace_id)
    return promotionCandidates({
      entries,
      rejections: this.rejections(input.workspace_id),
      ...(input.named_in_review === undefined ? {} : { named_in_review: input.named_in_review }),
      ...(input.to_layer === undefined ? {} : { to_layer: input.to_layer }),
    })
  }

  /** 每条被"我这个不一样，仍新建"顶掉过几次。 */
  rejections(workspace_id: WorkspaceId): Record<string, number> {
    const counts: Record<string, number> = {}
    for (const note of this.store.list(workspace_id)) {
      if (note.reason_for_duplicate === undefined) continue
      for (const id of note.similar_to ?? []) counts[id] = (counts[id] ?? 0) + 1
    }
    return counts
  }

  /**
   * 记一次"我这个不一样，仍新建"。
   *
   * 理由是硬要求（40 §5 E4）：不给或太短就抛 {@link CatalogError}，调用方翻成 400。
   */
  noteDuplicate(input: {
    workspace_id: WorkspaceId
    entry_id: string
    similar_to: readonly string[]
    reason: string
    created_from?: CatalogOrigin
  }): CatalogNote {
    const reason = input.reason.trim()
    if (reason.length < MIN_REASON_LENGTH) {
      throw new CatalogError(
        'invalid_input',
        `选"仍新建"要写一句为什么（至少 ${MIN_REASON_LENGTH} 个字），它会进工具箱，下次别人查得到`,
      )
    }
    const note: CatalogNote = {
      workspace_id: input.workspace_id,
      entry_id: input.entry_id,
      similar_to: [...input.similar_to],
      reason_for_duplicate: reason,
      ...(input.created_from === undefined ? {} : { created_from: input.created_from }),
      at: this.#clock.now(),
    }
    this.store.put(note)
    return note
  }

  /** 复用 / 合并进已有的那一条：只记来源，不动别人的东西。 */
  noteReuse(input: {
    workspace_id: WorkspaceId
    entry_id: string
    reused: string
    conversation_id?: string
  }): CatalogNote {
    const note: CatalogNote = {
      workspace_id: input.workspace_id,
      entry_id: input.entry_id,
      created_from: {
        entry_id: input.reused,
        ...(input.conversation_id === undefined ? {} : { conversation_id: input.conversation_id }),
      },
      at: this.#clock.now(),
    }
    this.store.put(note)
    return note
  }

  /** 晋升落地：条目升层；个人副本指向公司版（记 `superseded_by`）。 */
  promote(input: {
    workspace_id: WorkspaceId
    entry_id: string
    to_layer: CatalogLayer
    /** 这些个人副本从此指向升上去的那一条 */
    supersede?: readonly string[]
  }): CatalogNote {
    const at = this.#clock.now()
    const note: CatalogNote = {
      workspace_id: input.workspace_id,
      entry_id: input.entry_id,
      layer: input.to_layer,
      at,
    }
    this.store.put(note)
    for (const id of input.supersede ?? []) {
      if (id === input.entry_id) continue
      this.store.put({
        workspace_id: input.workspace_id,
        entry_id: id,
        superseded_by: input.entry_id,
        at,
      })
    }
    return note
  }

  close(): void {
    this.store.close?.()
  }
}

/** 目录只会因为一件事拒绝：该写的理由没写。错误码沿 28 §2 的码表。 */
export class CatalogError extends Error {
  readonly code: 'invalid_input' | 'not_found'

  constructor(code: 'invalid_input' | 'not_found', message: string) {
    super(message)
    this.name = 'CatalogError'
    this.code = code
  }
}

function applyNote(entry: CatalogEntry, note: CatalogNote | undefined): CatalogEntry {
  if (note === undefined) return { ...entry, used_by_positions: [...entry.used_by_positions] }
  return {
    ...entry,
    used_by_positions: [...entry.used_by_positions],
    ...(note.layer === undefined ? {} : { layer: note.layer }),
    ...(note.superseded_by === undefined ? {} : { superseded_by: note.superseded_by }),
    ...(note.reason_for_duplicate === undefined
      ? {}
      : { reason_for_duplicate: note.reason_for_duplicate }),
    ...(note.created_from === undefined ? {} : { created_from: note.created_from }),
  }
}

/** 装配入口：给了路径就落盘（重启不丢那句理由），不给就是内存档。 */
export function createCatalog(options: {
  clock: Clock
  dbPath?: string
  store?: CatalogStore
  sources?: readonly CatalogSource[]
}): CatalogIndex {
  const store =
    options.store ??
    (options.dbPath === undefined
      ? undefined
      : new SqliteCatalogStore({ dbPath: options.dbPath, clock: options.clock }))
  return new CatalogIndex({
    clock: options.clock,
    ...(store === undefined ? {} : { store }),
    ...(options.sources === undefined ? {} : { sources: options.sources }),
  })
}
