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
 * **WP375（决策 1035）**：右上角不再重复放卡片图标——只放面板里没有的工具（浏览器、变更审阅、教程，`pinned` 排序），
 * 最右「⋮」开关右侧面板、任何卡有红 / 黄点时亮一个汇总点；默认展开「对话」「计划」。
 * **WP412（决策 1035 更正）**：最右换成专门的面板开关（汇总点挂在它上面），「⋮」回到溢出菜单——教程、记忆收进去，
 * 右上角只露浏览器、变更审阅。
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
  Handshake,
  Inbox,
  ListChecks,
  MessageSquareQuote,
  MessagesSquare,
  Newspaper,
  Package,
  Plug,
  Plus,
  ScrollText,
  SlidersHorizontal,
  Tags,
  UserRound,
} from 'lucide-react'
import { lazy } from 'react'
import { registerKeywordBankBlock } from '@/components/amazon/keyword-bank-block'
import { MESSAGE_DIGEST_ADDRESS, MESSAGE_RULES_ADDRESS } from '@/components/messages/rules-address'
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
import { openRightPane } from '@/components/reports/right-pane'
import { reportScopeOf } from '@/components/reports/use-report-list'
import { settingsHref } from '@/components/settings-panel/route'
import { CONNECT_ADDRESS_PREFIX } from '@/components/setup/use-open-connect'
import { useWorkshopServicesStatus } from '@/components/workshop-services/status'
import { AMAZON_KEYWORDS_ADDRESS_PREFIX } from '@/lib/amazon-keywords-api'
import { CONTENT_UPDATES_ADDRESS_PREFIX } from '@/lib/content-digest-api'
import { GEO_ANSWER_ADDRESS_PREFIX } from '@/lib/geo-watch-api'
import { HELP_ADDRESS_PATTERN } from '@/lib/help'
import { SERVICE_ORDER_ADDRESS_PREFIX } from '@/lib/workshop-services-api'

/* ── 面板身体（`lazy()`） ─────────────────────────────────────────── */

