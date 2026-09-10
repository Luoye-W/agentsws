/**
 * 工具箱的统一条目（40 §2.2 第 1 条）。
 *
 * 一个公司里"被建出来的自动化"其实有六种形状：装的应用、技能、流程、定时任务、
 * 对话里定制的卡、以及指导落成的规矩。它们分散在六个包里，谁都看不见谁——
 * 于是同一件事被做第二遍。这里把六种投影成**同一张卡片**：谁建的、哪些岗位在用、
 * 上次跑是什么时候、最近 30 天跑了几次、在哪一层。
 *
 * 本包不认识那六个包：条目由宿主用回调（{@link CatalogSource}）喂进来。
 */
import type { Iso8601, PersonId, WorkspaceId } from '@agentsws/contracts'

/** 六种"被建出来的东西"。 */
export type CatalogKind = 'app' | 'skill' | 'workflow' | 'schedule' | 'custom_card' | 'rule'

export const CATALOG_KINDS: readonly CatalogKind[] = [
  'app',
  'skill',
  'workflow',
  'schedule',
  'custom_card',
  'rule',
]

/** 三层（40 §2.2 第 3 条"往上浮"）：个人 → 部门 → 公司。 */
export type CatalogLayer = 'personal' | 'dept' | 'company'

export const CATALOG_LAYERS: readonly CatalogLayer[] = ['personal', 'dept', 'company']

/** 层的高低：晋升只能往上走。 */
export const LAYER_ORDER: Readonly<Record<CatalogLayer, number>> = {
  personal: 0,
  dept: 1,
  company: 2,
}

/** 这条东西是从哪来的：复用了别人的哪一条 / 哪次对话里定制出来的。 */
export interface CatalogOrigin {
  /** 复用 / 合并自目录里的哪一条 */
  entry_id?: string
  conversation_id?: string
  message_ref?: string
}

export interface CatalogEntry {
  kind: CatalogKind
  /** 目录里的稳定 id：`<kind>:<来源 id>`，由来源自己给。 */
  id: string
  title: string
  summary: string
  /** 谁建的。 */
  owner: PersonId
  layer: CatalogLayer
  /** 哪些岗位在用（assignment_id）。 */
  used_by_positions: string[]
  last_run_at?: Iso8601
  /** 最近 30 天跑了几次。跑不起来的东西（规矩、定制卡）就是 0。 */
  runs_30d: number
  created_from?: CatalogOrigin
  /** 选了"我这个不一样，仍新建"时写的那句话（40 §2.2 第 2 条）。 */
  reason_for_duplicate?: string
  /** 已经被公司版取代：个人副本指向它，不再各存一份。 */
  superseded_by?: string

  /* ── 三把钥匙里的两把，来源给得出就给（给不出就只按语义匹配） ── */
  /** 同触发器：`cron:0 9 * * *` / `event:order.paid` / `manual`。 */
  trigger?: string
  /** 同目标对象：`order:ord_1001` / `store:s_main` / `skill:dtc.aftersales`。 */
  target?: string

  workspace_id: WorkspaceId
  created_at?: Iso8601
}

/** 一个来源 = "某个包里现在有哪些条目"。宿主装配（`apps/server/src/catalog-index.ts`）。 */
export interface CatalogSource {
  kind: CatalogKind
  list(query: { workspace_id: WorkspaceId }): Promise<CatalogEntry[]> | CatalogEntry[]
}

/** 目录列表的筛选（40 §2.2 第 1 条：按 kind / 岗位 / 层筛）。 */
export interface CatalogFilter {
  workspace_id: WorkspaceId
  kind?: CatalogKind[]
  /** 只看这个岗位在用的 */
  position_id?: string
  layer?: CatalogLayer[]
  owner?: PersonId
  /** 按用途搜索（⌘K 同源）：词袋重合，不做模糊拼写 */
  text?: string
  /** 默认不列已被取代的个人副本 */
  include_superseded?: boolean
}

/** "建之前先查"的问句。 */
export interface SimilarQuery {
  workspace_id: WorkspaceId
  kind: CatalogKind
  title: string
  summary?: string
  trigger?: string
  target?: string
  /** 排除这一条（改自己的时候不该被自己挡住） */
  exclude_id?: string
  /** 覆盖默认门槛（0..1） */
  threshold?: number
  limit?: number
}

/** 三把钥匙里哪几把对上了。 */
export type SimilarKey = 'semantic' | 'trigger' | 'target' | 'kind'

export interface SimilarHit {
  entry: CatalogEntry
  /** 0..1，四位小数（不出现十几位连号，14 §6 的卡号扫描会误伤） */
  similarity: number
  keys: SimilarKey[]
  /** 人话理由，界面上直接显示 */
  reasons: string[]
}

/** 周复盘"疑似重复"段里的一对。 */
export interface DuplicatePair {
  a: CatalogEntry
  b: CatalogEntry
  similarity: number
  /** 两条都还在用（都有岗位在用或最近跑过）——这种才值得报给人 */
  both_in_use: boolean
  reasons: string[]
}

/** "往上浮"的候选。 */
export interface PromotionCandidate {
  entry: CatalogEntry
  to_layer: CatalogLayer
  /** 出哪种卡：技能走 24 的 `skill_promotion`，其余走 05 的 `policy_change` */
  card_kind: 'skill_promotion' | 'policy_change'
  /** 为什么进候选：被几个岗位采用 / 周复盘点名 */
  trigger: 'positions' | 'review'
  positions: number
  /** 被用过多少次（跑的次数 + 采用它的岗位数） */
  adoptions: number
  /** 有多少次别人看过它以后说"我这个不一样"（40 §2.2 第 2 条那句理由） */
  rejections: number
  samples: number
  /** Wilson 单侧 95% 下界（与 24 §3 晋升同一把尺子） */
  lower_bound: number
  passed: boolean
  missing: string[]
  title: string
  summary: string
}

/** 目录自己那一小块状态：理由、层的覆盖、被谁取代，以及"没有家的条目"本身。 */
export interface CatalogNote {
  workspace_id: WorkspaceId
  entry_id: string
  /** 建的时候查到过谁（"仍新建"就是对这些条目说了不） */
  similar_to?: string[]
  reason_for_duplicate?: string
  /** 晋升后的层（盖过来源给的层） */
  layer?: CatalogLayer
  superseded_by?: string
  created_from?: CatalogOrigin
  /**
   * 有些东西**没有别的家**：对话里定制出来的卡、指导落成的规矩，
   * 在别的包里没有一张自己的表。目录替它们保管一份，于是它们也进得了工具箱。
   * 有家的（定时任务、技能、流程）不会走这条，它们由来源回调喂进来。
   */
  entry?: CatalogEntry
  at: Iso8601
}
