/**
 * WP356（决策 923）：设置弹窗的目录——五组、每一节、每一项（标题 + 一句白话 + 出现规则 + 画什么）。
 *
 * **一份清单三处用**：弹窗左栏与右边内容、弹窗顶上的搜索、⌘K 的「设置」一组。加一项设置只在这里加一行，
 * 三处一起有。每一项画的都是原来那个件（模型、浏览器、连接页……一个没重写），这里只管放在哪、叫什么。
 *
 * 出现规则（`show`）只看已知的东西：模式、是不是所有者、当前岗位、有没有网站在线客服、是不是桌面端。
 * 件自己问不到数据时照旧整块不出（老服务进程）——那时这一项在弹窗里就是空的，不报错。
 */
import { useQuery } from '@tanstack/react-query'
import {
  Bell,
  Bot,
  Brain,
  Building2,
  Cable,
  ClipboardList,
  Cog,
  Contact,
  Database,
  Globe,
  HardDrive,
  Keyboard,
  Layers,
  type LucideIcon,
  MessageSquare,
  Monitor,
  Palette,
  Plug,
  Puzzle,
  Shield,
  SlidersHorizontal,
  Sparkles,
  Stethoscope,
  Timer,
  UserPlus,
  UserRound,
  Users,
  Wallet,
  Wrench,
} from 'lucide-react'
import type { ReactNode } from 'react'
import { BrowserExtensionSection } from '@/components/connections/browser-extension'
import { DataBackend } from '@/components/connections/data-backend'
import { ReadRoutesSection } from '@/components/connections/read-routes'
import { SearchDataSection } from '@/components/connections/search-data'
import { useConnectAs } from '@/components/connections/use-connect-as'
import { DataMapPanel } from '@/components/data-map'
import { useHoldsSiteChat } from '@/components/messages/site-chat'
import { ModelsPanel } from '@/components/models/models-panel'
import { NotificationPrefsCard } from '@/components/notifications/notification-prefs'
import { BrandAssetsCard } from '@/components/org/brand-assets-card'
import { BrandDesignCard } from '@/components/org/brand-design-card'
import { GrossMarginCard } from '@/components/org/gross-margin-card'
import { SceneSwitcher } from '@/components/scene-switcher'
import { ArchiveSetting, HandoffDaysSetting } from '@/components/settings/archive-setting'
import { AutoMemorySetting } from '@/components/settings/auto-memory-setting'
import { BackgroundCard } from '@/components/settings/background-card'
import { BrandProfileSettings } from '@/components/settings/brand-profile-settings'
import { BrowserCard } from '@/components/settings/browser-card'
import { CloudAccountCard } from '@/components/settings/cloud-account'
import { ComputerUseCard } from '@/components/settings/computer-use-card'
import { ContentUpdatesSetting } from '@/components/settings/content-updates-setting'
import { CreditsPanel } from '@/components/settings/credits-panel'
import { DiagnosticsCard } from '@/components/settings/diagnostics-card'
import { ImageHostsSetting } from '@/components/settings/image-hosts-setting'
import { OfficialPluginsPanel } from '@/components/settings/official-plugins'
import { PeopleUsage } from '@/components/settings/people-usage'
import { RunLimitsSetting } from '@/components/settings/run-limits-setting'
import { TelemetrySetting } from '@/components/settings/telemetry-setting'
import { WeeklyReportsCard } from '@/components/settings/weekly-reports-card'
import { WeeklyReviewCard } from '@/components/settings/weekly-review-card'
import { WorkHoursSetting } from '@/components/settings/work-hours-setting'
import { ensureSession } from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { type UsageMode, useMode } from '@/lib/mode'
import { ConnectionsPage } from '@/pages/connections'
import { ImChannelsPage } from '@/pages/im-channels'
import { OrgPage } from '@/pages/org'
import type { SettingsGroupId, SettingsSectionId } from './route'
import {
  AppUpdateRow,
  IdentityRow,
  LanguageRow,
  LaunchAtLoginRow,
  launchAtLoginBridge,
  MotionRow,
  OrgSummaryRow,
  ShortcutsList,
  ThemeRow,
  TrayRow,
  UsageModeRow,
} from './rows'