const AmazonKeywordsBody = lazy(async () => {
  const m = await import('@/components/rail/panels/amazon-keywords-panel')
  return { default: m.AmazonKeywordsPanel }
})
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
/** WP433：「计划」的完整一格 = 定时任务 + 这一层的进度（「工作」、排期 / 流水线类看板，原在「报表」里）。 */
const SchedulesBody = lazy(async () => {
  const m = await import('@/components/rail/panels/plans-panel')
  return { default: m.PlansPanel }
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
/** WP439：消息页右栏「规则」（你教过的发件人……）。 */
const MessageRulesBody = lazy(async () => {
  const m = await import('@/components/rail/panels/message-rules-panel')
  return { default: m.MessageRulesPanel }
})
/** WP441：消息页右栏「今天的简报」（铃铛「消息简报：今天 N 封」点进来）。 */
const MessageDigestBody = lazy(async () => {
  const m = await import('@/components/rail/panels/message-digest-panel')
  return { default: m.MessageDigestPanel }
})
/** WP459：收件箱点开的那一件（只从收件箱开）。 */
const InboxItemBody = lazy(async () => {
  const m = await import('@/components/inbox/inbox-pane')
  return { default: m.InboxPaneBody }
})
/** WP500：红人详情（候选池点开一个人；只从红人面板开）。 */
const KolCreatorBody = lazy(async () => {
  const m = await import('@/components/kol/creator-pane')
  return { default: m.CreatorPaneBody }
})
/** WP372（决策 1019）：报表——全部 + 看板，与看一份。 */
const ReportsBody = lazy(async () => {
  const m = await import('@/components/reports/reports-panel')
  return { default: m.ReportsPanel }
})
/** int/1024：看一份报表（WP438 整份报表，或「产出」里 AI 写的报告文档）与「做一份报表」——WP437 第三栏里的两格。 */
const ReportBody = lazy(async () => {
  const m = await import('@/components/reports/report-pane-bodies')
  return { default: m.ReportPaneBody }
})
const ReportComposeBody = lazy(async () => {
  const m = await import('@/components/reports/report-pane-bodies')
  return { default: m.ReportComposeBody }
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
const ConnectionsPanelBody = lazy(async () => {
  const m = await import('@/components/rail/cards/card-bodies')
  return { default: m.ConnectionsPanel }
})
// WP390：工坊服务（订单面板、服务列表、右栏那张卡）
/** WP406：岗位更新——卡上「挑着看」开的那一页。 */
const ContentUpdatesBody = lazy(async () => {
  const m = await import('@/components/rail/panels/content-updates-panel')
  return { default: m.ContentUpdatesPanel }
})
const ServiceOrderBody = lazy(async () => {
  const m = await import('@/components/workshop-services/order-panel')
  return { default: m.ServiceOrderPanel }
})
const WorkshopServicesBody = lazy(async () => {
  const m = await import('@/components/workshop-services/services-panel')
  return { default: m.WorkshopServicesPanel }
})
const WorkshopServicesCardBody = lazy(async () => {
  const m = await import('@/components/workshop-services/services-panel')
  return { default: m.WorkshopServicesCard }
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
    panel: 'conversations',
    useStatus: useConversationsStatus,
    // WP456-T3（§3.9）：「+ 新对话」从卡里那一行挪到卡头右边（展开卡、开新对话那一格）
    action: { icon: Plus, label: 'conv.new', intent: 'compose' },
  })
  registerRailCardBody('conversations', ConversationsCardBody)
  registerRailCard({
    id: 'reports',
    label: 'rail.card.reports',
    icon: ScrollText,
    order: at('reports'),
    panel: 'reports',
    useStatus: useReportsStatus,
    // WP438：卡头「+」= 跟 AI 说想看什么，做一份新的（第三栏开「做一份报表」）
    action: {
      icon: Plus,
      label: 'reports.compose.short',
      onClick: ({ scope }) => {
        const where = reportScopeOf(scope)
        openRightPane({
          kind: 'report-compose',
          ...(where === undefined ? {} : { position: where.position }),
          ...(where?.duty === undefined ? {} : { duty: where.duty }),
        })
      },
    },
  })
  registerRailCardBody('reports', ReportsCardBody)
  registerRailCard({
    id: 'outputs',
    label: 'rail.card.outputs',
    icon: Package,
    order: at('outputs'),
    panel: 'outputs',
    useStatus: useOutputsStatus,
    // WP456-T3（决策 1448）：产出 / 连接 / 设定 / 工坊服务合成一张清单卡
    list: true,
  })
  registerRailCardBody('outputs', OutputsCardBody)
  registerRailCard({
    id: 'plans',
    label: 'rail.card.plans',
    icon: CalendarClock,
    order: at('plans'),
    panel: 'schedules',
    useStatus: usePlansStatus,
  })
  registerRailCardBody('plans', PlansCardBody)
  registerRailCard({
    id: 'connections',
    label: 'rail.card.connections',
    icon: Plug,
    order: at('connections'),
    // WP456-T3：清单卡那一行点了在第三栏开连接的完整一格（原来的卡身体 + 连接卡就地连）
    panel: 'connections',
    moreHref: settingsHref('connections'),
    useStatus: useConnectionsStatus,
    list: true,
  })
  registerRailCardBody('connections', ConnectionsCardBody)
  registerRailCard({
    id: 'settings',
    label: 'rail.card.settings',
    icon: SlidersHorizontal,
    order: at('settings'),
    panel: 'settings',
    useStatus: useSettingsStatus,
    list: true,
  })
  registerRailCardBody('settings', SettingsCardBody)
  // WP390（docs/105 §4.1 ③）：第七张卡「工坊服务」排在最下面——岗位页 = 这个岗位能用的服务（最多三项）+ 在做的单
  registerRailCard({
    id: 'workshop-services',
    label: 'rail.card.workshop-services',
    icon: Handshake,
    order: DEFAULT_CARD_ORDER.length + 1,
    panel: 'workshop-services',
    useStatus: useWorkshopServicesStatus,
    list: true,
  })
  registerRailCardBody('workshop-services', WorkshopServicesCardBody)

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
  /*
   * 看一份报表（只按地址开：报表卡上点一行、首页关键数字、对话里的小报表、「产出」里的报告文档）。
   * int/1024：不标 scoped——WP438 的报表按 id 取、不靠岗位，首页（定位不到岗位）点关键数字也要开得出来。
   */
  registerPanelType({
    id: 'report',
    label: 'rail.panel.report',
    icon: ScrollText,
    priority: 'builtin',
    group: 'layer',
    matches: [`${REPORT_ADDRESS_PREFIX}**`],
    hidden: true,
  })
  registerPanelBody('report', ReportBody)
  // WP437 / WP438：「跟 AI 说想看什么 → 做一份报表」那一格（`openRightPane({ kind: 'report-compose' })`）
  registerPanelType({
    id: 'report-compose',
    label: 'rail.panel.report_compose',
    icon: ScrollText,
    priority: 'builtin',
    group: 'layer',
    hidden: true,
  })
  registerPanelBody('report-compose', ReportComposeBody)
  // WP459（决策 1497）：收件箱点开一件——回信卡（原信 + 草稿 + 通过 / 改 / 不要）、岗位那张卡、要你判断的信、
  // AI 猜着交给岗位的（改判）。只从收件箱开（`openRightPane({ kind: 'panel', id: 'inbox-item' })`）。
  registerPanelType({
    id: 'inbox-item',
    label: 'rail.panel.inbox_item',
    icon: Inbox,
    priority: 'builtin',
    group: 'layer',
    hidden: true,
  })
  registerPanelBody('inbox-item', InboxItemBody)
  // WP500（决策 1758）：红人详情——候选池点开一个人（KOLAgents 的侧边详情，照 WP481 开在第三栏）。
  // 只从红人面板开（`openCreatorPane`），不上图标轨。
  registerPanelType({
    id: 'kol-creator',
    label: 'rail.panel.kol_creator',
    icon: UserRound,
    priority: 'builtin',
    group: 'context',
    hidden: true,
  })
  registerPanelBody('kol-creator', KolCreatorBody)
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
    // WP433：这一格现在是「计划」整格（定时任务 + 进度），标题跟卡同名
    label: 'rail.card.plans',
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
  // WP456-T3（决策 1448）：「连接」合进清单卡后，它的完整一格（第三栏）——原来卡里那几行 + 连接卡就地连
  registerPanelType({
    id: 'connections',
    label: 'rail.card.connections',
    icon: Plug,
    priority: 'builtin',
    group: 'layer',
    scoped: true,
    card: 'connections',
  })
  registerPanelBody('connections', ConnectionsPanelBody)
  // WP324（决策 690）：连接卡——「去连接」开的；WP372 起展开「连接」卡、在那张卡里就地连；
  // WP456-T3：「连接」进了清单卡，改成在第三栏开「连接」那一格、连接卡在顶上就地连
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
  registerUnbuilt({
    id: 'data',
    label: 'rail.panel.data',
    icon: BarChart3,
    priority: 'builtin',
    pinned: 4,
  })
  registerUnbuilt({
    id: 'runs',
    label: 'rail.panel.runs',
    icon: Activity,
    priority: 'builtin',
    pinned: 5,
  })
  registerPanelType({
    id: 'browser',
    label: 'rail.panel.browser',
    icon: Globe,
    priority: 'builtin',
    group: 'tools',
    pinned: 1,
  })
  registerPanelBody('browser', RunBrowserBody)
  registerPanelType({
    id: 'changes',
    label: 'rail.panel.changes',
    icon: FileDiff,
    priority: 'builtin',
    group: 'context',
    pinned: 2,
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
    // WP412（决策 1035 更正）：教程不常用，收进「⋮」（不再露在右上角）
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
  // WP390：一张工坊服务订单（`agentsws://service-order/<订单号>`）——进度、在等你的事、消息、钱
  registerPanelType({
    id: 'service-order',
    label: 'rail.panel.service-order',
    icon: Handshake,
    priority: 'builtin',
    group: 'context',
    matches: [`${SERVICE_ORDER_ADDRESS_PREFIX}**`],
    hidden: true,
  })
  registerPanelBody('service-order', ServiceOrderBody)
  // WP406（私有 docs/107 §5）：岗位更新卡上「挑着看」——按地址开（在哪一页都开得到），设定里岗位层另有一个标签
  registerPanelType({
    id: 'content-updates',
    label: 'rail.panel.content-updates',
    icon: SlidersHorizontal,
    priority: 'builtin',
    group: 'context',
    matches: [`${CONTENT_UPDATES_ADDRESS_PREFIX}**`],
    hidden: true,
  })
  registerPanelBody('content-updates', ContentUpdatesBody)
  // 「设定」里岗位层那个标签的别名（`show('updates')` 落到设定面板的那个标签）
  registerPanelAlias({ id: 'updates', panel: 'settings', sub: 'updates' })
  // WP390：账号菜单「工坊服务」那一页（我的订单 + 全部服务，按岗位分组）
  registerPanelType({
    id: 'workshop-services',
    label: 'rail.panel.workshop-services',
    icon: Handshake,
    priority: 'builtin',
    group: 'tools',
    card: 'workshop-services',
    hidden: true,
  })
  registerPanelBody('workshop-services', WorkshopServicesBody)
  // WP398：Amazon 词表——对话里「帮我看看关键词」、岗位页「词库」块的「看词表」在第三栏开
  registerPanelType({
    id: 'amazon-keywords',
    label: 'rail.panel.amazon-keywords',
    icon: Tags,
    priority: 'builtin',
    group: 'context',
    matches: [`${AMAZON_KEYWORDS_ADDRESS_PREFIX}**`],
    hidden: true,
  })
  registerPanelBody('amazon-keywords', AmazonKeywordsBody)
  // WP439（docs/108 §5.1.5）：消息页「你教过它」的「共 N 条 →」、消息页右上那颗、铃铛里「X 删了发件人规则」都开它
  registerPanelType({
    id: 'message-rules',
    label: 'rail.panel.message-rules',
    icon: ListChecks,
    priority: 'builtin',
    group: 'context',
    matches: [MESSAGE_RULES_ADDRESS],
    hidden: true,
  })
  registerPanelBody('message-rules', MessageRulesBody)
  // WP441（docs/108 §5.6）：今天的简报——按规则分组、每封一行摘要、「全部知道了」
  registerPanelType({
    id: 'message-digest',
    label: 'rail.panel.message-digest',
    icon: Newspaper,
    priority: 'builtin',
    group: 'context',
    matches: [MESSAGE_DIGEST_ADDRESS],
    hidden: true,
  })
  registerPanelBody('message-digest', MessageDigestBody)
  // WP398：岗位页「词库」块（WP395 的面板留的那一块）
  registerKeywordBankBlock()
}
