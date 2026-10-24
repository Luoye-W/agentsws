/**
 * WP95（36 §11 C 档）：第三栏的**面板注册表**，形照官方 slot，骨架仍是我们自己的。
 *
 * 为什么要它：WP71 那一版把十一个面板**写死在图标轨的数组里**
 * （`right-rail.tsx` 的 `GROUPS`）。那等于"往第三栏加一个面板"永远要改核心文件——
 * 应用包（23）想塞一个面板进来就只能来提 PR。官方右栏早就不这么做了
 * （`docs/upstream/sidebar-compare.md` #2 / #4），这里把那条机制借过来。
 *
 * **两段式**（官方 `ctx.sidebarRightTabs.register` + `ctx.slots.register` 那两段）：
 *
 * | 段 | 我们 | 官方 | 为什么分两段 |
 * |---|---|---|---|
 * | 类型 | {@link registerPanelType} | `sidebarRightTabs.register({ id, kind, patterns, priority, canOpen })` | 纯静态声明。图标轨要画一个格子、`⌘K` 要搜得到、"谁来开这个资源"要排序——这三件事都不该等到面板的代码被下载下来 |
 * | 身体 | {@link registerPanelBody} | `slots.register({ name: 'sidebar.right.pane.tab', key }, Body)` | 真正的组件。分开之后身体可以是 `lazy()`，**没打开就不下载、不挂载、不发请求**（#6） |
 *
 * 两段各自回一个 disposer（卸载即注销），与官方 `ctx.effect` 里那两句同义。
 *
 * **谁来开某个资源**照官方那套三段排序（#3）：
 * `priority` 三档（`extension` > `builtin` > `fallback`）→ 命中的 pattern 长度 →
 * 注册顺序；`canOpen()` 一票否决。我们没有 `dsh-resource://`，地址用
 * `agentsws://<对象类型>/<id>`（与 47 的本体对象名对齐）。
 *
 * **纪律一条**（#4）：内置四个面板（记忆 / 技能 / 知识 / 额度）与其余既有面板
 * **全部走这条公开路**（见 `builtin-panels.tsx`），没有第二条内部通道。官方自己不走后门，
 * 我们也不许——一旦有了后门，第三方面板永远是二等公民，而"二等"会体现在
 * 它拿不到的那几个能力上。
 */
import type { LucideIcon } from 'lucide-react'
import { type ComponentType, useEffect } from 'react'
import type { RailScope, RailTier } from '@/components/rail/rail-scope'

/** 官方那三档，一个字不改（照抄是有意的：以后真要接官方面板，这一列不用翻译）。 */
export type PanelPriority = 'extension' | 'builtin' | 'fallback'

/** 图标轨上的三组（36 §9：这件事的 / 这个岗位或职责的 / 工具）。 */
export type PanelGroup = 'context' | 'layer' | 'tools'

const GROUP_ORDER: readonly PanelGroup[] = ['context', 'layer', 'tools']

/** `canOpen()` 与 {@link resolvePanel} 看到的东西。 */
export interface PanelOpenScope {
  /**
   * 要开的资源地址（`agentsws://matter/mat_1`）。
   * **不给 = 开的是一个"页"**（记忆、额度这类没有资源地址的面板），只按 id 开。
   */
  address?: string
  /** 当前在哪一层（岗位 / 职责）。 */
  tier?: RailTier
  scope_id?: string
}

