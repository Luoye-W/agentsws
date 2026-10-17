/**
 * WP95（36 §11，`sidebar-compare` #2 / #4 / #6）：**内置面板走的就是那条公开路**。
 *
 * WP71 那一版把十一个面板写死在图标轨的数组里；这一版它们全部改成
 * `registerPanelType()` + `registerPanelBody()` 两句——与将来任何一个应用包
 * （23）往第三栏塞面板时写的，**逐字相同**。内置不走后门：一旦有了后门，
 * 第三方面板就永远是二等公民，而"二等"会体现在它拿不到的能力上。
 *
 * **身体一律 `lazy()`**（#6）：面板与卡的代码在**第一次被打开 / 展开**之前既不下载也不挂载。
 *
 * **WP208（Luoye 09-30）**：五个「这一层的设置」合成一个「设定」（旧 id 留作别名）。
 *
 * **WP372（决策 1001 / 1004 / 1005 / 1019，Luoye 10-17）**：右侧面板改成**六张卡**——
 * 对话、报表、产出、计划、连接、设定（`registerRailCard`，默认这个顺序，人可以拖）。
 * 窗口右上角那一排是这六张卡各一个图标；浏览器、变更审阅、教程进最右的「⋮」。
 * 「记录 / 发出记录 / 证据」合成「产出」面板的三个标签（旧 id 留作别名），「定时任务」= 计划的完整列表，
 * 连接卡（决策 690）按地址开时展开「连接」那张卡并滚到那一条。
 *
 * **占位面板只注册类型不注册身体**，内测期间整组藏着（{@link SHOW_UNBUILT_PANELS}）。
 */
import {
  Activity,
  BarChart3,
  CalendarClock,
  FileDiff,
  FileText,
  FolderOpen,
  Globe,
  GraduationCap,
  MessageSquareQuote,
  MessagesSquare,
  Package,
  Plug,
  ScrollText,
  SlidersHorizontal,
} from 'lucide-react'
import { lazy } from 'react'
import {
  useConnectionsStatus,
  useConversationsStatus,
  useOutputsStatus,
  usePlansStatus,
  useReportsStatus,
  useSettingsStatus,
} from '@/components/rail/card-status'
import { useOutboundBadge } from '@/components/rail/outbound-count'
import { canOpenOfficeFile, FILE_ADDRESS_PATTERN } from '@/components/rail/panels/office/address'
import {
  panelType,
  registerPanelAlias,
  registerPanelBody,
  registerPanelType,
  registerRailCard,
  registerRailCardBody,
} from '@/components/rail/registry'
import { useSchedulesBadge } from '@/components/rail/schedule-count'
import { REPORT_ADDRESS_PREFIX } from '@/components/reports/report-data'
import { settingsHref } from '@/components/settings-panel/route'
import { CONNECT_ADDRESS_PREFIX } from '@/components/setup/use-open-connect'
import { GEO_ANSWER_ADDRESS_PREFIX } from '@/lib/geo-watch-api'
import { HELP_ADDRESS_PATTERN } from '@/lib/help'

/* ── 面板身体（`lazy()`） ─────────────────────────────────────────── */

const GeoAnswerBody = lazy(async () => {
  const m = await import('@/components/rail/panels/geo-answer-panel')
  return { default: m.GeoAnswerPanel }
})
const ConnectBody = lazy(async () => {
  const m = await import('@/components/rail/panels/connect-panel')
  return { default: m.ConnectPanel }
})
const SettingsBody = lazy(async () => {
  const m = await import('@/components/rail/panels/settings-panel')
  return { default: m.SettingsPanel }
})
/** WP372：产出 = 记录 / 发出记录 / 证据三个标签（原来是三个图标）。 */
const OutputsBody = lazy(async () => {
  const m = await import('@/components/rail/panels/outputs-panel')
  return { default: m.OutputsPanel }
})
const SchedulesBody = lazy(async () => {
  const m = await import('@/components/rail/panels/schedules-panel')
  return { default: m.SchedulesPanel }
})
const RunBrowserBody = lazy(async () => {
  const m = await import('@/components/rail/panels/run-browser-panel')
  return { default: m.RunBrowserPanel }
})
const ChangesBody = lazy(async () => {
  const m = await import('@/components/rail/panels/changes-panel')
  return { default: m.ChangesPanel }
})
const HelpBodyPanel = lazy(async () => {
  const m = await import('@/components/rail/panels/help-panel')
  return { default: m.HelpPanel }
})
const OfficePreviewBody = lazy(async () => {
  const m = await import('@/components/rail/panels/office-preview-panel')
  return { default: m.OfficePreviewPanel }
})
/** WP372：对话的完整列表（可搜、分组）。 */
const ConversationsBody = lazy(async () => {
  const m = await import('@/components/conversations/conversations-panel')
  return { default: m.ConversationsPanel }
})
/** WP372（决策 1019）：报表——全部 + 看板，与看一份。 */
const ReportsBody = lazy(async () => {
  const m = await import('@/components/reports/reports-panel')
  return { default: m.ReportsPanel }
})
const ReportBody = lazy(async () => {
  const m = await import('@/components/reports/reports-panel')
  return { default: m.ReportPanel }
})

