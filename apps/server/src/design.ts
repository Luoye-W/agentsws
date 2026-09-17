/**
 * 设计库的存储、投影与 `/v1/design/*` 的实现（58 §1 / §5 数据面，WP76）。
 *
 * 三类对象（`design_request` / `design_brief` / `design_asset`）落在**这个品牌
 * 自己的**目录下（WP66 的 `BrandModules`：bootstrap 品牌用原来那个目录，别的
 * 品牌在 `<dbDir>/brands/<workspace_id>/` 下）。形状照 `social.ts` 抄：一张表
 * 一列 json，后端要么 sqlite 要么全内存（测试与一次性任务）。
 *
 * 五条纪律：
 *
 * 1. **素材的字节不在这张库里**。库里只有 `blob_uri`；字节进 blob store
 *    （41 §2），key 按 `design/<workspace>/<duty>/<asset_id>.<ext>` 拼——
 *    品牌在最前面，删一个品牌就是删一个前缀。
 * 2. **人没点「就这张」之前什么都不算定稿**（04 §6 / 58 §1）。`publishAsset`
 *    里的 `picked_by` 是**服务端按请求人盖的**，不是调用方递进来的一格；
 *    guardrail 那边没有它就 block。这个文件里也没有一处直接把状态写成
 *    `published`——那是执行器在卡被批准之后做的事。
 * 3. **写动作永远先出卡**。brief → `design_brief`（L3）、变体 →
 *    `design_variant`（L2）、入库 → `asset_publish`（**L1 硬顶**）、
 *    下需求单 → `design_request`（L3）。四条都经 `ledger.stage` 走 guardrail。
 * 4. **没有图片模型就明说**（58 §1）。`generateVariants` 看
 *    `gateway.images.available`；出不了图的时候回的是那句人话 +
 *    一份**照样能用的**变体计划（尺寸、角度、提示词都在），不是一句"生成失败"。
 * 5. **需求原文是外部文本**。`DesignRequest.need` 是别的岗位（甚至顾客的一句话）
 *    写的，原样存、原样端出去，不在这一层改写，也不当指令读（21 §1 / 39）。
 */

import { createRequire } from 'node:module'
import { join } from 'node:path'
import type {
  DesignActor,
  DesignAssetInput,
  DesignAssetRow,
  DesignBriefRow,
  DesignBriefView,
  DesignPort,
  DesignRequestInput,
  DesignRequestRow,
  DesignStagedView,
  DesignVariantView,
} from '@agentsws/api'
import { ApiError } from '@agentsws/api'
import type { BlobStore } from '@agentsws/blob'
import type {
  ApprovalBus,
  AssignmentId,
  ChangeKind,
  Clock,
  DesignAsset,
  DesignBrief,
  DesignDuty,
  DesignRequest,
  DesignRequestStatus,
  EffectiveConfig,
  EventEnvelope,
  ImageProvider,
  Mandate,
  ObjectRef,
  ProvenanceState,
  WorkspaceId,
} from '@agentsws/contracts'
import { DESIGN_DUTIES, designDutyForSource, designDutySpec } from '@agentsws/contracts'
import type { DesignDeckData } from '@agentsws/deck'
import type {
  BrandSystemCard,
  DraftBriefResult,
  GenerationPlan,
  ResolvedBrandSystem,
} from '@agentsws/design-core'
import {
  assetBlobKey,
  brandSystemMissingCard,
  briefSummaryZh,
  draftBrief,
  filterAssets,
  groupByUse,
  pickCardNoteZh,
  planGeneration,
  resolveBrandSystem,
  resolveSpec,
  specNoteZh,
  weeklyOutput,
} from '@agentsws/design-core'
import type { StageInput, StageOutcome } from '@agentsws/txn'
import type BetterSqlite3 from 'better-sqlite3'

/* ── 存储 ─────────────────────────────────────────────────────────────── */

/** 库里的三张表。名字与对象类型一一对应，不另起别名。 */
export type DesignTable = 'design_request' | 'design_brief' | 'design_asset'

export const DESIGN_TABLES: readonly DesignTable[] = [
  'design_request',
  'design_brief',
  'design_asset',
]

interface DesignBackend {
  all<T>(table: DesignTable): T[]
  get<T>(table: DesignTable, id: string): T | undefined
  put(table: DesignTable, id: string, row: unknown): void
  close(): void
}

function createMemoryBackend(): DesignBackend {
  const tables = new Map<DesignTable, Map<string, unknown>>()
  const of = (t: DesignTable): Map<string, unknown> => {
    const found = tables.get(t)
    if (found !== undefined) return found
    const fresh = new Map<string, unknown>()
    tables.set(t, fresh)
    return fresh
  }
  return {
    all: <T>(t: DesignTable) => [...of(t).values()].map((r) => structuredClone(r) as T),
    get: <T>(t: DesignTable, id: string) => {
      const row = of(t).get(id)
      return row === undefined ? undefined : (structuredClone(row) as T)
    },
    put: (t, id, row) => {
      of(t).set(id, structuredClone(row))
    },
    close: () => tables.clear(),
  }
}

const SCHEMA = DESIGN_TABLES.map(
  (t) => `CREATE TABLE IF NOT EXISTS ${t} (id TEXT PRIMARY KEY, json TEXT NOT NULL);`,
).join('\n')