/** 每个面板的身体拿到的 props（面板自己再决定用不用 scope）。 */
export interface RailPanelBodyProps {
  /** 这一页定位得到的那一层；定位不到时是 `undefined`（面板要照实说，不要去打注定 400 的接口）。 */
  scope?: RailScope
  tier: RailTier
  /** 当前地址（事项页的面板要从它里面认 `matter_id`）。 */
  pathname: string
  /**
   * WP208：一个面板里有几个标签时（「设定」的角色 / 记忆 / 知识 / 技能 / 额度），
   * 这一次开到哪一个。由 {@link registerPanelAlias} 的旧 id 带来（`show('memory')` →
   * 「设定」面板的「记忆」标签）；人点图标轨开的没有它，面板用自己的第一个标签。
   */
  sub?: string
  /**
   * WP97：这一次是**为哪个资源**打开的（`agentsws://file/src_1/报价单.xlsx`）。
   *
   * 人点图标轨打开的面板没有它（那是"开一个页"，不是"开一份资源"）。
   * 官方把资源地址算进 tab 身份的一部分，我们照做——区别只在**我们不把它写进本机**：
   * 布局只存结构（#5 / 40 §1.2），刷新之后这一格回到空，面板照实说"从知识库点一份文件"。
   */
  address?: string
}

export interface PanelTypeDefinition {
  /** 实现的身份，全局唯一（惯例：内置写短名，第三方写包名）。重复注册直接抛。 */
  id: string
  /** i18n 键（`rail.panel.memory`）；图标轨的 title 与面板头都用它。 */
  label: string
  /**
   * WP208：图标轨上悬停时的那一句（i18n 键）。不给就用 `label`。
   * 一个图标里装了几样东西时（「设定」），名字说不全，这一句说全。
   */
  hint?: string
  icon: LucideIcon
  priority: PanelPriority
  /** 图标轨上的哪一组；不给算 `tools`（第三方面板默认落在工具那一组）。 */
  group?: PanelGroup
  /**
   * 这个面板能开哪些资源地址（glob：`agentsws://matter/**`、`*.md`）。
   * **不给就是"页"**——只能按 id 打开，不参与 {@link resolvePanel} 的竞争。
   */
  matches?: readonly string[]
  /** 一票否决：排序排到它了，它仍可以说"这一条我开不了"。 */
  canOpen?(scope: PanelOpenScope): boolean
  /**
   * 跟着岗位 / 职责走吗（面板头显示"记忆 · 店铺管理"、有层切换）。
   * 工具类面板（问 AI、浏览器）不跟层走——它们看的不是"这一层的设置"。
   */
  scoped?: boolean
  /**
   * WP208：图标右上角的**数字徽标**（「定时任务」在跑几个、「运行中」有几个）。
   *
   * 是一个 hook：图标轨每个格子各自一个组件，挂载时调一次，拿到的是与面板身体
   * 同一份上下文（当前岗位 / 职责、地址）。回 `undefined` 或 `count` 为 0 就不画——
   * **0 不显示**（36 §7：没事的时候图标轨上一个多余的点都不要有）。
   * 它是静态那一段的一部分，所以要**轻**：只读缓存或一个小请求，别把面板身体拉下来。
   */
  useBadge?(props: RailPanelBodyProps): PanelBadge | undefined
  /**
   * WP324：**只按资源地址开**，不上图标轨、⌘K 不列（连接卡：从「去连接」开，平时不占一个图标）。
   */
  hidden?: boolean
  /**
   * WP372（决策 1001）：**露在窗口右上角那一排**，数字是排第几（小的在左）。
   * 不给 = 收在最右那个「⋮」菜单里。只有不属于任何卡的面板（浏览器、教程…）用得上它；
   * 五张卡自己的图标看 {@link RailCardDefinition.pinned}。
   */
  pinned?: number
  /**
   * WP372（决策 1004）：这个面板**归哪张卡**（`settings` → 卡「设定」的「显示更多」）。
   * 归了卡的面板不进「⋮」菜单（从卡上点进去）；按资源地址开它时（连接卡 `agentsws://connect/…`），
   * 右侧面板改成**展开那张卡并滚到那一条**，不再单独开一格。
   */
  card?: string
  /**
   * WP504：这一格至少多宽（库面板两列卡片要 560 左右）。人拖得更宽照旧记住；不给 = 照拖出来的宽度。
   * 原来只有报表那两格写死在 `right-pane.ts`，现在谁要谁声明。
   */
  minWidth?: number
}

