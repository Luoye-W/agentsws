/**
 * WP95（36 §11 C 档第三件）：**薄适配层**——把官方 slot 的形状映射到我们的注册表。
 *
 * 这一层只有形状与映射，**没有任何 `@deepseek-ai/dsh-client-*` 依赖**。
 * 理由是 WP94 spike 实测出来的四条（`docs/upstream/official-rail-spike.md`）：
 *
 * | 实测 | 后果 |
 * |---|---|
 * | ① 官方客户端包**非 ESM**（`window.__ModuleLoader__.load(...)`，整个 `client.js` 一个 `export` 都没有），依赖声明为空 | 引它等于自己当模块加载器，还要替它补十几个没声明的三方包 |
 * | ② 五个新面板里只有浏览器面板不依赖 dsh 宿主；文件改动审阅要常驻 Session 服务，与 17 §5.1「一次运行一棵树、结束即 dispose」冲突 | B 档"官方面板零成本接入"不成立 |
 * | ③ `ui-slots` / `ui-renderer` 一版四条破坏性改动，一条正打在传作用域的接口上 | 真引进来，"兼容性"这笔账反而更贵 |
 * | ④ 官方浏览器面板 iframe 直连目标 URL，与壳 `default-src 'self'`（13 §5）撞死 | **官方浏览器面板不接**；我们自己画（`panels/run-browser-panel.tsx`） |
 *
 * 所以这一层的价值不在"现在能挂官方面板"，在**把接缝画在这儿**：
 * 官方 slot 的三样东西（两段式注册、`priority` 三档、`patterns` + `canOpen`）
 * 我们的注册表逐条对得上，哪天真要接一个官方形状的面板，改的只有这一个文件。
 *
 * 作用域怎么传（spike ③ 的核心发现）：官方 seat 从标准 props 里读一个**叫
 * `sessionId` 的字符串**，`ui-session` 只不过把它填成 dsh 的会话 id——那一格是不透明的，
 * 我们直接填岗位 / 职责的 `scope_id`，官方那一侧一个字都不用改。
 */
import type { LucideIcon } from 'lucide-react'
import { type ComponentType, createElement } from 'react'
import {
  type Disposer,
  type PanelGroup,
  type PanelPriority,
  type RailPanelBodyProps,
  registerPanelBody,
  registerPanelType,
} from '@/components/rail/registry'

/** 官方身体挂的那个 slot 名（`ctx.slots.register({ name, key }, Body)` 的 name）。 */
export const OFFICIAL_TAB_SLOT = 'sidebar.right.pane.tab'

/** 官方 slot 的定位（name + key），key 就是 tab 类型的 `id`。 */
export interface OfficialSlotName {
  name: typeof OFFICIAL_TAB_SLOT
  key: string
}

/**
 * 官方的**第一段**：tab 类型声明（`ctx.sidebarRightTabs.register`）。
 *
 * 字段照抄上游 README 的 `{ id, kind, patterns?, priority?, canOpen?, title, guide? }`。
 * `guide`（指南页上占哪个入口格）我们没有指南页，形留着、不映射。
 */
export interface OfficialTabDefinition {
  id: string
  kind: string
  title: () => string
  priority?: PanelPriority
  /** `dsh-resource://` 上的 glob。 */
  patterns?: readonly string[]
  canOpen?(address: string): boolean
  guide?: { slot?: string }
}

/** 官方身体用 `useTabInfo()` 读到的那三格；我们当 props 递进去。 */
export interface OfficialTabInfo {
  sidebar: string
  panel: string
  tab: string
}

export interface OfficialTabBodyProps {
  tab: OfficialTabInfo
  /**
   * 官方标准 props 里那一格（spike ③）：它只要一个字符串，
   * `ui-session` 填会话 id，我们填**岗位 / 职责的 `scope_id`**。
   */
  sessionId?: string
  /** 这个 tab 开的是哪个资源（官方地址形状，见 {@link toOfficialAddress}）。 */
  address?: string
}

