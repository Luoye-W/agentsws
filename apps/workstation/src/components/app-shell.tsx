/**
 * 36 §3 / §9 / §10 的布局：**左栏（去哪儿）+ 中栏（决定什么）+ 右栏（看着什么决定）**。
 *
 * 左栏「岗位」那一栏列的是**岗位**（WP70 / 54 §4）：以前列的是一条条分配，也就是
 * 职责——做网站运营的人在左栏看到四行（店铺管理 / 内容与博客 / 邮件营销 / 订单履约），
 * 而他心里只有一个"网站运营"。现在一个岗位一行、待审数按岗位聚合。
 *
 * WP71（36 §10，09-16 Luoye 定）在此之上改三处：
 *
 * 1. **岗位行可展开**（行首 › / ˅）：展开后是这个岗位下**本人持有**的那几条职责，
 *    点一条进职责页。展开态记在本机（`lib/ui-state.ts`），没记过的按"当前岗位默认展开"算。
 *    展开层里**不再有**"记忆 · 技能 · 知识 · 额度"那一行——那四样搬进了第三栏
 *    （`components/rail/right-rail.tsx`），跟着当前岗位 / 当前职责走。
 * 2. **品牌切换器与账号块搬到左栏最下面**；顶栏只剩 ⌘K、模型芯片、积分
 *    （深浅色与语言两个开关收进账号菜单）。
 * 3. **右边多一条 44px 图标轨**（第三栏，36 §9）。
 *
 * WP342（决策 853，Luoye 10-15）：左栏只剩 随便聊 / 首页 / 消息 / 待办 / 日历 / 岗位树；下半那几页与「场景」
 * 收进账号菜单；顶栏的模型与积分芯片拿掉（积分进账号菜单，AI 在每个输入框左下角选）。
 *
 * WP372（决策 1001 / 1002，Luoye 10-17 定 C3，学 Claude 桌面版）：岗位 → 职责 → 对话三层里**左栏只放两层**
 * （岗位、挂在细竖线上的职责），**对话进右侧面板**；第三栏那一竖条图标改成**窗口右上角一排**（六张卡 + 「⋮」），
 * 顶栏那个「交给某个岗位一件事… ⌘K」搜索框去掉（⌘K 快捷键保留）。
 */
import type { DeckCard, TileSpec } from '@agentsws/deck'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  CalendarDays,
  ChevronDown,
  ChevronRight,
  Home,
  Inbox,
  ListTodo,
  type LucideIcon,
  MessageCircle,
} from 'lucide-react'
import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react'
import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import { AccountBlock } from '@/components/account-block'
import { BrandSwitcher } from '@/components/brand-switcher'
import { CommandPalette } from '@/components/command-palette'
import {
  type ConversationActions,
  ConversationActionsProvider,
} from '@/components/conversations/actions'
import { BrandMark } from '@/components/design'
import { ErrorBoundary } from '@/components/error-boundary'
import { useSiteChatUnread } from '@/components/messages/site-chat'
import { NoModelBanner } from '@/components/models/no-model-banner'
import { QuotaChip } from '@/components/models/quota-notice'
import { type ComposeTarget, type Handoff, PaletteProvider } from '@/components/palette-context'
import { RailStateProvider, useRailState } from '@/components/rail/rail-state'
import { RailHost, RailTopBar } from '@/components/rail/right-rail'
import { PositionIcon } from '@/components/role-icons/role-icon'
import { AddDutyInline } from '@/components/sidebar/add-duty-inline'
import { ArchivedDialog, type ArchivedScope } from '@/components/sidebar/archived-dialog'
import { NewPositionInline } from '@/components/sidebar/new-position-inline'
import { RailPlus } from '@/components/sidebar/rail-plus'
// WP60（48 L6）：值守中的角标。自带数据，顶栏这里只有一行
import { StandbyBadge } from '@/components/standby-badge'
import { DemoBadge } from '@/components/ui/demo-badge'
import { UpdateButton } from '@/components/update-button'
import { MemoryNotice } from '@/components/work/memory-notice'
import {
  listMessageAccounts,
  type Me,
  type PositionInstanceData,
  type PositionSummary,
} from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { dutyHref } from '@/lib/duty-href'
import { myAssignments } from '@/lib/positions'
import { RAIL_EXPANDED_KEY, readFlags, writeFlags } from '@/lib/ui-state'
import { cn } from '@/lib/utils'
import { archiveMatter, type RailMatter, unarchiveMatter } from '@/lib/work-archive'

