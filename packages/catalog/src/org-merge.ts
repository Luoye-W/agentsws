/**
 * 45 H3 的**合并**那一半：两条组织对象并成一条。
 *
 * 三个地方要用同一套动作，所以它在这儿而不是在某一个装配里：
 *
 * 1. Join 向导批准落地（`apps/server/src/join.ts`，45 H2 / H3）；
 * 2. 夜间扫描出的那张"这两条是同一个吗"批准之后（`apps/server/src/org-duplicates.ts`，45 H4）；
 * 3. 模拟世界里的同一条路（`packages/simulation`，26 的场景得跑真规则，不是打桩）。
 *
 * 两条纪律：
 *
 * - **留下的那条取并集，并掉的那条变别名**（不删）：`superseded_by` 一断，
 *   并掉的那份就恢复可编辑，所以任何一次合并都退得回去。
 * - **挂在并掉那条上的岗位范围要跟着改指**，而且**留痕**：一条
 *   `range.alias_resolved`，范围真的多了少了再加一条 `assignment.range_expanded`
 *   （44 G5 的口径）。漏掉这一步，人的权限会停在一份没人读的副本上。
 *
 * 这里不建卡、不判权限、不碰审批总线：合不合是人在卡片上按的，这只管按下去之后发生什么。
 */
import type { Assignment, JoinObjectKind, ProductLineRule, RangeRef } from '@agentsws/contracts'
import type { RoleStore } from '@agentsws/roles'

/** 合并只用得着职责层的这三块。写成接口是为了测试里能塞一个假的进来。 */
export type OrgMergeStore = Pick<RoleStore, 'rangeGroups' | 'productLines' | 'assignments'>

/** 一条别名：个人 / 并掉的那条 → 留下的那条。 */
export interface OrgAlias {
  kind: JoinObjectKind
  from: string
  to: string
}

const rangeKeyOf = (r: RangeRef): string => `${r.kind}:${r.id}`

/**
 * 两条判据取并集。
 *
 * 不同平台直接回 `a`——那种情况在对照那一步就 `none` 了（平台是道门），
 * 走到这儿说明调用方判错了，宁可不改也不要把两个平台的判据混成一条。
 */
export function unionRule(a: ProductLineRule, b: ProductLineRule): ProductLineRule {
  if (a.platform !== b.platform) return structuredClone(a)
  const merge = (x?: readonly string[], y?: readonly string[]): string[] | undefined => {
    if (x === undefined && y === undefined) return undefined
    return [...new Set([...(x ?? []), ...(y ?? [])])]
  }
  if (a.platform === 'manual' && b.platform === 'manual')
    return { platform: 'manual', product_ids: merge(a.product_ids, b.product_ids) ?? [] }
  if (a.platform === 'amazon' && b.platform === 'amazon') {
    const asins = merge(a.asins, b.asins)
    const prefixes = merge(a.sku_prefixes, b.sku_prefixes)
    const brand = a.brand ?? b.brand
    return {
      platform: 'amazon',
      ...(asins === undefined ? {} : { asins }),
      ...(prefixes === undefined ? {} : { sku_prefixes: prefixes }),
      ...(brand === undefined ? {} : { brand }),
    }
  }
  if (a.platform === 'shopify' && b.platform === 'shopify') {
    const collections = merge(a.collection_ids, b.collection_ids)
    const tags = merge(a.tags, b.tags)
    const vendors = merge(a.vendors, b.vendors)
    const types = merge(a.product_types, b.product_types)
    return {
      platform: 'shopify',
      ...(collections === undefined ? {} : { collection_ids: collections }),
      ...(tags === undefined ? {} : { tags }),
      ...(vendors === undefined ? {} : { vendors }),
      ...(types === undefined ? {} : { product_types: types }),
    }
  }
  return structuredClone(a)
}

/** 一次合并的结果（进事件与回执）。 */
export interface OrgMergeResult {
  kind: JoinObjectKind
  keep: string
  drop: string
  name: string
  /** 品牌：合完之后有几个成员。 */
  members?: number
  /** 产品线：合完之后的判据平台。 */
  platform?: ProductLineRule['platform']
}

/**
 * 把 `drop` 并进 `keep`：留下的那条取并集，并掉的那条打 `superseded_by`。
 *
 * `name` 不给就用 `keep` 的名字（45 H3：公司那份是真源，名字默认跟着它）。
 * 两条同一个 id、或哪一条不在库里，都直接回 `undefined`——调用方照原样往下走。
 */