/** 出现规则要看的那几样（一次算好，弹窗、搜索、⌘K 共用）。 */
export interface SettingsCtx {
  mode: UsageMode
  solo: boolean
  /** 组织读到了没有：没读到之前团队组先不出（免得个人用户看见它闪一下）。 */
  known: boolean
  /** 所有者那条分配（模型、浏览器、插件……这一档权限）。 */
  ownerId: string | undefined
  /** 连接用哪条分配（② 里同事用自己的）。 */
  connectAs: string | undefined
  /** 左栏当前岗位（数据地图按它裁）。 */
  position: string | null
  holdsSiteChat: boolean
  /** 在桌面壳里（有 `window.agentsws`）。 */
  desktop: boolean
  /** WP361：桌面壳的桥上有「开机自启」（旧壳没有就不出那个开关）。 */
  launchAtLogin: boolean
  brandName: string | undefined
}

export function useSettingsCtx(): SettingsCtx {
  const { position } = useApp()
  const { mode, solo, known } = useMode()
  const { ownerId, asId } = useConnectAs()
  const holdsSiteChat = useHoldsSiteChat()
  /*
   * 只读缓存里的会话（App 早就取过了）：这里不能自己去取——⌘K 面板在「会话取不回来」的整页错误里
   * 也挂着，一取就把那条查询打回「加载中」，整页在错误 / 加载之间来回跳。
   */
  const session = useQuery({ queryKey: ['session'], queryFn: ensureSession, enabled: false })
  const w = globalThis.window as unknown as { agentsws?: unknown } | undefined
  return {
    mode,
    solo,
    known,
    ownerId,
    connectAs: asId,
    position,
    holdsSiteChat,
    desktop: w?.agentsws !== undefined,
    launchAtLogin: launchAtLoginBridge() !== undefined,
    brandName: session.data?.workspace.name,
  }
}

export interface SettingItemDef {
  /** 全弹窗唯一；地址 `#<id>`、搜索命中都按它定位。 */
  id: string
  /** 词条 key；`modeTitle` 为真时走按模式换词的 `t`（「公司档案 / 品牌档案」那类）。 */
  /** 词条 key（或按模式挑一个）；`modeTitle` 为真时走按模式换词的 `t`（「公司档案 / 品牌档案」那类）。 */
  title: string | ((c: SettingsCtx) => string)
  modeTitle?: true
  desc: string
  /** 件自己没有标题（例：网站聊天窗那块）时，在它上面画「标题 + 一句白话」。 */
  heading?: true
  /** 搜索时多认的几个说法（中英都放，空格隔开）。 */
  keywords?: string
  show?: (c: SettingsCtx) => boolean
  render: (c: SettingsCtx) => ReactNode
}

export interface SettingSectionDef {
  id: SettingsSectionId
  group: SettingsGroupId
  title: string | ((c: SettingsCtx) => string)
  icon: LucideIcon
  show?: (c: SettingsCtx) => boolean
  items: readonly SettingItemDef[]
}

export const SETTINGS_GROUPS: readonly SettingsGroupId[] = ['you', 'ai', 'brand', 'device', 'team']

const owner = (c: SettingsCtx): boolean => c.ownerId !== undefined
const as = (c: SettingsCtx): string => c.ownerId ?? ''
const notSolo = (c: SettingsCtx): boolean => c.known && !c.solo
const company = (c: SettingsCtx): boolean => c.known && c.mode === 'company'