/**
 * WP372（决策 1004 / 1005，Luoye 10-17）：右侧面板里的**一张卡**（对话 / 产出 / 计划 / 连接 / 设定）。
 *
 * 和面板一样两段式：类型（静态，右上角图标、标题行摘要与状态点要它）+ 身体（`lazy()`，展开才下载）。
 * 卡收起时只画标题行（图标、名字、状态点、一句摘要）；展开画身体——最多 {@link CARD_LIMIT} 条 +「显示更多」。
 */
export interface RailCardDefinition {
  id: string
  /** i18n 键。 */
  label: string
  icon: LucideIcon
  /** 默认顺序（小的在上）。人拖过之后按人记住的那一份（`lib/ui-state.ts`）。 */
  order: number
  /** 露在右上角那一排时排第几；不给 = 只在「⋮」与面板里。 */
  pinned?: number
  /** 「显示更多」开哪个面板（完整列表）。 */
  panel?: string
  /** 没有完整面板时「显示更多」去哪一页（连接 → 连接页）。 */
  moreHref?: string
  /**
   * WP456-T3（决策 1448）：**合进清单卡**——只有一行标题、里面没多少东西的卡（产出 / 连接 / 设定 / 工坊服务）
   * 不各占一张卡，合成看板最底下那一张清单卡，每行「名字 + 右边一句状态 + ›」，点了在第三栏开它的 `panel`
   * （没有 `panel` 时去 `moreHref`）。清单卡不参与拖动排序。
   */
  list?: true
  /**
   * 标题行的一句摘要与状态点。是 hook（与 `useBadge` 同一条规矩：轻，只读缓存或一个小请求）。
   * 右上角图标上的点也读它——卡上亮什么，图标上就亮什么。图标调用时 `detail` 为假：只要点，摘要要的重请求别发。
   */
  useStatus?(props: RailPanelBodyProps, detail: boolean): CardStatus | undefined
  /**
   * WP438：卡头右边的一个动作钮（报表卡的「+」：跟 AI 说想看什么，做一份新的）。
   * 不给 = 没有。点它不展开 / 收起卡片。
   */
  action?: {
    icon: LucideIcon
    /** i18n 键（悬停与读屏的那一句）。 */
    label: string
    /**
     * 点了做什么。不给时用 {@link intent}：展开这张卡并带上那个意图（「对话」卡头的「+」= 展开 + 开新对话那一格）。
     */
    onClick?(props: RailPanelBodyProps): void
    /** WP456-T3：展开这张卡时带的意图（卡身体自己认，如 `compose`）。 */
    intent?: string
  }
  /**
   * WP504（决策 1778 A）：这张卡**只在某些岗位出**（红人库只在有红人职责的岗位、知识库在客服 / B2B / 网站运营……）。
   * 纯函数，只看这一页的 `scope`（岗位 id、本人那几条职责）；回 `false` = 这一页的卡片列里没有它。不给 = 哪儿都出。
   */
  available?(props: RailPanelBodyProps): boolean
  /** WP504：没记过展开态时默认展开（库卡上那三行数字一眼要看到）。 */
  defaultOpen?: boolean
}

/** 卡标题行的状态点：红 = 坏了要修（连接过期），黄 = 等你看。 */
export type CardDot = 'alert' | 'attention'

export interface CardStatus {
  /** 收起时标题行右边那一句（已经翻译好）；清单卡那一行右边也是它。 */
  summary?: string
  /** WP456-T3（规范 §2.6 第 14 条）：卡头标题后面那个灰色计数（「对话 1」）；不给就不画。 */
  count?: number
  dot?: CardDot
  /** 悬停在状态点 / 图标上说的那一句（「1 个连接要重连」）。 */
  dotLabel?: string
}