export function mergeOrgPair(
  store: OrgMergeStore,
  input: {
    kind: JoinObjectKind
    keep: string
    drop: string
    name?: string
    /** 记在留下那条上的来源（45 H2「谁带进来的」）。 */
    origin?: { workspace_id: string; person_id: string; object_id?: string }
  },
): OrgMergeResult | undefined {
  if (input.keep === input.drop) return undefined
  if (input.kind === 'range_group') {
    const keep = store.rangeGroups.get(input.keep)
    const drop = store.rangeGroups.get(input.drop)
    if (keep === undefined || drop === undefined) return undefined
    const name = input.name ?? keep.name
    const merged = store.rangeGroups.update(keep.id, {
      name,
      members: [...keep.members, ...drop.members],
      ...(input.origin === undefined ? {} : { origin: input.origin }),
    })
    store.rangeGroups.supersede(drop.id, keep.id)
    return {
      kind: 'range_group',
      keep: keep.id,
      drop: drop.id,
      name,
      members: merged.members.length,
    }
  }
  if (input.kind === 'product_line') {
    const keep = store.productLines.get(input.keep)
    const drop = store.productLines.get(input.drop)
    if (keep === undefined || drop === undefined) return undefined
    const name = input.name ?? keep.name
    const rule = unionRule(keep.rule, drop.rule)
    store.productLines.update(keep.id, {
      name,
      rule,
      ...(input.origin === undefined ? {} : { origin: input.origin }),
    })
    store.productLines.supersede(drop.id, keep.id)
    return { kind: 'product_line', keep: keep.id, drop: drop.id, name, platform: rule.platform }
  }
  // 店铺 / 平台账号范围没有自己的一张表：合并它就是把岗位上那个 id 改掉（下面那一步）
  return { kind: 'store_range', keep: input.keep, drop: input.drop, name: input.name ?? input.keep }
}

/** 一次改指的留痕（调用方拿去 `appendEvent`）。 */
export type OrgAliasTrace =
  | {
      type: 'range.alias_resolved'
      assignment_id: string
      changed: { from: string; to: string }[]
    }
  | {
      type: 'assignment.range_expanded'
      assignment_id: string
      person_id: string
      role_id: string
      added: RangeRef[]
      removed: RangeRef[]
    }

/**
 * 45 H3 最后一句：挂在被取代对象上的岗位范围自动指到留下的那一条。
 *
 * 品牌走 `range_groups`（改完 `assignments.update` 会自己重新展开成员）；
 * 产品线与店铺范围走 `ranges` 里的 id 替换。回一串要记的事件——**这里不记**，
 * 因为它不认识事件日志（这个包不接线）。
 */
export function rewriteAliasedAssignments(
  store: OrgMergeStore,
  aliases: readonly OrgAlias[],
  options: { assignments: readonly Assignment[] },
): { rewrites: number; traces: OrgAliasTrace[] } {
  const byId = new Map(aliases.map((a) => [a.from, a] as const))
  const traces: OrgAliasTrace[] = []
  if (byId.size === 0) return { rewrites: 0, traces }
  let rewrites = 0
  for (const a of options.assignments) {
    if (a.revoked_at !== undefined) continue
    const groupsBefore = a.range_groups ?? []
    const groupsAfter = groupsBefore.map((g) => byId.get(g)?.to ?? g)
    const rangesBefore = a.ranges
    const rangesAfter = rangesBefore.map((r) => {
      const hit = byId.get(r.id)
      return hit === undefined || hit.kind === 'range_group' ? r : { kind: r.kind, id: hit.to }
    })
    const groupsChanged = groupsAfter.some((g, i) => g !== groupsBefore[i])
    const rangesChanged = rangesAfter.some(
      (r, i) => rangeKeyOf(r) !== rangeKeyOf(rangesBefore[i] ?? r),
    )
    if (!groupsChanged && !rangesChanged) continue
    const next = store.assignments.update(a.id, {
      ranges: rangesAfter,
      ...(groupsChanged ? { range_groups: groupsAfter } : {}),
    })
    rewrites += 1
    traces.push({
      type: 'range.alias_resolved',
      assignment_id: a.id,
      changed: [...byId.values()].map((x) => ({ from: x.from, to: x.to })),
    })
    const beforeKeys = new Set(a.ranges.map(rangeKeyOf))
    const added = next.ranges.filter((r) => !beforeKeys.has(rangeKeyOf(r)))
    const afterKeys = new Set(next.ranges.map(rangeKeyOf))
    const removed = a.ranges.filter((r) => !afterKeys.has(rangeKeyOf(r)))
    if (added.length > 0 || removed.length > 0)
      traces.push({
        type: 'assignment.range_expanded',
        assignment_id: a.id,
        person_id: a.person_id,
        role_id: a.role_id,
        added,
        removed,
      })
  }
  return { rewrites, traces }
}
