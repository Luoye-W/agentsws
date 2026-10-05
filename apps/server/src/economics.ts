/**
 * WP224（docs/91 §2.2 #3）：**毛利率事实卡**——品牌事实里的一格，负责人在「公司 → 品牌」页填。
 *
 * 毛利率就是知识库里的一张事实卡（`subject.type = gross_margin`），不另起一张表：
 * Agent 检索事实卡时自然找得到它（`unit-economics` 技能写的就是「毛利率从事实卡取」），
 * 知识库页上也看得见谁、什么时候填的。
 *
 * 三条纪律：
 *
 * 1. **人填的直接生效**：负责人自己在公司页上填，等于他本人提一张卡再由他本人激活
 *    （同 WP159 违规宣称规则的做法）；同 key 的旧卡退役（留痕，不删）。
 * 2. **没填就是没填**：清掉一格 = 那张卡退役，不写 0、不写「行业平均」。
 * 3. **面板那一侧读缓存**：投放面板的投影是同步取的（`workData.ads()`），所以这里留一份
 *    缓存，`refresh()` 在每次读面板之前（`ensureFresh`）与每次写之后刷新。
 */

import { ApiError } from '@agentsws/api'
import type {
  FactCard,
  GrossMarginEntry,
  GrossMarginInput,
  GrossMarginsView,
  Iso8601,
  KnowledgeStore,
  PermissionScope,
  PersonId,
  RangeRef,
  WorkspaceId,
} from '@agentsws/contracts'
import { GROSS_MARGIN_SUBJECT_TYPE, grossMarginKey } from '@agentsws/contracts'

/** 读知识库用的身份（带授权；`packages/knowledge` 的 `GrantedActor`）。 */
export interface EconomicsReader {
  person_id: PersonId
  workspace_id: WorkspaceId
  assignment_id: string
  role_id: string
  grants: PermissionScope[]
  ranges?: RangeRef[]
}

export interface EconomicsServiceOptions {
  workspace_id: WorkspaceId
  clock: { now(): Iso8601 }
  knowledge: Pick<KnowledgeStore, 'propose' | 'activate' | 'retire'> & {
    list(
      filter: { workspace_id: WorkspaceId; status?: FactCard['status'] },
      actor: never,
    ): Promise<FactCard[]>
  }
  /**
   * 系统读（面板缓存）用的身份：这个品牌的所有者，只带「读公司级知识」一格。
   * 没有所有者（还没建好）就是 `undefined`——那时缓存是空的，面板上写「没填毛利率」。
   */
  systemReader(): Promise<EconomicsReader | undefined>
}

export interface EconomicsService {
  /** 缓存里那几格（同步；面板用）。 */
  margins(): GrossMarginEntry[]
  /** 从知识库重读一遍。 */
  refresh(): Promise<void>
  list(reader: EconomicsReader): Promise<GrossMarginsView>
  /** 填 / 改 / 清一格（`margin_pct: null` = 清）。 */
  save(reader: EconomicsReader, input: GrossMarginInput): Promise<GrossMarginsView>
}

/** 一格能不能存：0 < 毛利率 ≤ 100。别的一律拒（填错比没填更糟：它会被当真）。 */
export function validMarginPct(v: number): boolean {
  return Number.isFinite(v) && v > 0 && v <= 100
}

function statementOf(input: GrossMarginInput & { margin_pct: number }): string {
  const what =
    input.scope === 'brand'
      ? '整个品牌'
      : input.scope === 'category'
        ? `品类「${input.key ?? ''}」`
        : `SKU ${input.key ?? ''}`
  return `${what}的毛利率是 ${input.margin_pct}%（负责人在公司页填写）`
}