/**
 * 卡展开后最多列几条（决策 1004：4 条 +「显示更多」）。
 * WP433（Luoye 10-20 问题 7）：改成 5 条；「显示更多」只在**多于 5 条**时才出，≤ 5 条不出（卡身体用 `onTotal` 报总数）。
 */
export const CARD_LIMIT = 5

export interface RailCardBodyProps extends RailPanelBodyProps {
  limit: number
  /** 「显示更多」：开完整列表（卡的 `panel`），由外壳给。 */
  onMore: () => void
  /**
   * WP433：这张卡一共有几条（完整列表里有、卡上放不下的也算）。外壳据此决定出不出「显示更多」
   * （多于 `limit` 才出）。不报 = 不出。
   */
  onTotal?: (total: number) => void
}

/** WP433：卡身体报总数（渲染完再报，数一变再报一次）。 */
export function useCardTotal(onTotal: ((total: number) => void) | undefined, total: number): void {
  useEffect(() => {
    onTotal?.(total)
  }, [onTotal, total])
}

export type RailCardBody = ComponentType<RailCardBodyProps>

/** WP208：图标右上角那个数，和悬停时替换 tooltip 的那一句（「3 个定时任务在跑」）。 */
export interface PanelBadge {
  count: number
  /** 已经翻译好的一句话（hook 里有 `t`）。 */
  label: string
}

/**
 * WP208：**旧 id 的去处**。几个面板合成一个之后（记忆 / 技能 / 知识 / 额度 / 角色 →「设定」），
 * 本机存着的布局、别处写死的 `show('memory')` 仍然要能开——开到新面板的对应标签。
 */
export interface PanelAlias {
  /** 旧 id（`memory`）。 */
  id: string
  /** 现在归哪个面板（`settings`）。 */
  panel: string
  /** 开到那个面板的哪个标签（`memory`）。 */
  sub?: string
}

export type PanelBody = ComponentType<RailPanelBodyProps>

export type Disposer = () => void

interface TypeEntry {
  definition: PanelTypeDefinition
  /** 注册顺序：排序的最后一档（官方也是这一条）。 */
  seq: number
}

const types = new Map<string, TypeEntry>()
const bodies = new Map<string, PanelBody>()
const aliases = new Map<string, PanelAlias>()
let counter = 0

/**
 * 第一段：声明一个面板**类型**。
 *
 * 只有静态信息，没有组件——所以图标轨画得出格子、`resolvePanel` 排得出序，
 * 而面板的代码这会儿还躺在另一个 chunk 里没下载。
 *
 * @throws 同一个 id 注册两次（官方也是直接抛：两个实现抢同一个身份，
 *   排序排出谁来都是错的，晚一点炸不如当场炸）。
 */
export function registerPanelType(definition: PanelTypeDefinition): Disposer {
  if (types.has(definition.id))
    throw new Error(`第三栏面板 id 重复：${definition.id}（一个 id 只能有一个实现）`)
  counter += 1
  const seq = counter
  types.set(definition.id, { definition, seq })
  return () => {
    // 只注销"自己那一次"：中间被别人重新注册过的话，注销的不该是别人那一份
    if (types.get(definition.id)?.seq === seq) types.delete(definition.id)
  }
}

/**
 * 第二段：给一个类型挂**身体**。
 *
 * `Body` 传 `lazy(() => import(...))` 就得到"启动不激活"（#6）——
 * React 只在真正挂载时才去解析那个 promise。
 *
 * @throws 同一个 id 挂两个身体（同上：抢同一个身份）。
 */
export function registerPanelBody(id: string, Body: PanelBody): Disposer {
  if (bodies.has(id)) throw new Error(`第三栏面板身体重复：${id}`)
  bodies.set(id, Body)
  return () => {
    if (bodies.get(id) === Body) bodies.delete(id)
  }
}