function createSqliteBackend(dbPath: string): DesignBackend {
  const require = createRequire(import.meta.url)
  const Database = require('better-sqlite3') as typeof BetterSqlite3
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.exec(SCHEMA)
  return {
    all: <T>(t: DesignTable) =>
      (db.prepare(`SELECT json FROM ${t} ORDER BY id`).all() as { json: string }[]).map(
        (r) => JSON.parse(r.json) as T,
      ),
    get: <T>(t: DesignTable, id: string) => {
      const row = db.prepare(`SELECT json FROM ${t} WHERE id = ?`).get(id) as
        | { json: string }
        | undefined
      return row === undefined ? undefined : (JSON.parse(row.json) as T)
    },
    put: (t, id, row) => {
      db.prepare(
        `INSERT INTO ${t} (id, json) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET json = excluded.json`,
      ).run(id, JSON.stringify(row))
    },
    close: () => {
      db.close()
    },
  }
}

export interface DesignStoreOptions {
  workspace_id: WorkspaceId
  /** 这个品牌的落盘目录（`BrandModules` 给的那一个）。不给就全内存。 */
  dbDir?: string
}

export interface DesignStore {
  readonly workspace_id: WorkspaceId
  requests(filter?: {
    duty?: DesignDuty
    from_role_id?: string
    status?: DesignRequestStatus
  }): DesignRequest[]
  request(id: string): DesignRequest | undefined
  briefs(filter?: { duty?: DesignDuty; request_id?: string }): DesignBrief[]
  brief(id: string): DesignBrief | undefined
  assets(filter?: {
    duty?: DesignDuty
    brief_id?: string
    request_id?: string
    status?: DesignAsset['status']
  }): DesignAsset[]
  asset(id: string): DesignAsset | undefined

  saveRequest(row: DesignRequest): void
  saveBrief(row: DesignBrief): void
  saveAsset(row: DesignAsset): void
  /**
   * 需求单走到下一步。
   *
   * 需求单不在就什么也不做（**不凭空建一条**：一张只有状态没有需求的单，
   * 在队列里会变成一行没人认得的东西）。
   */
  advanceRequest(id: string, status: DesignRequestStatus, at: string): void
  close(): void
}

export function createDesignStore(options: DesignStoreOptions): DesignStore {
  const backend =
    options.dbDir === undefined
      ? createMemoryBackend()
      : createSqliteBackend(join(options.dbDir, 'design.sqlite'))

  return {
    workspace_id: options.workspace_id,
    requests: (filter) =>
      backend
        .all<DesignRequest>('design_request')
        .filter((r) => filter?.duty === undefined || r.duty === filter.duty)
        .filter((r) => filter?.from_role_id === undefined || r.from_role_id === filter.from_role_id)
        .filter((r) => filter?.status === undefined || r.status === filter.status),
    request: (id) => backend.get<DesignRequest>('design_request', id),
    briefs: (filter) =>
      backend
        .all<DesignBrief>('design_brief')
        .filter((b) => filter?.duty === undefined || b.duty === filter.duty)
        .filter((b) => filter?.request_id === undefined || b.request_id === filter.request_id),
    brief: (id) => backend.get<DesignBrief>('design_brief', id),
    assets: (filter) =>
      backend
        .all<DesignAsset>('design_asset')
        .filter((a) => filter?.duty === undefined || a.duty === filter.duty)
        .filter((a) => filter?.brief_id === undefined || a.brief_id === filter.brief_id)
        .filter((a) => filter?.request_id === undefined || a.request_id === filter.request_id)
        .filter((a) => filter?.status === undefined || a.status === filter.status),
    asset: (id) => backend.get<DesignAsset>('design_asset', id),

    saveRequest: (row) => backend.put('design_request', row.id, row),
    saveBrief: (row) => backend.put('design_brief', row.id, row),
    saveAsset: (row) => backend.put('design_asset', row.id, row),

    advanceRequest: (id, status, at) => {
      const found = backend.get<DesignRequest>('design_request', id)
      if (found === undefined) return
      backend.put('design_request', id, { ...found, status, updated_at: at })
    },

    close: () => backend.close(),
  }
}

/* ── 面板投影 ─────────────────────────────────────────────────────────── */

/** 每块最多端多少行——面板不是导出。 */
const MAX_ROWS = 20
const SEVEN_DAYS = 7 * 86_400_000

/** 需求原文摘要：卡面与表格上那一列。**原样截断，不改写**（外部文本，21 §1）。 */
function excerpt(text: string, max = 60): string {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length <= max ? one : `${one.slice(0, max)}…`
}

/**
 * 来源职责 → 给人看的那一格。
 *
 * `roleName` 给了就用职责的中文名（"店铺管理"），不给才退回 id。
 * 面板上摆一个 `dtc.store` 不算错，但它要求读的人自己翻译一遍
 * ——而那份翻译在职责定义里本来就有（36 §2：卡面上不出裸 id）。
 */
function sourceLabel(role_id: string, roleName?: (id: string) => string | undefined): string {
  if (role_id === 'human') return '人手动开的'
  return roleName?.(role_id) ?? role_id
}

/**
 * `DesignStore` → 面板那五块要的那份投影（58 §3）。
 *
 * 放在这里而不是 deck 里：deck 是**纯**的（29 §1，它连库都不认识），
 * 而这一步要跨三张表把"这张素材是哪张单的"拼出来。deck 拿到的已经是算好的行。
 *
 * 三件事在这一跳定死：
 *
 * 1. **每一行都带 `duty`**。五条职责共用同一份投影，面板那一层按自己那条筛
 *    （`designDutyOfRole`）——不在这里按职责切，切了就得算五遍。
 * 2. **「本周产出」数的是定稿，不是出图张数**（`design-core` 的 `weeklyOutput`）。
 *    一天出三十张变体、一张都没定，这一周的产出是 0。
 * 3. **待定稿与待挑分得开**。待挑 = 机器出完了在等人看一眼；待定稿 = 人已经
 *    点过「就这张」、在等那张 L1 卡。混成一块，面板上就再也看不出球在谁那儿。
 */