/** 一张毛利率事实卡（提议形；由填的人自己激活）。 */
export function grossMarginCard(input: {
  workspace_id: WorkspaceId
  owner: PersonId
  at: Iso8601
  scope: GrossMarginInput['scope']
  key?: string
  margin_pct: number
}): Omit<FactCard, 'id' | 'status' | 'usage' | 'created_at' | 'updated_at'> {
  const key = input.scope === 'brand' ? undefined : input.key?.trim()
  return {
    schema_version: 1,
    workspace_id: input.workspace_id,
    layer: 'fact',
    domain: 'company',
    scope: [],
    // 投放、店铺的 Agent 都要能检索到它（它们的知识读权限是 internal）
    sensitivity: 'internal',
    subject: {
      type: GROSS_MARGIN_SUBJECT_TYPE,
      id: input.scope,
      key: grossMarginKey(input.scope, key),
    },
    statement: statementOf({
      scope: input.scope,
      ...(key === undefined ? {} : { key }),
      margin_pct: input.margin_pct,
    }),
    structured: {
      scope: input.scope,
      ...(key === undefined ? {} : { key }),
      margin_pct: input.margin_pct,
    },
    provenance: [
      {
        source: 'human',
        ref: 'company-page:gross-margin',
        locator: '公司 → 品牌 · 毛利率',
        at: input.at,
      },
    ],
    confidence: { value: 1, state: 'verified' },
    valid: { from: input.at },
    last_verified_at: input.at,
    owner: input.owner,
    created_by: { kind: 'person', id: input.owner },
  }
}

/** 一张生效的卡 → 一格。认不出来的（结构化那一格坏了）跳过，不猜。 */
export function entryOf(card: FactCard): GrossMarginEntry | undefined {
  if (card.subject.type !== GROSS_MARGIN_SUBJECT_TYPE || card.status !== 'active') return undefined
  const s = card.structured ?? {}
  const scope = s.scope
  const pct = s.margin_pct
  if (scope !== 'brand' && scope !== 'category' && scope !== 'sku') return undefined
  if (typeof pct !== 'number' || !validMarginPct(pct)) return undefined
  const key = typeof s.key === 'string' ? s.key : undefined
  if (scope !== 'brand' && (key === undefined || key === '')) return undefined
  return {
    scope,
    ...(key === undefined || scope === 'brand' ? {} : { key }),
    margin_pct: pct,
    fact_card_id: card.id,
    updated_at: card.updated_at,
    updated_by: card.owner,
  }
}

const ORDER = { brand: 0, category: 1, sku: 2 } as const

export function createEconomicsService(options: EconomicsServiceOptions): EconomicsService {
  let cache: GrossMarginEntry[] = []

  const activeCards = async (reader: EconomicsReader): Promise<FactCard[]> =>
    (
      await options.knowledge.list(
        { workspace_id: options.workspace_id, status: 'active' },
        reader as never,
      )
    ).filter((c) => c.subject.type === GROSS_MARGIN_SUBJECT_TYPE)

  const toView = (cards: FactCard[]): GrossMarginsView => ({
    entries: cards
      .map(entryOf)
      .filter((e): e is GrossMarginEntry => e !== undefined)
      .sort((a, b) => ORDER[a.scope] - ORDER[b.scope] || (a.key ?? '').localeCompare(b.key ?? '')),
  })

  const refresh = async (): Promise<void> => {
    const reader = await options.systemReader()
    if (reader === undefined) return
    try {
      cache = toView(await activeCards(reader)).entries
    } catch {
      // 读不到就保留上一份（面板读的是缓存；这一跳不该把面板打挂）
    }
  }

  return {
    margins: () => cache.map((e) => ({ ...e })),
    refresh,
    list: async (reader) => toView(await activeCards(reader)),
    async save(reader, input) {
      const key = input.scope === 'brand' ? undefined : input.key?.trim()
      if (input.scope !== 'brand' && (key === undefined || key === ''))
        throw new ApiError(
          'invalid_input',
          input.scope === 'category' ? '品类名不能空着' : 'SKU 不能空着',
        )
      if (input.margin_pct !== null && !validMarginPct(input.margin_pct))
        throw new ApiError('invalid_input', '毛利率要在 0 到 100 之间（不含 0）')
      const subjectKey = grossMarginKey(input.scope, key)
      const old = (await activeCards(reader)).filter((c) => c.subject.key === subjectKey)
      if (input.margin_pct !== null) {
        const card = await options.knowledge.propose(
          grossMarginCard({
            workspace_id: options.workspace_id,
            owner: reader.person_id,
            at: options.clock.now(),
            scope: input.scope,
            ...(key === undefined ? {} : { key }),
            margin_pct: input.margin_pct,
          }),
        )
        await options.knowledge.activate(card.id, reader.person_id)
      }
      for (const c of old) await options.knowledge.retire(c.id, reader.person_id)
      await refresh()
      return toView(await activeCards(reader))
    },
  }
}