export const SETTINGS_SECTION_DEFS: readonly SettingSectionDef[] = [
  // ── 个人 ─────────────────────────────────────────────
  {
    id: 'general',
    group: 'you',
    title: 'sp.general',
    icon: SlidersHorizontal,
    items: [
      {
        id: 'theme',
        title: 'settings.theme',
        desc: 'sp.theme.desc',
        keywords: '深色 浅色 暗色 dark light',
        render: () => <ThemeRow />,
      },
      {
        id: 'language',
        title: 'settings.lang',
        desc: 'sp.lang.desc',
        keywords: '中文 英文 English language',
        render: () => <LanguageRow />,
      },
      {
        id: 'motion',
        title: 'settings.motion',
        desc: 'sp.motion.desc',
        keywords: '动画 animation',
        render: () => <MotionRow />,
      },
      {
        // WP474（决策 1530）：只影响「帮我排进空档」的候选
        id: 'work-hours',
        title: 'sp.work_hours',
        desc: 'sp.work_hours.desc',
        keywords: '作息 工作时间 上班 下班 周末 直播 午饭 午休 空档 排期 hours',
        render: () => <WorkHoursSetting />,
      },
      {
        // WP426：版本与更新挪到「通用」——网页里也看得到版本（服务端报的）；桌面壳里能检查更新
        id: 'app-update',
        title: 'sp.app_update',
        desc: 'sp.app_update.desc',
        keywords: '版本 升级 更新 检查更新 version update',
        render: () => <AppUpdateRow />,
      },
    ],
  },
  {
    id: 'account',
    group: 'you',
    title: 'sp.account',
    icon: Wallet,
    items: [
      {
        id: 'identity',
        title: 'sp.identity',
        desc: 'sp.identity.desc',
        render: () => <IdentityRow />,
      },
      {
        id: 'workshop-account',
        title: 'sp.workshop_account',
        desc: 'sp.workshop_account.desc',
        keywords: '登录 注册 关联 云 login',
        render: (c) => (
          <CloudAccountCard {...(c.ownerId === undefined ? {} : { assignment: c.ownerId })} />
        ),
      },
      {
        id: 'credits',
        title: 'credits.title',
        desc: 'sp.credits.desc',
        keywords: '余额 充值 用量 账单 billing top up',
        render: () => <CreditsPanel />,
      },
    ],
  },
  {
    id: 'mode',
    group: 'you',
    title: 'sp.mode',
    icon: Users,
    items: [
      {
        // WP426：三张可选卡；①「和同事一起用」那一块（邀请、局域网）在卡下面就地展开
        id: 'usage-mode',
        title: 'sp.mode',
        desc: 'sp.mode.desc',
        keywords: '个人 同事 公司 模式 使用方式 一起用 邀请 局域网 团队 mode team invite',
        render: () => <UsageModeRow />,
      },
      {
        id: 'company',
        title: 'sp.company',
        desc: 'sp.company.desc',
        keywords: '公司模式 公司全称',
        show: notSolo,
        render: () => <OrgSummaryRow />,
      },
    ],
  },
  {
    id: 'notifications',
    group: 'you',
    title: 'sp.notifications',
    icon: Bell,
    items: [
      {
        // WP429：每类通知「站内 / 系统」两个开关
        id: 'notify-prefs',
        title: 'notify.prefs.title',
        desc: 'sp.notify_prefs.desc',
        keywords: '通知 铃铛 系统通知 弹窗 提醒 notification',
        render: () => <NotificationPrefsCard />,
      },
      {
        id: 'weekly-review',
        title: 'settings.weekly_review',
        desc: 'sp.weekly_review.desc',
        keywords: '周报 每周 推送',
        show: owner,
        render: (c) => <WeeklyReviewCard assignment={as(c)} />,
      },
      {
        // WP388：周复盘、SEO 周报每周几点出（本人在这个品牌里的那几条；一条都没有整张不出）
        id: 'weekly-reports',
        title: 'settings.weekly_reports',
        desc: 'sp.weekly_reports.desc',
        keywords: '周报 周复盘 复盘 SEO 每周 weekly review',
        render: (c) => <WeeklyReportsCard assignment={c.connectAs ?? c.ownerId ?? ''} />,
      },
      {
        id: 'wechat',
        title: 'sp.wechat',
        desc: 'sp.wechat.desc',
        keywords: '微信 ClawBot 扫码 手机 WeChat',
        render: () => <ImChannelsPage part="mine" />,
      },
    ],
  },
  {
    id: 'memory',
    group: 'you',
    title: 'sp.memory',
    icon: Brain,
    items: [
      {
        id: 'auto-memory',
        title: 'settings.auto_memory',
        desc: 'sp.auto_memory.desc',
        keywords: '记住 记忆 memory',
        render: () => <AutoMemorySetting />,
      },
    ],
  },
  {
    id: 'privacy',
    group: 'you',
    title: 'sp.privacy',
    icon: Shield,
    items: [
      {
        id: 'data-backend',
        title: 'storage.title',
        desc: 'sp.data_backend.desc',
        keywords: '数据后端 存储 迁移 云 托管 storage',
        show: owner,
        render: (c) => <DataBackend assignment={as(c)} />,
      },
      {
        id: 'data-map',
        title: 'datamap.title',
        desc: 'sp.data_map.desc',
        keywords: '数据来源 权限',
        show: (c) => c.position !== null,
        render: (c) => (c.position === null ? null : <DataMapPanel position={c.position} />),
      },
      {
        // WP476（决策 1590）：匿名使用数据（一台机器一份；测试阶段默认开）
        id: 'telemetry',
        title: 'telemetry.title',
        desc: 'telemetry.desc',
        keywords: '匿名 使用数据 统计 改进 隐私 analytics telemetry usage data privacy',
        render: () => <TelemetrySetting />,
      },
    ],
  },
  {
    id: 'shortcuts',
    group: 'you',
    title: 'sp.shortcuts',
    icon: Keyboard,
    items: [
      {
        id: 'shortcuts',
        title: 'sp.shortcuts',
        desc: 'sp.shortcuts.desc',
        keywords: '键盘 ⌘K keyboard',
        render: () => <ShortcutsList />,
      },
    ],
  },

  // ── AI ───────────────────────────────────────────────
  {
    id: 'models',
    group: 'ai',
    title: 'sp.models',
    icon: Sparkles,
    show: owner,
    items: [
      {
        id: 'models',
        title: 'models.title',
        desc: 'sp.models.desc',
        keywords: 'DeepSeek 默认模型 生图 API key AI',
        // WP426：「还没接模型」那条黄条不在这里重复——「正在用」的空态就是它
        render: (c) => <ModelsPanel assignment={as(c)} />,
      },
    ],
  },
  {
    id: 'web',
    group: 'ai',
    title: 'sp.web',
    icon: Globe,
    items: [
      {
        id: 'browser',
        title: 'settings.browser',
        desc: 'sp.browser.desc',
        keywords: '内置浏览器 Chrome 网页 browser',
        show: owner,
        render: (c) => <BrowserCard assignment={as(c)} />,
      },
      {
        id: 'computer-use',
        title: 'settings.cu',
        desc: 'sp.cu.desc',
        keywords: '屏幕 点击 computer use',
        show: owner,
        render: (c) => <ComputerUseCard assignment={as(c)} />,
      },
      {
        id: 'image-hosts',
        title: 'settings.image_hosts',
        desc: 'sp.image_hosts.desc',
        keywords: '图片 白名单 图床 images',
        render: () => <ImageHostsSetting />,
      },
    ],
  },
  {
    id: 'runs',
    group: 'ai',
    title: 'sp.runs',
    icon: Timer,
    items: [
      {
        id: 'run-limits',
        title: 'settings.run_limits',
        desc: 'sp.run_limits.desc',
        keywords: '超时 卡住 timeout',
        render: () => <RunLimitsSetting />,
      },
      {
        id: 'archive',
        title: 'settings.archive',
        desc: 'sp.archive.desc',
        keywords: '归档 左栏 archive',
        render: () => <ArchiveSetting />,
      },
      {
        id: 'content-updates',
        title: 'sp.content_updates',
        desc: 'sp.content_updates.desc',
        keywords: '技能 模板 升级 已审的内容更新',
        render: () => <ContentUpdatesSetting />,
      },
    ],
  },

  // ── 品牌（随当前品牌）──────────────────────────────────
  {
    id: 'profile',
    group: 'brand',
    title: 'sp.profile',
    icon: Contact,
    items: [
      {
        id: 'brand-profile',
        title: 'settings.company',
        modeTitle: true,
        desc: 'sp.brand_profile.desc',
        keywords: '公司档案 品牌名 目标市场 客服邮箱 币种 平台 重新分析',
        render: (c) => (
          <BrandProfileSettings {...(c.ownerId === undefined ? {} : { ownerId: c.ownerId })} />
        ),
      },
      {
        id: 'gross-margin',
        title: 'sp.gross_margin',
        desc: 'sp.gross_margin.desc',
        keywords: '利润 盈亏 margin',
        show: owner,
        render: (c) => <GrossMarginCard assignment={as(c)} />,
      },
    ],
  },
  {
    id: 'design',
    group: 'brand',
    title: 'sp.design',
    icon: Palette,
    items: [
      {
        id: 'brand-design',
        title: 'sp.brand_design',
        desc: 'sp.brand_design.desc',
        keywords: 'DESIGN.md 颜色 字体 logo',
        render: () => <BrandDesignCard />,
      },
      {
        id: 'brand-assets',
        title: 'sp.brand_assets',
        desc: 'sp.brand_assets.desc',
        keywords: '图片 素材 商品图',
        render: () => <BrandAssetsCard />,
      },
    ],
  },
  {
    id: 'positions',
    group: 'brand',
    title: 'sp.positions',
    icon: ClipboardList,
    items: [
      {
        id: 'positions',
        title: 'sp.positions',
        desc: 'sp.positions.desc',
        keywords: '岗位与品牌 职责 新建岗位 分给同事',
        render: () => <OrgPage only="positions" />,
      },
    ],
  },
  {
    id: 'connections',
    group: 'brand',
    title: 'sp.connections',
    icon: Plug,
    show: (c) => c.connectAs !== undefined,
    items: [
      {
        id: 'connections',
        title: 'sp.connections',
        desc: 'sp.connections.desc',
        keywords: '连接 Shopify 邮箱 广告 社媒 授权',
        render: () => <ConnectionsPage embedded />,
      },
    ],
  },
  {
    id: 'channels',
    group: 'brand',
    title: 'sp.channels',
    icon: MessageSquare,
    items: [
      {
        id: 'team-bots',
        title: 'sp.team_bots',
        heading: true,
        desc: 'sp.team_bots.desc',
        keywords: '企业微信 飞书 钉钉 机器人 IM',
        render: () => <ImChannelsPage part="team" />,
      },
      {
        id: 'site-chat',
        title: 'nav.chat_window',
        heading: true,
        desc: 'sp.site_chat.desc',
        keywords: '聊天窗 挂件 嵌入代码 网站聊天 widget',
        show: (c) => c.holdsSiteChat,
        render: () => <ImChannelsPage part="site" />,
      },
    ],
  },
  {
    id: 'data-apis',
    group: 'brand',
    title: 'sp.data_apis',
    icon: Database,
    show: owner,
    items: [
      {
        id: 'search-data',
        title: 'search_data.title',
        desc: 'sp.search_data.desc',
        keywords: 'SEO GEO 自带 key 数据接口',
        render: (c) => <SearchDataSection assignment={as(c)} />,
      },
      {
        id: 'read-routes',
        title: 'read_routes.title',
        desc: 'sp.read_routes.desc',
        keywords: '取数 体检 Reddit',
        render: (c) => <ReadRoutesSection assignment={as(c)} />,
      },
    ],
  },
  {
    id: 'toolbox',
    group: 'brand',
    title: 'sp.toolbox',
    icon: Wrench,
    items: [
      {
        id: 'toolbox',
        title: 'sp.toolbox',
        desc: 'sp.toolbox.desc',
        keywords: '自动化 工具',
        render: () => <OrgPage only="toolbox" />,
      },
    ],
  },
  {
    id: 'brands',
    group: 'brand',
    title: 'sp.brands',
    icon: Building2,
    items: [
      {
        id: 'brands',
        title: 'sp.brands',
        desc: 'sp.brands.desc',
        keywords: '品牌 新建品牌 切换品牌 暂停',
        render: () => <OrgPage only="brands" />,
      },
    ],
  },

  // ── 这台电脑 ─────────────────────────────────────────
  {
    id: 'desktop',
    group: 'device',
    title: 'sp.desktop',
    icon: Monitor,
    show: (c) => c.desktop,
    items: [
      {
        // WP361（决策 927）：开机自启从「在托盘菜单里」变成这里的开关（托盘那一项照旧、两边同步）
        id: 'launch-at-login',
        title: 'sp.launch_at_login',
        desc: 'sp.launch_at_login.desc',
        keywords: '开机自启 开机启动 自动启动 登录时打开 launch at login startup',
        show: (c) => c.launchAtLogin,
        render: () => <LaunchAtLoginRow />,
      },
      {
        id: 'tray',
        title: 'sp.tray',
        desc: 'sp.tray.desc',
        keywords: '暂停 导出诊断 托盘 tray pause',
        render: () => <TrayRow />,
      },
    ],
  },
  {
    id: 'background',
    group: 'device',
    title: 'sp.background',
    icon: Cog,
    show: owner,
    items: [
      {
        id: 'background',
        title: 'sp.background',
        desc: 'sp.background.desc',
        keywords: '后台 同时 并发',
        render: (c) => <BackgroundCard assignment={as(c)} />,
      },
    ],
  },
  {
    id: 'extension',
    group: 'device',
    title: 'sp.extension',
    icon: Puzzle,
    show: owner,
    items: [
      {
        id: 'extension',
        title: 'sp.extension',
        desc: 'sp.extension.desc',
        keywords: '插件 配对码 Chrome extension',
        render: (c) => <BrowserExtensionSection assignment={as(c)} />,
      },
    ],
  },
  {
    id: 'scenes',
    group: 'device',
    title: 'sp.scenes',
    icon: Layers,
    show: owner,
    items: [
      {
        id: 'scenes',
        title: 'sp.scenes',
        desc: 'sp.scenes.desc',
        keywords: 'DeepSeek 场景 编程 scene',
        render: () => <SceneSwitcher variant="inline" />,
      },
    ],
  },
  {
    id: 'plugins',
    group: 'device',
    title: 'sp.plugins',
    icon: Cable,
    show: owner,
    items: [
      {
        id: 'plugins',
        title: 'sp.plugins',
        desc: 'sp.plugins.desc',
        keywords: '官方插件 DeepSeek plugin',
        render: (c) => <OfficialPluginsPanel assignment={as(c)} />,
      },
    ],
  },
  {
    id: 'diagnostics',
    group: 'device',
    title: 'sp.diagnostics',
    icon: Stethoscope,
    show: owner,
    items: [
      {
        id: 'diagnostics',
        title: 'sp.diagnostics',
        desc: 'sp.diagnostics.desc',
        keywords: '排查 重投 没进来的信 下载源',
        render: (c) => <DiagnosticsCard assignment={as(c)} />,
      },
    ],
  },

  // ── 团队（② 同事互联 / ③ 公司才有）─────────────────────
  {
    id: 'people',
    group: 'team',
    title: (c) => (c.mode === 'peers' ? 'sp.people.peers' : 'sp.people.company'),
    icon: UserRound,
    show: notSolo,
    items: [
      {
        id: 'people',
        title: (c) => (c.mode === 'peers' ? 'sp.people.peers' : 'sp.people.company'),
        desc: 'sp.people.desc',
        keywords: '同事 成员 负责人 退出',
        render: () => <OrgPage only="people" />,
      },
    ],
  },
  {
    id: 'invite',
    group: 'team',
    title: 'sp.invite',
    icon: UserPlus,
    show: company,
    items: [
      {
        id: 'invite',
        title: 'sp.invite',
        desc: 'sp.invite.desc',
        keywords: '邀请 加入公司 申请',
        render: () => <OrgPage only="invite" />,
      },
    ],
  },
  {
    id: 'ranges',
    group: 'team',
    title: 'org.tab.ranges',
    icon: Layers,
    show: company,
    items: [
      {
        id: 'ranges',
        title: 'org.tab.ranges',
        desc: 'sp.ranges.desc',
        keywords: '店铺组 产品线 范围',
        render: () => <OrgPage only="ranges" />,
      },
    ],
  },
  {
    id: 'merge',
    group: 'team',
    title: 'org.tab.join',
    icon: HardDrive,
    show: company,
    items: [
      {
        id: 'merge',
        title: 'org.tab.join',
        desc: 'sp.merge.desc',
        render: () => <OrgPage only="join" />,
      },
    ],
  },
  {
    id: 'usage',
    group: 'team',
    title: 'sp.usage',
    icon: Bot,
    // ② 同事互联里每人用量就在「同事」那一节里（ColleaguesTab 自带），不重复一节
    show: company,
    items: [
      {
        id: 'usage',
        title: 'sp.usage',
        desc: 'sp.usage.desc',
        keywords: '用量 积分 每个人',
        render: (c) => <PeopleUsage localFallback={c.mode === 'peers'} />,
      },
    ],
  },
  {
    id: 'collab',
    group: 'team',
    title: 'sp.collab',
    icon: Users,
    show: notSolo,
    items: [
      {
        id: 'handoff-days',
        title: 'settings.handoff_days',
        desc: 'sp.handoff_days.desc',
        keywords: '退回 交给同事',
        render: () => <HandoffDaysSetting />,
      },
    ],
  },
  // WP361（决策 925）：「进行中」看板挪到账号菜单「工作内容」（`/in-progress`），不在弹窗里了
]