/**
 * WP208：登记一个旧 id → 新面板（+ 标签）。
 *
 * 别名不上图标轨、不进 {@link listPanelTypes}；它只在"按 id 开"那一刻被 {@link resolvePanelId} 认出来。
 *
 * @throws 旧 id 已经是一个活着的面板类型，或者已经登记过别名（同一个名字两种去处，开出来总有一个是错的）。
 */
export function registerPanelAlias(alias: PanelAlias): Disposer {
  if (types.has(alias.id) || aliases.has(alias.id))
    throw new Error(`第三栏面板别名撞名：${alias.id}`)
  aliases.set(alias.id, alias)
  return () => {
    if (aliases.get(alias.id) === alias) aliases.delete(alias.id)
  }
}

/**
 * WP208：按 id 开面板之前先过这一道——是旧 id 就换成它现在的去处与标签，不是就原样回。
 *
 * 活着的类型优先于别名（第三方以后真注册了一个叫 `memory` 的面板，它赢）。
 */
export function resolvePanelId(id: string): { id: string; sub?: string } {
  if (types.has(id)) return { id }
  const alias = aliases.get(id)
  if (alias === undefined) return { id }
  return alias.sub === undefined ? { id: alias.panel } : { id: alias.panel, sub: alias.sub }
}

/** 有类型、还没有身体的面板照样出现在图标轨上（点开显示"还没做"）。 */
export function panelBody(id: string): PanelBody | undefined {
  return bodies.get(id)
}

export function panelType(id: string): PanelTypeDefinition | undefined {
  return types.get(id)?.definition
}

/** 图标轨的顺序：先按组（这件事的 / 这一层的 / 工具），组内按注册顺序。 */
export function listPanelTypes(): PanelTypeDefinition[] {
  return [...types.values()]
    .filter((e) => e.definition.hidden !== true)
    .sort((a, b) => {
      const ga = GROUP_ORDER.indexOf(a.definition.group ?? 'tools')
      const gb = GROUP_ORDER.indexOf(b.definition.group ?? 'tools')
      return ga === gb ? a.seq - b.seq : ga - gb
    })
    .map((e) => e.definition)
}

/** 分好组的图标轨（空组不出，省得画一条没有按钮的分隔线）。 */
export function panelGroups(): { group: PanelGroup; panels: PanelTypeDefinition[] }[] {
  const all = listPanelTypes()
  return GROUP_ORDER.map((group) => ({
    group,
    panels: all.filter((p) => (p.group ?? 'tools') === group),
  })).filter((g) => g.panels.length > 0)
}

const PRIORITY_RANK: Record<PanelPriority, number> = { extension: 0, builtin: 1, fallback: 2 }

/**
 * glob：`*` 不跨 `/`，`**` 跨。
 *
 * 只认这两个（官方 patterns 也就用到这两个）。多认一个就要多写一份正则转义，
 * 而没有任何一个面板需要它。
 */