export function designDeckData(
  store: Pick<DesignStore, 'requests' | 'briefs' | 'assets'>,
  options: { now?: string; roleName?: (role_id: string) => string | undefined } = {},
): DesignDeckData {
  const nowMs = options.now === undefined ? Number.NaN : Date.parse(options.now)
  const at = (iso: string | undefined): number => (iso === undefined ? Number.NaN : Date.parse(iso))
  const requests = store.requests()
  const briefs = store.briefs()
  const assets = store.assets()
  const briefById = new Map(briefs.map((b) => [b.id, b]))

  /** 需求单队列：还没出 brief 的那些，最老的在最上面（等最久的先做）。 */
  const request_queue = requests
    .filter((r) => r.status === 'queued')
    .slice()
    .sort((a, b) => at(a.due_at ?? a.created_at) - at(b.due_at ?? b.created_at))
    .slice(0, MAX_ROWS)
    .map((r) => ({
      request_id: r.id,
      duty: r.duty as string,
      from: sourceLabel(r.from_role_id, options.roleName),
      title: r.title,
      excerpt: excerpt(r.need),
      ...(r.due_at === undefined ? {} : { due_at: r.due_at }),
      // 过期 = 这件事没做成，不是"逾期"——面板上单独一格，不靠颜色表达
      overdue: r.due_at !== undefined && !Number.isNaN(nowMs) && Date.parse(r.due_at) < nowMs,
      created_at: r.created_at,
    }))

  /** 进行中：出了 brief、还没定稿的那些。 */
  const in_progress = requests
    .filter((r) => r.status === 'briefed' || r.status === 'generating')
    .slice()
    .sort((a, b) => at(a.updated_at ?? a.created_at) - at(b.updated_at ?? b.created_at))
    .slice(0, MAX_ROWS)
    .map((r) => {
      const brief = briefs.find((b) => b.request_id === r.id)
      const variants = assets.filter((a) => a.request_id === r.id && a.status === 'variant')
      return {
        request_id: r.id,
        duty: r.duty as string,
        from: sourceLabel(r.from_role_id, options.roleName),
        title: r.title,
        status: r.status as string,
        ...(brief === undefined ? {} : { brief_id: brief.id }),
        planned: brief?.variant_plan.length ?? 0,
        generated: variants.length,
      }
    })

  /** 待挑 + 待定稿（两块分得开，见文件头第 3 条）。 */
  const awaiting_pick = assets
    .filter((a) => a.status === 'variant' || a.status === 'picked')
    .slice()
    .sort((a, b) => at(a.created_at) - at(b.created_at))
    .slice(0, MAX_ROWS)
    .map((a) => ({
      asset_id: a.id,
      duty: a.duty as string,
      spec: resolveSpec(a.spec_id)?.zh ?? a.spec_id,
      // 待挑 = 球在人手上要看一眼；待定稿 = 人点过了、在等那张 L1 卡
      stage: a.status === 'variant' ? ('waiting_pick' as const) : ('waiting_publish' as const),
      ...(a.brief_id === undefined
        ? {}
        : { brief_id: a.brief_id, goal: briefById.get(a.brief_id)?.goal ?? '' }),
      created_at: a.created_at,
    }))

  /** 素材库：按用途分组（没打标的归「没打标」，不藏起来）。 */
  const library = groupByUse(filterAssets(assets, { final_only: true }))
    .slice(0, MAX_ROWS)
    .map((g) => ({ use: g.zh, count: g.count, final: g.final }))

  const since = Number.isNaN(nowMs) === true ? '' : new Date(nowMs - SEVEN_DAYS).toISOString()
  const week = weeklyOutput(assets, since)

  return {
    request_queue,
    in_progress,
    awaiting_pick,
    library,
    weekly: {
      since: week.since,
      final: week.final,
      variants: week.variants,
      by_use: week.by_use.map((u) => ({ use: u.zh, count: u.count })),
    },
  }
}

/* ── `/v1/design/*` 的实现 ────────────────────────────────────────────── */

/** 动作 id（职责 yml 里那几个）。**只有这一处拼它们**。 */
export const DESIGN_ACTIONS = {
  requestDesign: 'request_design',
  draftBrief: 'draft_brief',
  generateVariants: 'generate_variants',
  stageAsset: 'stage_asset',
} as const

export interface DesignServiceOptions {
  workspace_id: WorkspaceId
  store: DesignStore
  clock: Clock
  approvals: ApprovalBus
  ledger: { stage(input: StageInput): Promise<StageOutcome> }
  /** 05 §4 生效配置：额度与等级从本次那条分配来。 */
  effectiveConfig(id: AssignmentId): EffectiveConfig
  appendEvent(e: Omit<EventEnvelope, 'id' | 'at'> & { at?: string }): void
  random(): number
  /**
   * 22 图片槽（58 §1）。**取值函数**而不是一格：模型设置改完立刻生效
   * （WP25），拿一格存下来的 provider 会停在装配那一刻。
   * **可以没有**——没有就只出 brief 与规格并明说（文件头第 4 条）。
   */
  images?(): ImageProvider | undefined
  /**
   * 素材字节住哪（41 §2）。不给就只记 `blob_uri` 之外的那些格——
   * 出图那一跳会说"这台机器还没配对象存储"。
   */
  blobs?: BlobStore
  /**
   * 品牌系统（公司层技能，24）。不给就是"这家公司还没设过"，
   * `design-core` 的 `brand.ts` 会出「先设品牌系统」卡。
   */
  brandCards?(): readonly BrandSystemCard[]
  /** 职责 id → 中文名（卡面与清单上「谁下的」那一格）。不给就显示 id。 */
  roleName?(role_id: string): string | undefined
}