/** 这一节里现在能看到的那几项（节本身不出 = 空）。 */
export function visibleItems(s: SettingSectionDef, c: SettingsCtx): readonly SettingItemDef[] {
  if (s.show !== undefined && !s.show(c)) return []
  return s.items.filter((i) => i.show === undefined || i.show(c))
}

export function sectionTitleKey(s: SettingSectionDef, c: SettingsCtx): string {
  return typeof s.title === 'string' ? s.title : s.title(c)
}

/** 一项解好词之后的样子（弹窗、搜索、⌘K 都用这个）。 */
export interface SettingItemView {
  def: SettingItemDef
  section: SettingsSectionId
  sectionTitle: string
  title: string
  desc: string
  /** 搜索用：标题 + 说明 + 别名 + 节名，小写。 */
  haystack: string
}

export interface SettingSectionView {
  def: SettingSectionDef
  title: string
  items: readonly SettingItemView[]
}

/** 现在看得到的各节（解好词、去掉空节），按五组的顺序。 */
export function useSettingsCatalog(): {
  ctx: SettingsCtx
  sections: readonly SettingSectionView[]
} {
  const ctx = useSettingsCtx()
  const { t } = useApp()
  const { t: tm } = useMode()
  const sections: SettingSectionView[] = []
  for (const def of SETTINGS_SECTION_DEFS) {
    const items = visibleItems(def, ctx)
    if (items.length === 0) continue
    const sectionTitle = t(sectionTitleKey(def, ctx))
    sections.push({
      def,
      title: sectionTitle,
      items: items.map((i) => {
        const key = typeof i.title === 'string' ? i.title : i.title(ctx)
        const title = i.modeTitle === true ? tm(key) : t(key)
        const desc = t(i.desc)
        return {
          def: i,
          section: def.id,
          sectionTitle,
          title,
          desc,
          haystack: [title, desc, i.keywords ?? '', sectionTitle].join(' ').toLowerCase(),
        }
      }),
    })
  }
  return { ctx, sections }
}

/**
 * 按标题和说明全文搜：空格隔开的每个词都要出现（不做模糊——中文模糊匹配命中一堆不相干的）。
 * 标题里就有的排前面。
 */
export function searchSettings(
  sections: readonly SettingSectionView[],
  query: string,
): readonly SettingItemView[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return []
  const hits = sections.flatMap((s) =>
    s.items.filter((i) => terms.every((term) => i.haystack.includes(term))),
  )
  const inTitle = (i: SettingItemView): number =>
    terms.every((term) => i.title.toLowerCase().includes(term)) ? 0 : 1
  return [...hits].sort((a, b) => inTitle(a) - inTitle(b))
}