export const OFFICIAL_ADDRESS_PREFIX = 'dsh-resource://'
export const RAIL_ADDRESS_PREFIX = 'agentsws://'

/** `dsh-resource://file/a.md` → `agentsws://file/a.md`（前缀之外一个字不动）。 */
export function toRailAddress(address: string): string {
  return address.startsWith(OFFICIAL_ADDRESS_PREFIX)
    ? RAIL_ADDRESS_PREFIX + address.slice(OFFICIAL_ADDRESS_PREFIX.length)
    : address
}

/** 反过来：递给官方身体的地址仍是它认得的那一种。 */
export function toOfficialAddress(address: string): string {
  return address.startsWith(RAIL_ADDRESS_PREFIX)
    ? OFFICIAL_ADDRESS_PREFIX + address.slice(RAIL_ADDRESS_PREFIX.length)
    : address
}

/** 官方那句 `ctx.slots.register({ name, key }, Body)` 里的第一个参数。 */
export function officialSlotOf(definition: OfficialTabDefinition): OfficialSlotName {
  return { name: OFFICIAL_TAB_SLOT, key: definition.id }
}

/** 我们这一侧多出来、官方声明里没有的那几样（图标轨要画格子，官方靠文案）。 */
export interface OfficialAdapterOptions {
  icon: LucideIcon
  group?: PanelGroup
  /**
   * 第三方面板默认 `extension`（官方也是这一档：extension 在场压过 builtin）。
   * `definition.priority` 给了就以它为准。
   */
  priority?: PanelPriority
}

/**
 * 把一个**官方形状**的面板挂进我们的注册表。回一个 disposer，注销两段。
 *
 * 逐条对应（这张表就是这一层的全部）：
 *
 * | 官方 | 我们 |
 * |---|---|
 * | `register({ id })` | `registerPanelType({ id })` |
 * | `title()` | `label`（官方给函数，我们给已经算好的那句） |
 * | `priority` 三档 | 同名同档 |
 * | `patterns`（`dsh-resource://`） | `matches`（`agentsws://`，前缀换掉） |
 * | `canOpen(address)` | `canOpen({ address })` |
 * | `slots.register({ name: 'sidebar.right.pane.tab', key }, Body)` | `registerPanelBody(id, Body)` |
 * | 标准 props 的 `sessionId` | `scope.scope_id`（spike ③） |
 * | `useTabInfo()` | `props.tab` |
 */
export function adaptOfficialTab(
  definition: OfficialTabDefinition,
  Body: ComponentType<OfficialTabBodyProps>,
  options: OfficialAdapterOptions,
): Disposer {
  const patterns = (definition.patterns ?? []).map(toRailAddress)
  const canOpen = definition.canOpen
  const disposeType = registerPanelType({
    id: definition.id,
    label: definition.title(),
    icon: options.icon,
    priority: definition.priority ?? options.priority ?? 'extension',
    group: options.group ?? 'tools',
    ...(patterns.length === 0 ? {} : { matches: patterns }),
    ...(canOpen === undefined
      ? {}
      : {
          canOpen: (scope: { address?: string }) =>
            scope.address === undefined ? true : canOpen(toOfficialAddress(scope.address)),
        }),
  })
  // `createElement` 而不是 `Body(props)`：把它当函数直接调等于把官方面板的
  // hooks 记到**我们这个组件**头上，第二次渲染顺序一变就是一串莫名其妙的报错
  const Adapted = (props: RailPanelBodyProps) =>
    createElement(Body, {
      tab: { sidebar: 'right', panel: 'main', tab: definition.id },
      ...(props.scope === undefined ? {} : { sessionId: props.scope.scope_id }),
    })
  const disposeBody = registerPanelBody(definition.id, Adapted)
  return () => {
    disposeBody()
    disposeType()
  }
}