/**
 * 左栏一行。
 *
 * WP96（09-18 画布）：选中态是**浅品牌底 + 品牌深色字**（`--sidebar-accent` /
 * `--sidebar-accent-foreground` 已经指到 tint / brand-ink 上），不再是灰底。
 * WP351（决策 906，Luoye 10-16「学 Claude 左栏更紧凑」）：行高、字号、圆角按 Claude 左栏的密度收
 * （一行约 30px、13px 字、圆角 8）。
 */
const ROW = 'flex items-center gap-2 rounded-[8px] px-2 py-1.5 text-[13px] transition-colors'
const ROW_ACTIVE =
  'bg-sidebar-accent text-sidebar-accent-foreground font-medium [&_svg]:text-current [--ia:var(--ws-brand)]'
const ROW_IDLE = 'hover:bg-sidebar-accent/60 [&_svg]:text-ws-muted-fg'

function navClass({ isActive }: { isActive: boolean }): string {
  // 选中态图标跟文字同色（`[&_svg]:text-current`），未选中时图标压成 muted。
  // WP213：选中行设 `--ia`，岗位 / 职责图标的点睛那一笔换品牌色（docs/36 §8.3）
  return cn(ROW, isActive ? ROW_ACTIVE : ROW_IDLE)
}

/** 侧栏图标统一 16px；颜色交给 `navClass` 里的 `[&_svg]` 规则。 */
function NavIcon({ icon: Icon }: { icon: LucideIcon }): ReactNode {
  return <Icon aria-hidden className="size-4 shrink-0" />
}

/** 职责页的地址（WP298：挪到 `lib/duty-href.ts`，这里照旧导出，老调用方不用改）。 */
export { dutyHref }

/**
 * WP234（docs/54 §6.1 / §6.5）：工作区底座职责——`common.owner`（负责人身份）与 `common.member`
 * 不算任何岗位的活，左栏「岗位」里不出。负责人的入口在「公司」页。
 */
const WORKSPACE_BASE_ROLES: ReadonlySet<string> = new Set(['common.owner', 'common.member'])

/**
 * 左栏「岗位」那一栏的一行：一个岗位（WP70），点名字进岗位页。
 *
 * 地址用本人在这个岗位下的第一条分配（36 §3 的"岗位"= 一条 Assignment）。
 * 展开层里只列**本人持有**的职责：别人那条分配不能拿来开事（54 §2 / WP69），
 * 列出来只会让人点进一个进不去的页面。
 *
 * WP207：岗位行悬停出「+」= 给这个岗位加职责（只有所有者有）；职责行悬停出「+」= 在这条职责下开新对话。
 * WP351（决策 906）：没有常驻的「>」和数字——鼠标移上来（或键盘落到这一行）名字右边才出一个「>」，
 * 点它展开 / 收起；点名字进岗位页。键盘：Tab 落到岗位名，Enter 进页，→ 展开、← 收起。
 *
 * WP372（决策 1001，Luoye 10-17 定 C3，学 Claude 桌面版）：左栏**只放两层**——
 * - 岗位行：图标 + 名字，500 字重；
 * - 职责挂在一条细竖线上（13px、次要色），点进职责页；
 * - **对话不挂在左栏了**，搬进右侧面板「对话」卡（当前职责的对话 / 岗位总览时按职责分组）；
 *   职责行的「+」= 跳到这条职责、右侧面板「对话」卡直接开「新对话」那一格；「已归档」也在那张卡里。
 */
