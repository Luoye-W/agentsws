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
import type { ComponentType } from 'react'
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

/** 只给测试用：把注册表清空（每个用例各自注册自己那几个）。 */
export function resetPanelRegistry(): void {
  types.clear()
  bodies.clear()
  counter = 0
}
