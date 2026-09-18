/**
 * WP95（36 §11，`sidebar-compare` #2 / #4 / #6）：**内置面板走的就是那条公开路**。
 *
 * WP71 那一版把十一个面板写死在图标轨的数组里；这一版它们全部改成
 * `registerPanelType()` + `registerPanelBody()` 两句——与将来任何一个应用包
 * （23）往第三栏塞面板时写的，**逐字相同**。官方点名它的文档预览面板走的是
 * 和第三方一模一样的路（README 里那句"活证据"），这条纪律我们照立：
 * 一旦有了后门，第三方面板就永远是二等公民，而"二等"会体现在它拿不到的能力上。
 *
 * **身体一律 `lazy()`**（#6）：面板的代码在**第一次被打开**之前既不下载也不挂载，
 * 于是"刷新之后恢复布局"这件事不会顺手把上次那个面板的请求也重放一遍。
 * 图标轨照样画得出十三个格子（WP97 加了 Office 预览）——它读的是第一段（类型），那一段是静态的。
 * WP100 给「证据」补了身体，于是还占着位的只剩上组那三个（数据面板 / 运行中 / 定时任务）。
 *
 * **占位面板只注册类型不注册身体**：点开显示"还没做"（`right-rail.tsx` 兜的），
 * 位置先占住——图标轨的位置定了就不该再挪（肌肉记忆）。
 */
import {
  Activity,
  BarChart3,
  BookOpen,
  Brain,
  Clock,
  FileDiff,
  FileSearch,
  FileText,
  FolderOpen,
  Gauge,
  Globe,
  MessagesSquare,
  Sparkles,
} from 'lucide-react'
import { lazy } from 'react'
import { canOpenOfficeFile, FILE_ADDRESS_PATTERN } from '@/components/rail/panels/office/address'
import { parseMatterPath } from '@/components/rail/rail-layout'
import {
  panelType,
  type RailPanelBodyProps,
  registerPanelBody,
  registerPanelType,
} from '@/components/rail/registry'

/**
 * 四个"这一层的设置"面板的身体：形状都是 `{ scope }`，所以包一层就够。
 *
 * `scope` 为空时回 `null` 而不是一句话——"这一页定位不到岗位"那句话由
 * `right-rail.tsx` 统一说（每个面板各说一遍只会四份文案慢慢长歪）。
 */
const MemoryBody = lazy(async () => {
  const m = await import('@/components/rail/panels/memory-panel')
  return {
    default: ({ scope }: RailPanelBodyProps) =>
      scope === undefined ? null : <m.MemoryPanel scope={scope} />,
  }
})

const SkillsBody = lazy(async () => {
  const m = await import('@/components/rail/panels/skills-panel')
  return {
    default: ({ scope }: RailPanelBodyProps) =>
      scope === undefined ? null : <m.SkillsPanel scope={scope} />,
  }
})

const KnowledgeBody = lazy(async () => {
  const m = await import('@/components/rail/panels/knowledge-panel')
  return {
    default: ({ scope }: RailPanelBodyProps) =>
      scope === undefined ? null : <m.KnowledgePanel scope={scope} />,
  }
})

const CapsBody = lazy(async () => {
  const m = await import('@/components/rail/panels/caps-panel')
  return {
    default: ({ scope }: RailPanelBodyProps) =>
      scope === undefined ? null : <m.CapsPanel scope={scope} />,
  }
})

/** 问 AI 是搬进来的已有件；它的边界是"某个事项"，从地址里认。 */
const AskBody = lazy(async () => {
  const m = await import('@/components/deck/ask-ai-panel')
  return {
    default: ({ pathname }: RailPanelBodyProps) => {
      const matter_id = parseMatterPath(pathname)
      return <m.AskAiPanel {...(matter_id === undefined ? {} : { scope: { matter_id } })} />
    },
  }
})

/**
 * WP100 新增：**证据**（36 §9 那张表里的第四格）。
 *
 * 位置从 WP71 起就占着（那时点开显示"还没做"）；这一版把正文挂上来，走的是与
 * 其余十二个面板、以及将来任何一个应用包的面板**逐字相同的两句**——内置不走后门
 * （#4）。身体照旧 `lazy()`：没人点「证据 N」之前它一个字节都不下载。
 */
const EvidenceBody = lazy(async () => {
  const m = await import('@/components/rail/panels/evidence-panel')
  return { default: m.EvidencePanel }
})

/** WP95 新增：运行中的浏览器（#12 借形，我们自己的组件画 WP82 / WP92 的会话）。 */
const RunBrowserBody = lazy(async () => {
  const m = await import('@/components/rail/panels/run-browser-panel')
  return { default: m.RunBrowserPanel }
})