/* ── 卡身体（`lazy()`：卡收着时不下载） ──────────────────────────────── */

const ConversationsCardBody = lazy(async () => {
  const m = await import('@/components/conversations/conversations-panel')
  return { default: m.ConversationsCard }
})
const ReportsCardBody = lazy(async () => {
  const m = await import('@/components/rail/cards/card-bodies')
  return { default: m.ReportsCard }
})
const OutputsCardBody = lazy(async () => {
  const m = await import('@/components/rail/cards/card-bodies')
  return { default: m.OutputsCard }
})
const PlansCardBody = lazy(async () => {
  const m = await import('@/components/rail/cards/card-bodies')
  return { default: m.PlansCard }
})
const ConnectionsCardBody = lazy(async () => {
  const m = await import('@/components/rail/cards/card-bodies')
  return { default: m.ConnectionsCard }
})
const SettingsCardBody = lazy(async () => {
  const m = await import('@/components/rail/cards/card-bodies')
  return { default: m.SettingsCard }
})

/**
 * WP140：**内测期间把还没做的占位面板藏起来**。代码不删，做好一个就把它的 id 从
 * {@link UNBUILT_PANELS} 里删掉，或者整组放出来就把它改成 `true`。
 */
export const SHOW_UNBUILT_PANELS = false

/** 还只有类型、没有身体的那几个（数据面板 / 运行中 / 文件）。 */
export const UNBUILT_PANELS: readonly string[] = ['data', 'runs', 'files']

/**
 * WP372：六张卡的默认顺序（决策 1019：对话、报表、产出、计划、连接、设定）。
 * 右上角露出来的也是这六个、同一个顺序。
 */
export const DEFAULT_CARD_ORDER: readonly string[] = [
  'conversations',
  'reports',
  'outputs',
  'plans',
  'connections',
  'settings',
]

/**
 * 把内置面板与卡注册进注册表（**幂等**）。
 *
 * 幂等而不是"模块加载时跑一次"：单测会 `resetPanelRegistry()` 之后再渲染右栏，
 * 那时模块早就加载过了，副作用式的注册补不回来。
 */