export function matchesAddress(pattern: string, address: string): boolean {
  const source = pattern
    .split('**')
    .map((part) =>
      part
        .split('*')
        .map((lit) => lit.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
        .join('[^/]*'),
    )
    .join('.*')
  return new RegExp(`^${source}$`).test(address)
}

/**
 * **谁来开这个资源**（官方"编辑器解析器"那套，#3）。
 *
 * 三段排序：`priority` 三档 → 命中的 pattern **长度**（长的更具体，赢）→ 注册顺序。
 * `canOpen()` 在排序**之后**逐个问——它一票否决，于是第二名自动顶上。
 *
 * 不给 `address` 时回 `undefined`：没有资源就没有"谁来开"这回事
 * （那时候是人点图标轨，走的是 id）。
 */
export function resolvePanel(scope: PanelOpenScope): PanelTypeDefinition | undefined {
  const address = scope.address
  if (address === undefined) return undefined
  const candidates: { entry: TypeEntry; length: number }[] = []
  for (const entry of types.values()) {
    const patterns = entry.definition.matches ?? []
    let best = -1
    for (const p of patterns) if (matchesAddress(p, address) && p.length > best) best = p.length
    if (best >= 0) candidates.push({ entry, length: best })
  }
  candidates.sort((a, b) => {
    const pa = PRIORITY_RANK[a.entry.definition.priority]
    const pb = PRIORITY_RANK[b.entry.definition.priority]
    if (pa !== pb) return pa - pb
    if (a.length !== b.length) return b.length - a.length
    return a.entry.seq - b.entry.seq
  })
  for (const c of candidates) {
    const canOpen = c.entry.definition.canOpen
    if (canOpen === undefined || canOpen(scope)) return c.entry.definition
  }
  return undefined
}

const cards = new Map<string, RailCardDefinition>()
const cardBodies = new Map<string, RailCardBody>()

/** WP372：声明一张卡（id 重复直接抛，同面板）。 */
export function registerRailCard(definition: RailCardDefinition): Disposer {
  if (cards.has(definition.id)) throw new Error(`右侧面板卡片 id 重复：${definition.id}`)
  cards.set(definition.id, definition)
  return () => {
    if (cards.get(definition.id) === definition) cards.delete(definition.id)
  }
}

/** WP372：给一张卡挂身体（传 `lazy()`：没展开就不下载）。 */
export function registerRailCardBody(id: string, Body: RailCardBody): Disposer {
  if (cardBodies.has(id)) throw new Error(`右侧面板卡片身体重复：${id}`)
  cardBodies.set(id, Body)
  return () => {
    if (cardBodies.get(id) === Body) cardBodies.delete(id)
  }
}

export function railCard(id: string): RailCardDefinition | undefined {
  return cards.get(id)
}

export function railCardBody(id: string): RailCardBody | undefined {
  return cardBodies.get(id)
}

/**
 * 卡的顺序：先按人记住的那一份（`saved`，里面认不出的 id 跳过），没记过的按默认 `order` 接在后面。
 * 新注册的卡（以后加第六张）因此不会因为人拖过一次就永远找不到。
 */
/** WP456-T3：这张卡合进了清单卡吗（决策 1448）。 */
export function isListCard(id: string): boolean {
  return cards.get(id)?.list === true
}

export function listRailCards(saved: readonly string[] = []): RailCardDefinition[] {
  const byOrder = [...cards.values()].sort((a, b) => a.order - b.order)
  const known = saved.filter((id, i) => cards.has(id) && saved.indexOf(id) === i)
  const rest = byOrder.filter((c) => !known.includes(c.id))
  return [...known.map((id) => cards.get(id) as RailCardDefinition), ...rest]
}

export type PinnedItem =
  | { kind: 'card'; card: RailCardDefinition }
  | { kind: 'panel'; panel: PanelTypeDefinition }

/** 右上角露出来的：卡（`pinned`）与不归卡的面板（`pinned`），按数字排。 */
export function pinnedItems(): PinnedItem[] {
  const out: { at: number; item: PinnedItem }[] = []
  for (const card of cards.values())
    if (card.pinned !== undefined) out.push({ at: card.pinned, item: { kind: 'card', card } })
  for (const panel of listPanelTypes())
    if (panel.pinned !== undefined && panel.card === undefined)
      out.push({ at: panel.pinned, item: { kind: 'panel', panel } })
  return out.sort((a, b) => a.at - b.at).map((x) => x.item)
}

/** 「⋮」菜单里的工具：不藏、不归卡、没露在右上角的面板（浏览器、变更审阅、教程…）。 */
export function menuPanels(): PanelTypeDefinition[] {
  return listPanelTypes().filter((p) => p.card === undefined && p.pinned === undefined)
}

/** 只给测试用：把注册表清空（每个用例各自注册自己那几个）。 */
export function resetPanelRegistry(): void {
  types.clear()
  bodies.clear()
  aliases.clear()
  cards.clear()
  cardBodies.clear()
  counter = 0
}