/** WP95 新增：变更审阅（#11，逐文件 diff）。 */
const ChangesBody = lazy(async () => {
  const m = await import('@/components/rail/panels/changes-panel')
  return { default: m.ChangesPanel }
})

/**
 * WP97 新增：Office 预览（#13）。
 *
 * 身体是 `lazy()`，于是 `docx-preview` / `xlsx` / `jszip` 三个库在**有人点开一份
 * 文件之前**一个字节都不下载；`canOpen` 与 `matches` 那一段是静态的（第一段），
 * 判"这个地址归谁开"不需要把库先拉下来——两段式注册要的就是这个（#6）。
 */
const OfficePreviewBody = lazy(async () => {
  const m = await import('@/components/rail/panels/office-preview-panel')
  return { default: m.OfficePreviewPanel }
})

/**
 * 把内置面板注册进注册表（**幂等**）。
 *
 * 幂等而不是"模块加载时跑一次"：单测会 `resetPanelRegistry()` 之后再渲染右栏，
 * 那时模块早就加载过了，副作用式的注册补不回来。
 */
export function ensureBuiltinPanels(): void {
  if (panelType('memory') !== undefined) return

  // ── 上组：这件事的 ───────────────────────────────────────────────
  registerPanelType({
    id: 'data',
    label: 'rail.panel.data',
    icon: BarChart3,
    priority: 'builtin',
    group: 'context',
  })
  registerPanelType({
    id: 'runs',
    label: 'rail.panel.runs',
    icon: Activity,
    priority: 'builtin',
    group: 'context',
  })
  registerPanelType({
    id: 'schedules',
    label: 'rail.panel.schedules',
    icon: Clock,
    priority: 'builtin',
    group: 'context',
  })
  registerPanelType({
    id: 'evidence',
    label: 'rail.panel.evidence',
    icon: FileSearch,
    priority: 'builtin',
    group: 'context',
  })
  registerPanelBody('evidence', EvidenceBody)
  registerPanelType({
    id: 'changes',
    label: 'rail.panel.changes',
    icon: FileDiff,
    priority: 'builtin',
    group: 'context',
    // 变更审阅能"开"的是一件事与一条变更——第一个真用上 `matches` 的面板（#3）
    matches: ['agentsws://matter/**', 'agentsws://change/**'],
  })
  registerPanelBody('changes', ChangesBody)

  // ── 中组：这个岗位或职责的 ───────────────────────────────────────
  registerPanelType({
    id: 'memory',
    label: 'rail.panel.memory',
    icon: Brain,
    priority: 'builtin',
    group: 'layer',
    scoped: true,
  })
  registerPanelBody('memory', MemoryBody)
  registerPanelType({
    id: 'skills',
    label: 'rail.panel.skills',
    icon: Sparkles,
    priority: 'builtin',
    group: 'layer',
    scoped: true,
  })
  registerPanelBody('skills', SkillsBody)
  registerPanelType({
    id: 'knowledge',
    label: 'rail.panel.knowledge',
    icon: BookOpen,
    priority: 'builtin',
    group: 'layer',
    scoped: true,
  })
  registerPanelBody('knowledge', KnowledgeBody)
  registerPanelType({
    id: 'caps',
    label: 'rail.panel.caps',
    icon: Gauge,
    priority: 'builtin',
    group: 'layer',
    scoped: true,
  })
  registerPanelBody('caps', CapsBody)

  // ── 下组：工具 ───────────────────────────────────────────────────
  registerPanelType({
    id: 'browser',
    label: 'rail.panel.browser',
    icon: Globe,
    priority: 'builtin',
    group: 'tools',
  })
  registerPanelBody('browser', RunBrowserBody)
  registerPanelType({
    id: 'files',
    label: 'rail.panel.files',
    icon: FolderOpen,
    priority: 'builtin',
    group: 'tools',
  })
  // WP97（#13）：第一个真被 `resolvePanel()` 挑中的面板——知识库里点一份文件，
  // 地址 `agentsws://file/<源 id>/<文件名>` 交给注册表排序，排到它这儿，
  // `canOpen` 再看一眼扩展名（只认 docx / xlsx / xls / csv / pptx，别的交给下载）
  registerPanelType({
    id: 'office-preview',
    label: 'rail.panel.office',
    icon: FileText,
    priority: 'builtin',
    group: 'tools',
    matches: [FILE_ADDRESS_PATTERN],
    canOpen: canOpenOfficeFile,
  })
  registerPanelBody('office-preview', OfficePreviewBody)
  registerPanelType({
    id: 'ask',
    label: 'rail.panel.ask',
    icon: MessagesSquare,
    priority: 'builtin',
    group: 'tools',
  })
  registerPanelBody('ask', AskBody)
}