export function ensureBuiltinPanels(options: { showUnbuilt?: boolean } = {}): void {
  if (panelType('settings') !== undefined) return
  const showUnbuilt = options.showUnbuilt ?? SHOW_UNBUILT_PANELS
  const registerUnbuilt = (definition: Parameters<typeof registerPanelType>[0]): void => {
    if (showUnbuilt || !UNBUILT_PANELS.includes(definition.id)) registerPanelType(definition)
  }

  // ── 六张卡（决策 1004 / 1019） ───────────────────────────────────
  const at = (id: string): number => DEFAULT_CARD_ORDER.indexOf(id) + 1
  registerRailCard({
    id: 'conversations',
    label: 'rail.card.conversations',
    icon: MessagesSquare,
    order: at('conversations'),
    pinned: at('conversations'),
    panel: 'conversations',
    useStatus: useConversationsStatus,
  })
  registerRailCardBody('conversations', ConversationsCardBody)
  registerRailCard({
    id: 'reports',
    label: 'rail.card.reports',
    icon: ScrollText,
    order: at('reports'),
    pinned: at('reports'),
    panel: 'reports',
    useStatus: useReportsStatus,
  })
  registerRailCardBody('reports', ReportsCardBody)
  registerRailCard({
    id: 'outputs',
    label: 'rail.card.outputs',
    icon: Package,
    order: at('outputs'),
    pinned: at('outputs'),
    panel: 'outputs',
    useStatus: useOutputsStatus,
  })
  registerRailCardBody('outputs', OutputsCardBody)
  registerRailCard({
    id: 'plans',
    label: 'rail.card.plans',
    icon: CalendarClock,
    order: at('plans'),
    pinned: at('plans'),
    panel: 'schedules',
    useStatus: usePlansStatus,
  })
  registerRailCardBody('plans', PlansCardBody)
  registerRailCard({
    id: 'connections',
    label: 'rail.card.connections',
    icon: Plug,
    order: at('connections'),
    pinned: at('connections'),
    moreHref: settingsHref('connections'),
    useStatus: useConnectionsStatus,
  })
  registerRailCardBody('connections', ConnectionsCardBody)
  registerRailCard({
    id: 'settings',
    label: 'rail.card.settings',
    icon: SlidersHorizontal,
    order: at('settings'),
    pinned: at('settings'),
    panel: 'settings',
    useStatus: useSettingsStatus,
  })
  registerRailCardBody('settings', SettingsCardBody)

  // ── 卡的完整列表（「显示更多」开的那一格；不进「⋮」） ─────────────────
  registerPanelType({
    id: 'conversations',
    label: 'rail.panel.conversations',
    icon: MessagesSquare,
    priority: 'builtin',
    group: 'layer',
    scoped: true,
    card: 'conversations',
  })
  registerPanelBody('conversations', ConversationsBody)
  registerPanelType({
    id: 'reports',
    label: 'rail.panel.reports',
    icon: ScrollText,
    priority: 'builtin',
    group: 'layer',
    scoped: true,
    card: 'reports',
  })
  registerPanelBody('reports', ReportsBody)
  // 看一份报表（只按地址开：报表卡上点一行）
  registerPanelType({
    id: 'report',
    label: 'rail.panel.report',
    icon: ScrollText,
    priority: 'builtin',
    group: 'layer',
    scoped: true,
    matches: [`${REPORT_ADDRESS_PREFIX}**`],
    hidden: true,
  })
  registerPanelBody('report', ReportBody)
  registerPanelType({
    id: 'outputs',
    label: 'rail.panel.outputs',
    icon: Package,
    priority: 'builtin',
    group: 'layer',
    // 不标 scoped：「证据」看的是被点的那张卡，不跟层走；记录 / 发出记录没定位到岗位时自己照实说
    card: 'outputs',
    useBadge: useOutboundBadge,
  })
  registerPanelBody('outputs', OutputsBody)
  // 旧 id：记录 / 发出记录 / 证据 → 产出的三个标签（岗位页 `?tab=records`、卡上「证据 N」照旧开得到）
  for (const sub of ['records', 'outbound', 'evidence'])
    registerPanelAlias({ id: sub, panel: 'outputs', sub })
  registerPanelType({
    id: 'schedules',
    label: 'rail.panel.schedules',
    icon: CalendarClock,
    priority: 'builtin',
    group: 'layer',
    card: 'plans',
    useBadge: useSchedulesBadge,
  })
  registerPanelBody('schedules', SchedulesBody)
  registerPanelType({
    id: 'settings',
    label: 'rail.panel.settings',
    hint: 'rail.panel.settings.hint',
    icon: SlidersHorizontal,
    priority: 'builtin',
    group: 'layer',
    scoped: true,
    card: 'settings',
  })
  registerPanelBody('settings', SettingsBody)
  // WP335：「关注设置」（只在「内容与搜索」职责层出那个标签）也落在「设定」里
  for (const sub of ['role', 'memory', 'knowledge', 'skills', 'caps', 'geo-watch'])
    registerPanelAlias({ id: sub, panel: 'settings', sub })
  // WP324（决策 690）：连接卡——「去连接」开的；WP372 起展开「连接」卡、在那张卡里就地连
  registerPanelType({
    id: 'connect',
    label: 'rail.panel.connect',
    icon: Plug,
    priority: 'builtin',
    group: 'context',
    matches: [`${CONNECT_ADDRESS_PREFIX}**`],
    hidden: true,
    card: 'connections',
  })
  registerPanelBody('connect', ConnectBody)

  // ── 「⋮」里的工具（不成卡的） ──────────────────────────────────────
  registerUnbuilt({ id: 'data', label: 'rail.panel.data', icon: BarChart3, priority: 'builtin' })
  registerUnbuilt({ id: 'runs', label: 'rail.panel.runs', icon: Activity, priority: 'builtin' })
  registerPanelType({
    id: 'browser',
    label: 'rail.panel.browser',
    icon: Globe,
    priority: 'builtin',
    group: 'tools',
  })
  registerPanelBody('browser', RunBrowserBody)
  registerPanelType({
    id: 'changes',
    label: 'rail.panel.changes',
    icon: FileDiff,
    priority: 'builtin',
    group: 'context',
    matches: ['agentsws://matter/**', 'agentsws://change/**'],
  })
  registerPanelBody('changes', ChangesBody)
  registerUnbuilt({
    id: 'files',
    label: 'rail.panel.files',
    icon: FolderOpen,
    priority: 'builtin',
    group: 'tools',
    card: 'outputs',
  })
  registerPanelType({
    id: 'help',
    label: 'rail.panel.help',
    icon: GraduationCap,
    priority: 'builtin',
    group: 'tools',
    matches: [HELP_ADDRESS_PATTERN],
  })
  registerPanelBody('help', HelpBodyPanel)

  // ── 只按地址开的（不进「⋮」） ───────────────────────────────────────
  // WP97（#13）：知识库里点一份文件，`canOpen` 再看一眼扩展名（docx / xlsx / xls / csv / pptx）
  registerPanelType({
    id: 'office-preview',
    label: 'rail.panel.office',
    icon: FileText,
    priority: 'builtin',
    group: 'tools',
    matches: [FILE_ADDRESS_PATTERN],
    canOpen: canOpenOfficeFile,
    hidden: true,
  })
  registerPanelBody('office-preview', OfficePreviewBody)
  // WP335：一条 AI 回答——看板方格点一格在第三栏开
  registerPanelType({
    id: 'geo-answer',
    label: 'rail.panel.geo-answer',
    icon: MessageSquareQuote,
    priority: 'builtin',
    group: 'context',
    matches: [`${GEO_ANSWER_ADDRESS_PREFIX}**`],
    hidden: true,
  })
  registerPanelBody('geo-answer', GeoAnswerBody)
}