export interface DesignServiceAssembly {
  port: DesignPort
}

export function createDesignService(options: DesignServiceOptions): DesignServiceAssembly {
  const { workspace_id, store, clock, ledger, appendEvent } = options

  let seq = 0
  const nextId = (prefix: string): string => {
    seq += 1
    const rand = Math.floor(options.random() * 0xffffffff)
      .toString(36)
      .padStart(7, '0')
    return `${prefix}_${rand}${seq.toString(36)}`
  }

  const emit = (type: string, actor: string, payload: Record<string, unknown>): void => {
    appendEvent({
      schema_version: 1,
      workspace_id,
      type,
      actor: { kind: 'person', id: actor as never },
      correlation: { trace_id: `tr_design_${clock.now()}` },
      payload,
    })
  }

  /** 额度与等级（05 §4）。查不到就按最严的一档办。 */
  const actionOf = (
    assignment_id: AssignmentId,
    action: string,
  ): { mandate: Mandate; level: 'L1' | 'L2' | 'L3' } => {
    try {
      const config = options.effectiveConfig(assignment_id)
      return {
        mandate: config.actions.find((a) => a.id === action)?.mandate ?? { caps: {} },
        level: config.automation[action]?.level ?? 'L1',
      }
    } catch {
      return { mandate: { caps: {} }, level: 'L1' }
    }
  }

  const provenanceOf = (run_id: string, seen: ObjectRef[]): ProvenanceState => {
    const grouped: Record<string, string[]> = {}
    for (const ref of seen) {
      const list = grouped[ref.type] ?? []
      if (!list.includes(ref.id)) list.push(ref.id)
      grouped[ref.type] = list
    }
    return { run_id, seen: grouped, read_full: [], recorded_at: clock.now() }
  }

  /** 一条 staged change 的共用那一段（提上去 → 翻成视图）。 */
  const stageOne = async (input: {
    actor: DesignActor
    action: string
    kind: ChangeKind
    target: ObjectRef
    before: unknown
    after: unknown
    notes: string[]
    title: string
    summary: string
    seen: ObjectRef[]
  }): Promise<DesignStagedView> => {
    const run_id = `run_design_${nextId('d')}`
    const { mandate, level } = actionOf(input.actor.assignment_id, input.action)
    const outcome = await ledger.stage({
      workspace_id,
      role_id: input.actor.role_id,
      assignment_id: input.actor.assignment_id,
      run_id,
      change_set_id: `cs_${run_id}`,
      kind: input.kind,
      target: input.target,
      before: input.before,
      after: input.after,
      notes: input.notes,
      created_by: { kind: 'person', id: input.actor.person_id },
      mandate,
      level,
      provenance: provenanceOf(run_id, input.seen),
      approval: {
        title: input.title,
        summary: input.summary,
        recipients: [{ person: input.actor.person_id, via: 'role_holder' }],
        proposer: {
          kind: 'person',
          id: input.actor.person_id,
          assignment_id: input.actor.assignment_id,
        },
        rule: 'role_holder',
        separation_of_duties: false,
        source_events: [],
      },
    })
    if (!outcome.ok) return { staged: false, message: outcome.message, level }
    return {
      staged: true,
      change_id: outcome.change.id,
      approval_item_id: outcome.approval.id,
      level: outcome.approval.automation.level_at_creation,
    }
  }

  /** 一组规格 id → 卡面上那一格（一条就写它的中文名，多条就写"N 个尺寸"）。 */
  const specLabel = (ids: readonly string[]): string | undefined => {
    if (ids.length === 0) return undefined
    if (ids.length === 1) return resolveSpec(ids[0] as string)?.zh ?? ids[0]
    return `${ids.length} 个尺寸`
  }

  const brandOf = (duty: DesignDuty): ResolvedBrandSystem =>
    resolveBrandSystem(options.brandCards?.() ?? [], duty)

  const requestOr404 = (id: string): DesignRequest => {
    const found = store.request(id)
    if (found === undefined) throw new ApiError('not_found', `没有这张需求单：${id}`)
    return found
  }
  const briefOr404 = (id: string): DesignBrief => {
    const found = store.brief(id)
    if (found === undefined) throw new ApiError('not_found', `没有这份 brief：${id}`)
    return found
  }
  const assetOr404 = (id: string): DesignAsset => {
    const found = store.asset(id)
    if (found === undefined) throw new ApiError('not_found', `没有这张素材：${id}`)
    return found
  }

  const requestRow = (r: DesignRequest): DesignRequestRow => ({
    ...r,
    duty_name: designDutySpec(r.duty)?.zh ?? r.duty,
    from_label: sourceLabel(r.from_role_id, options.roleName),
  })

  const assetRow = (a: DesignAsset): DesignAssetRow => ({
    ...a,
    spec_name: resolveSpec(a.spec_id)?.zh ?? a.spec_id,
    spec_note: (() => {
      const spec = resolveSpec(a.spec_id)
      return spec === undefined ? a.spec_id : specNoteZh(spec)
    })(),
  })

  const briefRow = (b: DesignBrief, result?: DraftBriefResult): DesignBriefRow => ({
    ...b,
    duty_name: designDutySpec(b.duty)?.zh ?? b.duty,
    summary_zh: result === undefined ? '' : briefSummaryZh(result),
  })

  const port: DesignPort = {
    requests: (actor, filter) => {
      const rows = store
        .requests({
          ...(filter.duty === undefined ? {} : { duty: filter.duty }),
          ...(filter.from_role_id === undefined ? {} : { from_role_id: filter.from_role_id }),
          ...(filter.status === undefined ? {} : { status: filter.status }),
        })
        .slice()
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .slice(0, filter.limit ?? 50)
        .map(requestRow)
      void actor
      return { rows }
    },

    /**
     * 别的岗位下一张需求单（58 §1 / 54）。
     *
     * `duty` 不是调用方指定的：由来源职责查 `designDutyForSource`。查不到就
     * 报回去让人定（54 §2 拿不准就问一句，**不猜**）——猜错的后果是这张单
     * 进了展会设计的队列，而它要的是一张 IG 方图。
     */
    createRequest: async (actor, input) => {
      const duty =
        input.duty ??
        designDutyForSource(actor.role_id)?.id ??
        designDutyForSource(input.from_role_id ?? actor.role_id)?.id
      if (duty === undefined)
        throw new ApiError(
          'invalid_input',
          `不知道这张单该归哪条设计职责（来源是 ${actor.role_id}）。在 duty 里指定一条：${DESIGN_DUTIES.map((d) => d.id).join(' / ')}。`,
        )
      const now = clock.now()
      const request: DesignRequest = {
        id: nextId('dreq'),
        workspace_id,
        duty,
        from_role_id: input.from_role_id ?? actor.role_id,
        ...(input.matter_id === undefined ? {} : { matter_id: input.matter_id }),
        title: input.title,
        // 外部文本，原样存（文件头第 5 条）
        need: input.need,
        spec_ids: input.spec_ids ?? [],
        ...(input.due_at === undefined ? {} : { due_at: input.due_at }),
        status: 'queued',
        created_at: now,
      }
      store.saveRequest(request)
      const staged = await stageOne({
        actor,
        action: DESIGN_ACTIONS.requestDesign,
        kind: 'design_request',
        target: { type: 'design_request', id: request.id },
        before: {},
        after: {
          duty,
          need: request.need,
          title: request.title,
          from_role_id: request.from_role_id,
        },
        notes: [`路由到设计岗的「${designDutySpec(duty)?.zh ?? duty}」。`],
        title: `给设计岗下一张单：${request.title}`,
        summary: excerpt(request.need, 120),
        seen: [{ type: 'design_request', id: request.id }],
      })
      emit('design.request_created', actor.person_id, {
        request_id: request.id,
        duty,
        from_role_id: request.from_role_id,
      })
      return { request: requestRow(request), staged }
    },

    /**
     * 需求单 → brief（58 §2）。**L3 自动**：它不产生任何外部可见的东西。
     *
     * 整理那一跳是 `design-core` 的纯函数（`draftBrief`），这里只负责给 id、
     * 给时间、落库、出卡。整理不出来的那几件事原样进卡面（`questions`），
     * **不编默认值**。
     */
    draftBrief: async (actor, request_id, input) => {
      const request = requestOr404(request_id)
      const brand = brandOf(request.duty)
      const now = clock.now()
      const result = draftBrief({
        request,
        brand_cards: options.brandCards?.() ?? [],
        ...(input.variants === undefined ? {} : { variants: input.variants }),
        id: nextId('dbrief'),
        at: now,
      })
      store.saveBrief(result.brief)
      store.advanceRequest(request.id, 'briefed', now)
      const staged = await stageOne({
        actor,
        action: DESIGN_ACTIONS.draftBrief,
        kind: 'design_brief',
        target: { type: 'design_brief', id: result.brief.id },
        before: {},
        after: {
          request_id: request.id,
          brief_id: result.brief.id,
          spec_ids: result.brief.spec_ids,
          // 卡面上那一格（`deck` 的 `spec` 芯片）：五条职责的卡长得一样，
          // 规格是分得开它们的那一个
          ...(specLabel(result.brief.spec_ids) === undefined
            ? {}
            : { spec_label: specLabel(result.brief.spec_ids) }),
          must_avoid: result.brief.must_avoid,
        },
        notes: result.questions.slice(),
        title: `brief：${request.title}`,
        summary: briefSummaryZh(result),
        seen: [
          { type: 'design_request', id: request.id },
          { type: 'design_brief', id: result.brief.id },
        ],
      })
      emit('design.brief_drafted', actor.person_id, {
        request_id: request.id,
        brief_id: result.brief.id,
        questions: result.questions.length,
      })
      const view: DesignBriefView = {
        brief: briefRow(result.brief, result),
        questions: result.questions.slice(),
        brand_note: brand.note,
        ...(brand.system === undefined ? { brand_system_missing: brandSystemMissingCard() } : {}),
        staged,
      }
      return view
    },

    /**
     * 出变体初稿（58 §1）。**L2 —— 出卡给人挑**。
     *
     * 没有图片模型的时候（文件头第 4 条）：计划照出，图不出，`image_model` 那一格
     * 带着那句人话回去。这不是降级——58 §1 写的就是"没有就明说只出 brief 与规格"。
     */
    generateVariants: async (actor, brief_id, input) => {
      const brief = briefOr404(brief_id)
      const brand = brandOf(brief.duty)
      const generated_today = store
        .assets({ duty: brief.duty })
        .filter((a) => a.created_at.slice(0, 10) === clock.now().slice(0, 10)).length
      const plan: GenerationPlan = planGeneration({
        brief,
        brand,
        generated_today,
        ...(input.plan_item_ids === undefined ? {} : { only_plan_item_ids: input.plan_item_ids }),
      })

      const images = options.images?.()
      const available = images?.available === true
      const now = clock.now()
      const assets: DesignAsset[] = []

      if (available && images !== undefined) {
        for (const p of plan.prompts) {
          const out = await images.generate({
            prompt: p.prompt,
            size: p.size,
            n: 1,
            meta: {
              workspace_id,
              assignment_id: actor.assignment_id,
              role_id: actor.role_id,
              run_id: `run_design_${nextId('img')}`,
              purpose: 'run',
            },
          })
          for (const image of out.assets) {
            const asset: DesignAsset = {
              id: nextId('dasset'),
              workspace_id,
              duty: brief.duty,
              brief_id: brief.id,
              request_id: brief.request_id,
              spec_id: p.spec_id,
              status: 'variant',
              content_type: image.content_type,
              width: image.width,
              height: image.height,
              provenance: {
                source: 'generated',
                brief_id: brief.id,
                variant_plan_item_id: p.plan_item_id,
                model: out.model,
                // **存哈希不存原文**（58 §1 末行）：提示词里可能带客户名与未发布的卖点
                prompt_sha256: image.prompt_sha256,
                generated_at: now,
              },
              created_at: now,
            }
            // 字节进 blob store，库里只留引用（文件头第 1 条）
            if (options.blobs !== undefined && image.bytes !== undefined) {
              const key = assetBlobKey(asset)
              const ref = await options.blobs.put(key, image.bytes, {
                content_type: image.content_type,
                workspace_id,
                filename: `${asset.id}.png`,
              })
              asset.blob_uri = ref.uri
              asset.bytes = ref.size
            }
            store.saveAsset(asset)
            assets.push(asset)
          }
        }
        store.advanceRequest(brief.request_id, 'awaiting_pick', now)
      } else {
        store.advanceRequest(brief.request_id, 'generating', now)
      }

      const staged = await stageOne({
        actor,
        action: DESIGN_ACTIONS.generateVariants,
        kind: 'design_variant',
        target: { type: 'design_brief', id: brief.id },
        before: {},
        after: {
          brief_id: brief.id,
          n: plan.n,
          prompts: plan.prompts.map((p) => p.prompt),
          must_avoid: brief.must_avoid,
          ...(specLabel(brief.spec_ids) === undefined
            ? {}
            : { spec_label: specLabel(brief.spec_ids) }),
          // 58 §1：没有图片模型就**明说**。这句话进卡面（deck 的
          // `no_image_model` 芯片），而不是一句"生成失败"
          ...(available
            ? {}
            : { no_image_model_reason: images?.unavailable_reason ?? NO_IMAGE_MODEL_FALLBACK }),
        },
        notes: [
          ...plan.quota_notes,
          ...(available ? [] : [images?.unavailable_reason ?? NO_IMAGE_MODEL_FALLBACK]),
        ],
        title: `挑一张：${designDutySpec(brief.duty)?.zh ?? brief.duty}`,
        summary: available
          ? pickCardNoteZh(plan, resolveSpec(plan.prompts[0]?.spec_id ?? ''))
          : (images?.unavailable_reason ?? NO_IMAGE_MODEL_FALLBACK),
        seen: [{ type: 'design_brief', id: brief.id }],
      })
      emit('design.variants_generated', actor.person_id, {
        brief_id: brief.id,
        planned: plan.n,
        generated: assets.length,
        image_model: available,
      })

      const view: DesignVariantView = {
        brief_id: brief.id,
        planned: plan.prompts.map((p) => ({
          plan_item_id: p.plan_item_id,
          spec_id: p.spec_id,
          size: p.size,
        })),
        assets: assets.map(assetRow),
        quota_notes: plan.quota_notes.slice(),
        image_model: {
          available,
          ...(available ? {} : { reason: images?.unavailable_reason ?? NO_IMAGE_MODEL_FALLBACK }),
        },
        pick_note: available
          ? pickCardNoteZh(plan, resolveSpec(plan.prompts[0]?.spec_id ?? ''))
          : (images?.unavailable_reason ?? NO_IMAGE_MODEL_FALLBACK),
        staged,
      }
      return view
    },

    /**
     * 人点了「就这张」→ 出一张入库卡（`asset_publish`，**L1 硬顶**）。
     *
     * `picked_by` 是**服务端按请求人盖的**（文件头第 2 条）：调用方递不进来
     * 一个别人的名字，Agent 也填不了这一格。这个方法本身**不把状态写成
     * `published`**——那是执行器在卡被批准之后做的事。
     */
    publishAsset: async (actor, asset_id, input) => {
      const asset = assetOr404(asset_id)
      const now = clock.now()
      const picked: DesignAsset = {
        ...asset,
        status: 'picked',
        tags: input.tags ?? asset.tags ?? [],
        provenance: { ...asset.provenance, picked_by: actor.person_id, picked_at: now },
        updated_at: now,
      }
      store.saveAsset(picked)
      const spec = resolveSpec(asset.spec_id)
      const staged = await stageOne({
        actor,
        action: DESIGN_ACTIONS.stageAsset,
        kind: 'asset_publish',
        target: { type: 'design_asset', id: asset.id },
        before: { status: asset.status },
        after: {
          asset_id: asset.id,
          spec_id: asset.spec_id,
          // guardrail 查的就是这一格：没有它 = Agent 自己定的稿 = block
          picked_by: actor.person_id,
          picked_at: now,
          ...(spec === undefined ? {} : { spec_label: spec.zh }),
          tags: picked.tags,
          ...(asset.request_id === undefined ? {} : { deliver_to_request: asset.request_id }),
        },
        notes: [
          '入库之后下游（上架 / 发布 / 投放 / 送印）直接拿它去用，所以这一下永远要人点。',
          ...(spec === undefined ? [] : [specNoteZh(spec)]),
        ],
        title: `定稿入库：${spec?.zh ?? asset.spec_id}`,
        summary:
          asset.request_id === undefined
            ? '入素材库。'
            : `入素材库并回给需求方（${asset.request_id}）。`,
        seen: [{ type: 'design_asset', id: asset.id }],
      })
      emit('design.asset_picked', actor.person_id, {
        asset_id: asset.id,
        ...(asset.request_id === undefined ? {} : { request_id: asset.request_id }),
      })
      return { asset: assetRow(picked), staged }
    },

    /** 「都不行再来」：这一批否掉，下一轮的提示词要知道上一轮被否了什么。 */
    rejectAssets: (actor, input) => {
      const now = clock.now()
      const rows = input.asset_ids.map((id) => {
        const asset = assetOr404(id)
        const rejected: DesignAsset = { ...asset, status: 'rejected', updated_at: now }
        store.saveAsset(rejected)
        return assetRow(rejected)
      })
      emit('design.variants_rejected', actor.person_id, {
        asset_ids: input.asset_ids,
        // 人说的那句"哪儿不对"原样留在事件里给下一轮读
        ...(input.reason === undefined ? {} : { reason: input.reason }),
      })
      return { rows }
    },

    assets: (actor, filter) => {
      void actor
      const rows = filterAssets(
        store.assets({
          ...(filter.duty === undefined ? {} : { duty: filter.duty }),
          ...(filter.brief_id === undefined ? {} : { brief_id: filter.brief_id }),
        }),
        {
          ...(filter.tag === undefined ? {} : { tag: filter.tag }),
          ...(filter.final_only === undefined ? {} : { final_only: filter.final_only }),
        },
      )
        .slice(0, filter.limit ?? 50)
        .map(assetRow)
      return { rows }
    },
  }

  return { port }
}