function PositionNav({
  instance,
  open,
  onToggle,
  owner,
  person_id,
}: {
  instance: PositionInstanceData
  open: boolean
  onToggle: () => void
  /** WP207：所有者那条分配；有它才出「加职责」的「+」。 */
  owner?: string
  person_id?: string
}): ReactNode {
  const { lang, t } = useApp()
  const rail = useRailState()
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const [adding, setAdding] = useState(false)
  const first = myAssignments(instance)[0]
  if (first === undefined) return null
  const name = lang === 'en' ? instance.name.en : instance.name.zh
  const duties = instance.roles.filter((r) => r.my_assignment_id !== undefined)
  const href = `/positions/${first}`
  // 只在岗位页本身亮（在它的职责页时亮的是那条职责，不是两行一起亮）
  const active = pathname === href
  const Chevron = open ? ChevronDown : ChevronRight
  return (
    <div data-testid="nav-position-row" data-position={instance.position_id}>
      <div className={cn(ROW, 'gap-1 py-0', active ? ROW_ACTIVE : ROW_IDLE, 'group/row')}>
        <NavLink
          to={href}
          end
          className="flex min-w-0 items-center gap-2 rounded-[6px] py-1.5 font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring"
          data-testid="nav-position"
          data-position={instance.position_id}
          aria-expanded={open}
          onKeyDown={(e) => {
            if ((e.key === 'ArrowRight' && !open) || (e.key === 'ArrowLeft' && open)) {
              e.preventDefault()
              onToggle()
            }
          }}
        >
          <PositionIcon
            position_id={instance.position_id}
            icon={instance.icon}
            role_ids={instance.roles.map((r) => r.role_id)}
          />
          <span className="truncate">{name}</span>
        </NavLink>
        <button
          type="button"
          aria-expanded={open}
          aria-label={t('rail.expand', { name })}
          data-testid="nav-position-toggle"
          className="flex size-5 shrink-0 items-center justify-center rounded opacity-0 transition-opacity group-hover/row:opacity-100 hover:bg-sidebar-accent focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-ring"
          onClick={onToggle}
        >
          <Chevron aria-hidden className="size-3.5" />
        </button>
        {/* 行里名字右边空着的那一截也能点进岗位页（鼠标用；键盘走上面那个链接） */}
        <NavLink to={href} end tabIndex={-1} aria-hidden className="min-w-1 flex-1 self-stretch" />
        {owner === undefined || person_id === undefined ? null : (
          <RailPlus
            hover
            label={t('rail.add_duty', { name })}
            testId="rail-add-duty-plus"
            expanded={adding}
            onClick={() => {
              setAdding((v) => !v)
            }}
          />
        )}
      </div>
      {adding && owner !== undefined && person_id !== undefined ? (
        <AddDutyInline
          owner={owner}
          person_id={person_id}
          position_id={instance.position_id}
          onCancel={() => {
            setAdding(false)
          }}
          onDone={() => {
            setAdding(false)
            if (!open) onToggle()
          }}
        />
      ) : null}
      {open && duties.length > 0 ? (
        // 职责挂在细竖线上：字小一号、颜色淡一档（选中时照常亮成品牌色）
        <ul
          className="ml-[15px] flex flex-col gap-px border-l border-ws-line pl-1.5"
          data-testid="nav-duties"
        >
          {duties.map((r) => {
            const to = dutyHref(r.my_assignment_id ?? '', r.role_id)
            return (
              <li key={r.role_id} data-duty={r.role_id}>
                <div className="group/row flex items-center gap-0.5">
                  <NavLink
                    to={to}
                    className={({ isActive }) =>
                      cn(
                        'flex min-w-0 flex-1 items-center rounded-[8px] px-2 py-1 text-[13px] transition-colors',
                        isActive
                          ? 'bg-sidebar-accent font-medium text-sidebar-accent-foreground'
                          : 'text-ws-muted-fg hover:bg-sidebar-accent/60 hover:text-foreground',
                      )
                    }
                    data-testid="nav-duty"
                  >
                    <span className="truncate">{r.role_name}</span>
                  </NavLink>
                  <RailPlus
                    hover
                    label={t('rail.new_matter', { name: r.role_name })}
                    testId="rail-new-matter"
                    onClick={() => {
                      rail.openCard('conversations', { intent: 'compose', pathname: to })
                      void navigate(to)
                    }}
                  />
                </div>
              </li>
            )
          })}
        </ul>
      ) : null}
    </div>
  )
}

/**
 * 左栏「消息」右边那个未读点。
 *
 * **是一个点，不是一个数字**（36 减字 / 图形化，WP96 那一轮定的调子）：
 * 未读 132 封时一个红色的 "132" 会让整块左栏看起来像在报警，而它要说的只有
 * "那边有没读的"。数字留给点进去之后的文件夹。
 *
 * 取不到（没装配消息面 / 一只邮箱都没连）就什么都不画——不报错、不占位。
 */