/** `gateway` 一格都没给的时候那句话（正常路径下读的是 provider 自己的 `unavailable_reason`）。 */
const NO_IMAGE_MODEL_FALLBACK =
  '这个服务进程没有装配图片模型。这条职责照样能用——它会出 brief、尺寸规格和变体计划，只是不出图。'

/* ── demo 的种子（36 §5.7）───────────────────────────────────────────── */

/**
 * demo 世界里的设计库（照 `seedDemoSocial` 的写法）。
 *
 * 三张需求单分别停在三个状态上，因为**面板要证明它分得开**：一张还在队列里、
 * 一张出了 brief 在出图、一张有几版变体在等人挑。都塞在"待挑"里的面板
 * 看起来很满，却回答不了"球在谁那儿"。
 */
export function seedDemoDesign(store: DesignStore, now: string): void {
  if (store.requests().length > 0) return
  const nowMs = Date.parse(now)
  const iso = (offsetMs: number): string => new Date(nowMs + offsetMs).toISOString()
  const DAY = 86_400_000
  const ws = store.workspace_id

  store.saveRequest({
    id: 'dreq_demo_1',
    workspace_id: ws,
    duty: 'dtc',
    from_role_id: 'dtc.store',
    title: '65W 充电器产品页主视觉',
    need: '下周上新。目标：让人一眼看懂一个口能同时喂笔记本和手机。受众：通勤的上班族。图上写“一个口，三台设备”。',
    spec_ids: ['web.hero.desktop', 'web.hero.mobile'],
    due_at: iso(4 * DAY),
    status: 'queued',
    created_at: iso(-1 * DAY),
  })

  store.saveRequest({
    id: 'dreq_demo_2',
    workspace_id: ws,
    duty: 'social',
    from_role_id: 'social.meta',
    title: '上新那条 IG 帖子的配图',
    need: '上新当天发一条 IG。目标：停留住三秒。受众：关注桌面好物的人。',
    spec_ids: ['social.ig.square'],
    status: 'briefed',
    created_at: iso(-2 * DAY),
    updated_at: iso(-1 * DAY),
  })

  store.saveRequest({
    id: 'dreq_demo_3',
    workspace_id: ws,
    duty: 'amazon',
    from_role_id: 'amz.listing',
    title: '主图重做（旧图是三年前拍的）',
    need: '目标：换一版更清楚的主图。受众：搜“桌面充电器”进来的人。按 Amazon 主图规矩来。',
    spec_ids: ['amazon.main'],
    status: 'awaiting_pick',
    created_at: iso(-3 * DAY),
    updated_at: iso(-2 * DAY),
  })

  store.saveBrief({
    id: 'dbrief_demo_2',
    workspace_id: ws,
    request_id: 'dreq_demo_2',
    duty: 'social',
    goal: '停留住三秒',
    audience: '关注桌面好物的人',
    key_message: '一个口，三台设备',
    copy: ['一个口，三台设备'],
    spec_ids: ['social.ig.square'],
    must_avoid: ['竞品 logo', '真人脸'],
    brand_system: 'brand-system',
    variant_plan: [
      {
        id: 'social.ig.square#1',
        spec_id: 'social.ig.square',
        angle_zh: '产品本身：干净背景、正面视角、细节清楚',
        prompt: '产品本身：干净背景、正面视角、细节清楚。1080×1080px',
      },
      {
        id: 'social.ig.square#2',
        spec_id: 'social.ig.square',
        angle_zh: '用起来什么样：真实场景里有人在用',
        prompt: '用起来什么样：真实场景里有人在用。1080×1080px',
      },
    ],
    created_at: iso(-1 * DAY),
  })

  store.saveBrief({
    id: 'dbrief_demo_3',
    workspace_id: ws,
    request_id: 'dreq_demo_3',
    duty: 'amazon',
    goal: '换一版更清楚的主图',
    audience: '搜“桌面充电器”进来的人',
    key_message: '一个口，三台设备',
    copy: [],
    spec_ids: ['amazon.main'],
    // 平台硬规矩翻成的禁忌词（`design-core` 的 `hardRules`）
    must_avoid: ['竞品 logo', '文字', '水印'],
    brand_system: 'brand-system',
    variant_plan: [
      {
        id: 'amazon.main#1',
        spec_id: 'amazon.main',
        angle_zh: '产品本身：干净背景、正面视角、细节清楚',
        prompt: '产品本身：干净背景、正面视角、细节清楚。2000×2000px；一个字都不许有',
      },
      {
        id: 'amazon.main#2',
        spec_id: 'amazon.main',
        angle_zh: '多大：与常见物件同框做尺寸参照',
        prompt: '多大：与常见物件同框做尺寸参照。2000×2000px；一个字都不许有',
      },
      {
        id: 'amazon.main#3',
        spec_id: 'amazon.main',
        angle_zh: '卖点摊开：几个关键点分块排列',
        prompt: '卖点摊开：几个关键点分块排列。2000×2000px；一个字都不许有',
      },
    ],
    created_at: iso(-2 * DAY),
  })

  for (const [i, angle] of ['amazon.main#1', 'amazon.main#2', 'amazon.main#3'].entries()) {
    store.saveAsset({
      id: `dasset_demo_${i + 1}`,
      workspace_id: ws,
      duty: 'amazon',
      brief_id: 'dbrief_demo_3',
      request_id: 'dreq_demo_3',
      spec_id: 'amazon.main',
      status: 'variant',
      content_type: 'image/png',
      width: 2000,
      height: 2000,
      provenance: {
        source: 'generated',
        brief_id: 'dbrief_demo_3',
        variant_plan_item_id: angle,
        model: { provider: 'local', model: 'stub-image' },
        prompt_sha256: `demo${i + 1}`.padEnd(64, '0'),
        generated_at: iso(-2 * DAY),
      },
      created_at: iso(-2 * DAY),
    })
  }

  /*
   * 第四张单：**独立站设计**那一条，停在"出完图在等人挑"。
   *
   * 为什么要有它：demo 登录的人挂的是 `design.dtc`，而面板五块各按自己那条
   * 职责筛（`designDeckData` 出一份、deck 那层按 duty 切）。少了这一张，
   * 独立站设计的面板上只有队列里一行，"进行中 / 待挑 / 素材库 / 本周产出"
   * 四块全是空的——那张截图证明不了 58 §3 那五块分得开。
   */
  store.saveRequest({
    id: 'dreq_demo_4',
    workspace_id: ws,
    duty: 'dtc',
    from_role_id: 'dtc.content',
    title: '秋季活动落地页 Banner',
    need: '目标：把"买二免一"说清楚。受众：老客。图上写“买二免一”。',
    spec_ids: ['web.banner'],
    status: 'generating',
    created_at: iso(-2 * DAY),
    updated_at: iso(-1 * DAY),
  })

  store.saveBrief({
    id: 'dbrief_demo_4',
    workspace_id: ws,
    request_id: 'dreq_demo_4',
    duty: 'dtc',
    goal: '把"买二免一"说清楚',
    audience: '老客',
    key_message: '买二免一',
    copy: ['买二免一'],
    spec_ids: ['web.banner'],
    must_avoid: ['竞品 logo', '真人脸'],
    brand_system: 'brand-system',
    variant_plan: [
      {
        id: 'web.banner#1',
        spec_id: 'web.banner',
        angle_zh: '产品本身：干净背景、正面视角、细节清楚',
        prompt: '产品本身：干净背景、正面视角、细节清楚。1440×480px；图上文字不超过 30 字',
      },
      {
        id: 'web.banner#2',
        spec_id: 'web.banner',
        angle_zh: '用起来什么样：真实场景里有人在用',
        prompt: '用起来什么样：真实场景里有人在用。1440×480px；图上文字不超过 30 字',
      },
      {
        id: 'web.banner#3',
        spec_id: 'web.banner',
        angle_zh: '卖点摊开：几个关键点分块排列',
        prompt: '卖点摊开：几个关键点分块排列。1440×480px；图上文字不超过 30 字',
      },
    ],
    created_at: iso(-1 * DAY),
  })

  for (const [i, item] of ['web.banner#1', 'web.banner#2', 'web.banner#3'].entries()) {
    store.saveAsset({
      id: `dasset_demo_dtc_${i + 1}`,
      workspace_id: ws,
      duty: 'dtc',
      brief_id: 'dbrief_demo_4',
      request_id: 'dreq_demo_4',
      spec_id: 'web.banner',
      status: 'variant',
      content_type: 'image/png',
      width: 1440,
      height: 480,
      provenance: {
        source: 'generated',
        brief_id: 'dbrief_demo_4',
        variant_plan_item_id: item,
        model: { provider: 'local', model: 'stub-image' },
        prompt_sha256: `demodtc${i + 1}`.padEnd(64, '0'),
        generated_at: iso(-1 * DAY),
      },
      created_at: iso(-1 * DAY),
    })
  }

  // 上周已经定过稿的一张（"本周产出"与素材库那两块要有东西可看）。
  // 挂在 `dtc` 上：demo 登录的人挂的就是那一条职责。
  store.saveAsset({
    id: 'dasset_demo_final',
    workspace_id: ws,
    duty: 'dtc',
    spec_id: 'web.hero.desktop',
    status: 'published',
    content_type: 'image/png',
    width: 1920,
    height: 800,
    tags: ['hero'],
    blob_uri: 'blob://design/demo/dtc/dasset_demo_final.png',
    provenance: {
      source: 'generated',
      prompt_sha256: 'demofinal'.padEnd(64, '0'),
      generated_at: iso(-4 * DAY),
      picked_by: 'p_demo_owner',
      picked_at: iso(-4 * DAY),
    },
    created_at: iso(-4 * DAY),
  })
}