function MessagesUnread(): ReactNode {
  const accounts = useQuery({
    queryKey: ['messages', 'accounts'],
    queryFn: listMessageAccounts,
    retry: false,
    staleTime: 60_000,
  })
  const unread = (accounts.data?.accounts ?? []).reduce((n, a) => n + a.unread, 0)
  // WP351：网站访客的对话也是消息——有没看过的也亮这个点
  const siteChat = useSiteChatUnread()
  if (unread === 0 && !siteChat) return null
  return (
    <i
      aria-hidden
      data-testid="nav-messages-dot"
      className="ml-auto size-1.5 shrink-0 rounded-full bg-ws-brand"
    />
  )
}

export function AppShell({
  children,
  positions,
  instances,
  cards,
  tileLibrary,
  me,
  onAddTile,
}: {
  children: ReactNode
  positions: PositionSummary[]
  /** WP70：按岗位聚合的那一份。没有它（老服务进程）就退回按分配列。 */
  instances?: PositionInstanceData[]
  cards: DeckCard[]
  tileLibrary: TileSpec[]
  /** WP71：左栏最下面那个账号块要的名字 / 公司名。没有就显示占位，不报错。 */
  me?: Me
  onAddTile: (position_id: string, tile_id: string) => void
}): ReactNode {
  const { t, position } = useApp()
  // WP271：① 个人里左栏「公司」叫「岗位与品牌」、「我的代理」收起（都是对同事的事）
  const [paletteOpen, setPaletteOpen] = useState(false)
  /** WP188：「交给岗位去做」带过来的那件事（面板开着时只列岗位）。 */
  const [handoff, setHandoff] = useState<Handoff | undefined>(undefined)
  /** WP207：职责行「+」预选好的岗位与职责（面板开着时只剩一格输入）。 */
  const [compose, setCompose] = useState<ComposeTarget | undefined>(undefined)
  const palette = useMemo(
    () => ({
      open: (next?: Handoff) => {
        setCompose(undefined)
        setHandoff(next)
        setPaletteOpen(true)
      },
      compose: (target: ComposeTarget) => {
        setHandoff(undefined)
        setCompose(target)
        setPaletteOpen(true)
      },
    }),
    [],
  )
  /** 现在开着的是首次设置向导吗（顶栏那条「还没接模型」在向导期间不出，70 §2.2）。 */
  const { pathname } = useLocation()
  const onboarding = pathname === '/onboarding'
  // 岗位面装着就按岗位列；没装（或一个岗位都算不出来）退回老样子
  const byPosition = (instances ?? []).filter((p) => myAssignments(p).length > 0)
  // WP71：只存"用户显式点过的那几个"，没点过的按"当前岗位默认展开"算
  const [flags, setFlags] = useState<Record<string, boolean>>(() => readFlags(RAIL_EXPANDED_KEY))
  const current = byPosition.find((p) => myAssignments(p).includes(position ?? ''))
  /** WP207：「+」只给所有者（公司页的写操作也只有所有者能做，05 §3）。 */
  const owner = me?.assignments.find(
    (a) => a.role_id === 'common.owner' && a.revoked_at === undefined,
  )?.id
  const [creating, setCreating] = useState(false)
  const [archived, setArchived] = useState<ArchivedScope | undefined>(undefined)
  /*
   * Fable 09-30：手动归档一件，左栏底部出一条「已归档『…』· 撤销」，八秒后自己收。
   * 撤销 = 恢复（`by: user`），两下都只动这一件。
   */
  const client = useQueryClient()
  const [undo, setUndo] = useState<{ id: string; title: string } | undefined>(undefined)
  const [undoError, setUndoError] = useState<string | undefined>(undefined)
  useEffect(() => {
    if (undo === undefined && undoError === undefined) return
    const h = setTimeout(() => {
      setUndo(undefined)
      setUndoError(undefined)
    }, 8000)
    return () => {
      clearTimeout(h)
    }
  }, [undo, undoError])
  const archiveOne = useMutation({
    mutationFn: (m: RailMatter) => archiveMatter(m.id),
    onSuccess: async (_out, m) => {
      setUndoError(undefined)
      setUndo({ id: m.id, title: m.title })
      await client.invalidateQueries({ queryKey: ['matter'] })
    },
    onError: (err) => {
      setUndoError(err instanceof Error ? err.message : String(err))
    },
  })
  const restoreOne = useMutation({
    mutationFn: (id: string) => unarchiveMatter(id, 'user'),
    onSuccess: async () => {
      setUndo(undefined)
      await client.invalidateQueries({ queryKey: ['matter'] })
    },
  })
  /** WP372：右侧面板「对话」里的两个动作（归档一件 / 看已归档的）还是走这里的撤销条与列表。 */
  const conversationActions = useMemo<ConversationActions>(
    () => ({
      archive: (m) => {
        archiveOne.mutate(m)
      },
      openArchived: (scope) => {
        setArchived(scope)
      },
    }),
    [archiveOne.mutate],
  )

  const toggle = useCallback((position_id: string, wasOpen: boolean) => {
    setFlags((prev) => {
      const next = { ...prev, [position_id]: !wasOpen }
      writeFlags(RAIL_EXPANDED_KEY, next)
      return next
    })
  }, [])

  return (
    <RailStateProvider>
      <PaletteProvider value={palette}>
        <ConversationActionsProvider value={conversationActions}>
          <div className="flex min-h-screen bg-background text-foreground">
            {/*
          WP71：左栏**钉在视口上**（`sticky` + `h-screen`）。
          账号块在最下面，而主区经常比一屏长——不钉住的话它会跟着页面滚走，
          "最下面"就成了"文档的最下面"，滚三屏才见得到。
        */}
            <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-ws-line bg-sidebar p-3 md:flex">
              {/*
            WP112：左栏顶部 = **母品牌标记 + 字标**，点了回首页。

            标记给 24（Luoye 09-18 定：再缩一点）；再小就退单色，见 `@agentsws/brand` 的 `MIN_GRADIENT_PX`。
            字标是产品名「Agents 工坊」（Luoye 09-18 定；`agentsws` 只留作仓库 / 包 / 域名），
            走 Outfit（WP96：与页面大标题同一种字）；整句留给读屏当 aria-label。
            WP195（Luoye 09-29「静态的 logo 其实不好看」）：改成**待机**——大部分时间一动不动，
            隔几秒轻轻动一下；鼠标移上去播一次「一变一队」再回待机。点了回首页不变。
          */}
              <div className="px-2 pt-1 pb-3">
                <NavLink
                  to="/"
                  end
                  aria-label={t('app.title')}
                  data-testid="brand-home"
                  className="inline-flex items-center gap-2 rounded-[10px] outline-offset-4"
                >
                  <BrandMark size={24} motion="idle" playOnHover />
                  <span className="ws-display text-[14px]">Agents 工坊</span>
                </NavLink>
              </div>
              <nav
                className="flex flex-1 flex-col gap-px overflow-y-auto"
                aria-label={t('nav.main')}
                data-testid="main-nav"
              >
                {/*
              WP188（Luoye 09-29）：「随便聊」在最上面——想试一个模型、问个随手的问题，
              不必先"交给某个岗位一件事"。像 DeepSeek 网页版：会话列表 + 对话 + 输入框。
              WP343（决策 334 / 859）：改名「我的助理」（并进了「我的代理」），仍在最上面。
            */}
                <NavLink to="/assistant" className={navClass} data-testid="nav-free-chat">
                  <NavIcon icon={MessageCircle} />
                  {t('nav.free_chat')}
                </NavLink>
                <NavLink to="/" end className={navClass}>
                  <NavIcon icon={Home} />
                  {t('nav.home')}
                </NavLink>
                {/*
              WP113（63 §1）：这一格原来是「目标」。Luoye 定：换成**消息**——
              一只邮箱是人每天真正会去的地方，而目标是每周看一次的东西。
              目标模型**没删**（37 的每日计划与复盘都靠它），入口收进「待办」页的
              一个 tab，`/goals` 路由留着，⌘K 里仍然搜得到。
              顺序：首页 / 消息 / 待办 / 日历。
            */}
                <NavLink to="/messages" className={navClass} data-testid="nav-messages">
                  <NavIcon icon={Inbox} />
                  {t('nav.messages')}
                  <MessagesUnread />
                </NavLink>
                {/*
              WP351（Luoye 10-16）：左栏不再有「聊天窗」。访客的对话并进「消息」（来源「网站聊天」），
              挂件设置在账号菜单「设置」组的「消息渠道」页（渠道「网站聊天窗」）；老地址跳到消息里，⌘K 两处都搜得到。
            */}
                {/* 37 工作模型：待办 / 日历 */}
                <NavLink to="/todos" className={navClass}>
                  <NavIcon icon={ListTodo} />
                  {t('nav.todos')}
                </NavLink>
                <NavLink to="/calendar" className={navClass}>
                  <NavIcon icon={CalendarDays} />
                  {t('nav.calendar')}
                </NavLink>
                {/* WP207：标题右边一个常显的「+」= 新建岗位（照 Claude 的做法；只有所有者有） */}
                <div className="flex items-center justify-between px-2 pt-3 pb-1">
                  <span className="text-[11px] tracking-wider text-ws-muted-fg uppercase">
                    {t('nav.positions')}
                  </span>
                  {owner === undefined || me === undefined ? null : (
                    <RailPlus
                      label={t('rail.new_position')}
                      testId="rail-new-position-plus"
                      expanded={creating}
                      onClick={() => {
                        setCreating((v) => !v)
                      }}
                    />
                  )}
                </div>
                {creating && owner !== undefined && me !== undefined ? (
                  <NewPositionInline
                    owner={owner}
                    person_id={me.person.id}
                    onCancel={() => {
                      setCreating(false)
                    }}
                    onDone={(position_id) => {
                      setCreating(false)
                      // 建完展开它（记成显式展开，下次进来还开着）
                      setFlags((prev) => {
                        const next = { ...prev, [position_id]: true }
                        writeFlags(RAIL_EXPANDED_KEY, next)
                        return next
                      })
                    }}
                  />
                ) : null}
                {byPosition.length > 0
                  ? byPosition.map((p) => {
                      const open = flags[p.position_id] ?? p.position_id === current?.position_id
                      return (
                        <PositionNav
                          key={p.position_id}
                          instance={p}
                          open={open}
                          onToggle={() => {
                            toggle(p.position_id, open)
                          }}
                          {...(owner === undefined || me === undefined
                            ? {}
                            : { owner, person_id: me.person.id })}
                        />
                      )
                    })
                  : // WP234（docs/54 §6.5）：「负责人」是身份不是岗位——底座职责不进左栏「岗位」
                    positions
                      .filter((p) => !WORKSPACE_BASE_ROLES.has(p.role_id))
                      .map((p) => (
                        <NavLink
                          key={p.position_id}
                          to={`/positions/${p.position_id}`}
                          className={navClass}
                          data-testid="nav-position"
                        >
                          <PositionIcon position_id={p.position_id} role_ids={[p.role_id]} />
                          <span className="truncate">{p.role_name}</span>
                        </NavLink>
                      ))}
                {/*
              WP342（决策 853）：会议 / 知识库 / 技能 / 岗位与品牌 / 连接 / 消息渠道 / 设置收进了
              左下角账号菜单的两组里（`account-block.tsx`），路由与 ⌘K 照旧。左栏只剩去干活的地方。
            */}
                {/* 41 §1 的「我的代理」WP343 起并进「我的助理」（右上角「替我答同事」），左栏不再单独占一行 */}
              </nav>
              {/*
          WP71（36 §10）：品牌与账号在**最下面**。
          个人用户（一个人一个品牌）看不到品牌切换器，那一块自己不渲染（52 O1）。
        */}
              {undo === undefined && undoError === undefined ? null : (
                <div
                  role="status"
                  className="mt-2 flex items-center gap-2 rounded-[10px] bg-ws-ink px-2.5 py-1.5 text-[12px] text-ws-paper"
                  data-testid="rail-undo"
                >
                  <span className="min-w-0 flex-1 truncate">
                    {undo === undefined ? undoError : t('archive.done', { title: undo.title })}
                  </span>
                  {undo === undefined ? null : (
                    <button
                      type="button"
                      data-testid="rail-undo-button"
                      disabled={restoreOne.isPending}
                      className="shrink-0 font-medium underline-offset-2 hover:underline"
                      onClick={() => {
                        restoreOne.mutate(undo.id)
                      }}
                    >
                      {t('archive.undo')}
                    </button>
                  )}
                </div>
              )}
              <div
                className="mt-2 flex flex-col gap-1 border-t border-ws-line pt-2"
                data-testid="rail-bottom"
              >
                <BrandSwitcher />
                {/* WP218：账号区正上方——有新版本时才出现（桌面壳里），点一下就更新 */}
                <UpdateButton />
                <AccountBlock {...(me === undefined ? {} : { me })} />
              </div>
            </aside>

            <div className="flex min-w-0 flex-1 flex-col">
              {/*
            WP372（决策 1001 / 1002，Luoye 10-17，学 Claude 桌面版）：顶栏 = **窗口右上角那一排**。
            左边只剩几条整个工作区的状态（演示数据 / 值守中 / 还没接 AI / 余额不足），右边是六张卡的图标
            与「⋮」（`RailTopBar`；WP412 起：露出的工具 →「⋮」溢出菜单 → 最右专门的面板开关）。原来中间那个「交给某个岗位一件事… ⌘K」搜索框去掉了——派活由助理做（WP343），
            ⌘K 快捷键还在（跳转岗位、搜卡片 / 教程 / 设置、找回归档），只是不再画一个框。
            窗口是系统标题栏（Electron 没开无边框），所以这一排在标题栏下面：Mac 红绿灯、Windows 窗口按钮都挡不到；
            右边留的那一截 `env(titlebar-area-*)` 只在以后开了窗口控件叠加（Window Controls Overlay）时才生效。
          */}
              <header
                className="sticky top-0 z-50 flex h-11 shrink-0 items-center gap-2 border-b border-ws-line bg-ws-paper pl-4"
                style={{
                  paddingRight:
                    'max(0.5rem, calc(100vw - env(titlebar-area-x, 0px) - env(titlebar-area-width, 100vw)))',
                }}
                data-testid="top-bar"
              >
                {/* WP125：合成世界的「演示数据」标记——不显眼但始终在 */}
                <DemoBadge />
                <StandbyBadge />
                {/* WP98 / WP121b：「还没接模型」小胶囊（向导期间不出）；WP151：余额不足 */}
                {onboarding ? null : <NoModelBanner variant="chip" />}
                {onboarding ? null : <QuotaChip />}
                <div className="ml-auto flex items-center">
                  <RailTopBar {...(instances === undefined ? {} : { instances })} />
                </div>
              </header>
              <div className="flex min-w-0 flex-1">
                <main className="min-w-0 flex-1 bg-ws-paper p-4 md:p-7">
                  {/* WP298：页面层错误边界——一页坏了只换主区，左栏顶栏照常；换一页就复原 */}
                  <ErrorBoundary scope="page" resetKey={pathname}>
                    {children}
                  </ErrorBoundary>
                </main>
                {/* WP372：右侧面板（六张卡 / 一格）；宽屏挤在主区右边，< 1200 盖在主区上 */}
                <RailHost {...(instances === undefined ? {} : { instances })} />
              </div>
            </div>

            {/* WP320：「记住了：……」小提醒（点了跳到那条记忆） */}
            <MemoryNotice {...(instances === undefined ? {} : { instances })} />

            {/* WP207：「已归档（n）」点开的列表（筛好那条职责；筛子都能改） */}
            {archived === undefined ? null : (
              <ArchivedDialog
                open
                onOpenChange={(next) => {
                  if (!next) setArchived(undefined)
                }}
                scope={archived}
                instances={byPosition}
              />
            )}

            <CommandPalette
              open={paletteOpen}
              onOpenChange={(next) => {
                setPaletteOpen(next)
                if (!next) {
                  setHandoff(undefined)
                  setCompose(undefined)
                }
              }}
              {...(handoff === undefined ? {} : { handoff })}
              {...(compose === undefined ? {} : { compose })}
              positions={positions}
              {...(instances === undefined ? {} : { instances })}
              cards={cards}
              tileLibrary={tileLibrary}
              onAddTile={onAddTile}
            />
          </div>
        </ConversationActionsProvider>
      </PaletteProvider>
    </RailStateProvider>
  )
}
