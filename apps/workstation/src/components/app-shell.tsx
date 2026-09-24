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
 */
import type { DeckCard, TileSpec } from '@agentsws/deck'
import { useQuery } from '@tanstack/react-query'
import {
  BookOpen,
  Bot,
  Briefcase,
  Building2,
  CalendarDays,
  ChevronDown,
  ChevronRight,
  Command as CommandIcon,
  Crown,
  Headset,
  Home,
  Inbox,
  ListTodo,
  type LucideIcon,
  Megaphone,
  MessageSquare,
  MessagesSquare,
  Plug,
  Settings,
  Sparkles,
  Store,
  Users,
} from 'lucide-react'
import { type ReactNode, useCallback, useState } from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import { AccountBlock } from '@/components/account-block'
import { BrandSwitcher } from '@/components/brand-switcher'
import { CommandPalette } from '@/components/command-palette'
import { BrandMark } from '@/components/design'
import { NoModelBanner } from '@/components/models/no-model-banner'
import { RailStateProvider } from '@/components/rail/rail-state'
import { RightRail } from '@/components/rail/right-rail'
// WP60（48 L6）：值守中的角标。自带数据，顶栏这里只有一行
import { SceneSwitcher } from '@/components/scene-switcher'
import { StandbyBadge } from '@/components/standby-badge'
import { CreditsChip, ModelChip } from '@/components/top-chips'
import { DemoBadge } from '@/components/ui/demo-badge'
import { Separator } from '@/components/ui/separator'
import {
  listMessageAccounts,
  type Me,
  type PositionInstanceData,
  type PositionSummary,
} from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { holdsDuty } from '@/lib/pick-assignment'
import { myAssignments } from '@/lib/positions'
import { RAIL_EXPANDED_KEY, readFlags, writeFlags } from '@/lib/ui-state'
import { cn } from '@/lib/utils'

/**
 * 左栏一行。
 *
 * WP96（09-18 画布）：圆角从 6 提到 10、行高从 1.5 提到 2，选中态是**浅品牌底 +
 * 品牌深色字**（`--sidebar-accent` / `--sidebar-accent-foreground` 已经指到
 * tint / brand-ink 上），不再是灰底。结构一个字没动。
 */
function navClass({ isActive }: { isActive: boolean }): string {
  return cn(
    'flex items-center gap-2.5 rounded-[10px] px-2.5 py-2 text-[13.5px] transition-colors',
    // 选中态图标跟文字同色（`[&_svg]:text-current`），未选中时图标压成 muted。
    isActive
      ? 'bg-sidebar-accent text-sidebar-accent-foreground font-medium [&_svg]:text-current'
      : 'hover:bg-sidebar-accent/60 [&_svg]:text-ws-muted-fg',
  )
}

/**
 * 岗位图标按职责挑：客服 / 运营 / 投放 / 所有者各有专属，其余落到 Briefcase。
 * 认不出的 role_id 一律 Briefcase——图标是提示，不是分类学。
 */
function positionIcon(role_id: string): LucideIcon {
  if (role_id.endsWith('.aftersales')) return Headset
  if (role_id.endsWith('.ops')) return Store
  if (role_id.startsWith('ads.')) return Megaphone
  if (role_id === 'common.owner') return Crown
  return Briefcase
}

/** 侧栏图标统一 16px；颜色交给 `navClass` 里的 `[&_svg]` 规则。 */
function NavIcon({ icon: Icon }: { icon: LucideIcon }): ReactNode {
  return <Icon aria-hidden className="size-4 shrink-0" />
}

/** 职责页的地址：`/positions/<本人在这条职责上的分配>/duties/<role_id>`。 */
export function dutyHref(assignment_id: string, role_id: string): string {
  return `/positions/${encodeURIComponent(assignment_id)}/duties/${encodeURIComponent(role_id)}`
}

/**
 * 左栏「岗位」那一栏的一行：一个岗位（WP70），行首一个展开箭头（WP71）。
 *
 * 待审数按岗位聚合（"网站运营 3"）——点进去才看得到是哪条职责的（54 §4）。
 * 地址用本人在这个岗位下的第一条分配（36 §3 的"岗位"= 一条 Assignment）。
 *
 * 展开层里只列**本人持有**的职责：别人那条分配不能拿来开事（54 §2 / WP69），
 * 列出来只会让人点进一个进不去的页面。
 */
function PositionNav({
  instance,
  open,
  onToggle,
}: {
  instance: PositionInstanceData
  open: boolean
  onToggle: () => void
}): ReactNode {
  const { lang, t } = useApp()
  const first = myAssignments(instance)[0]
  if (first === undefined) return null
  const name = lang === 'en' ? instance.name.en : instance.name.zh
  const duties = instance.roles.filter((r) => r.my_assignment_id !== undefined)
  return (
    <div data-testid="nav-position-row" data-position={instance.position_id}>
      <div className="flex items-center">
        <button
          type="button"
          aria-expanded={open}
          aria-label={t('rail.expand', { name })}
          data-testid="nav-position-toggle"
          className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground"
          onClick={onToggle}
        >
          {open ? (
            <ChevronDown aria-hidden className="size-3.5" />
          ) : (
            <ChevronRight aria-hidden className="size-3.5" />
          )}
        </button>
        <NavLink
          to={`/positions/${first}`}
          className={({ isActive }) => cn(navClass({ isActive }), 'min-w-0 flex-1')}
          data-testid="nav-position"
          data-position={instance.position_id}
        >
          <NavIcon icon={positionIcon(instance.roles[0]?.role_id ?? '')} />
          <span className="truncate">{name}</span>
          {instance.pending_cards === 0 ? null : (
            <span
              className="ml-auto shrink-0 rounded bg-muted px-1.5 py-0.5 text-[11px] tabular-nums"
              data-testid="nav-position-pending"
              title={t('home.positions.cards', { count: instance.pending_cards })}
            >
              {instance.pending_cards}
            </span>
          )}
        </NavLink>
      </div>
      {open && duties.length > 0 ? (
        <ul className="ml-5 flex flex-col gap-0.5 border-l pl-2" data-testid="nav-duties">
          {duties.map((r) => (
            <li key={r.role_id} data-duty={r.role_id}>
              <NavLink
                to={dutyHref(r.my_assignment_id ?? '', r.role_id)}
                className={navClass}
                data-testid="nav-duty"
              >
                <span className="truncate text-[13px]">{r.role_name}</span>
              </NavLink>
            </li>
          ))}
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
  if (unread === 0) return null
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
  const [paletteOpen, setPaletteOpen] = useState(false)
  /** 现在开着的是首次设置向导吗（顶栏那条「还没接模型」在向导期间不出，70 §2.2）。 */
  const onboarding = useLocation().pathname === '/onboarding'
  // 岗位面装着就按岗位列；没装（或一个岗位都算不出来）退回老样子
  const byPosition = (instances ?? []).filter((p) => myAssignments(p).length > 0)
  // WP71：只存"用户显式点过的那几个"，没点过的按"当前岗位默认展开"算
  const [flags, setFlags] = useState<Record<string, boolean>>(() => readFlags(RAIL_EXPANDED_KEY))
  const current = byPosition.find((p) => myAssignments(p).includes(position ?? ''))

  const toggle = useCallback((position_id: string, wasOpen: boolean) => {
    setFlags((prev) => {
      const next = { ...prev, [position_id]: !wasOpen }
      writeFlags(RAIL_EXPANDED_KEY, next)
      return next
    })
  }, [])

  return (
    <RailStateProvider>
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
            这里用的是**静态**那一姿态：一直在动的 logo 是噪音，不是品牌。
          */}
          <div className="px-2 pt-1 pb-4">
            <NavLink
              to="/"
              end
              aria-label={t('app.title')}
              data-testid="brand-home"
              className="inline-flex items-center gap-2 rounded-[10px] outline-offset-4"
            >
              <BrandMark size={24} />
              <span className="ws-display text-[14px]">Agents 工坊</span>
            </NavLink>
          </div>
          <nav
            className="flex flex-1 flex-col gap-0.5 overflow-y-auto"
            aria-label={t('nav.main')}
            data-testid="main-nav"
          >
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
              WP139（docs/78 阻断 #2 第 4 条）：**聊天窗的常驻入口**。以前只能从「网站在线客服」
              那条职责的面板进，而那块面板一被「还没分配范围」挡住，全站就没有路通到 /chat-window。
              放在「消息」正下面：网站访客的对话也是消息，左栏是"去哪儿"（36 §9）。
              只在名下有这条职责时出现——没有它，这一格点进去也什么都做不了。
            */}
            {holdsDuty(me?.assignments ?? [], 'dtc.live-chat') ? (
              <NavLink to="/chat-window" className={navClass} data-testid="nav-chat-window">
                <NavIcon icon={MessagesSquare} />
                {t('nav.chat_window')}
              </NavLink>
            ) : null}
            {/* 37 工作模型：待办 / 日历 */}
            <NavLink to="/todos" className={navClass}>
              <NavIcon icon={ListTodo} />
              {t('nav.todos')}
            </NavLink>
            <NavLink to="/calendar" className={navClass}>
              <NavIcon icon={CalendarDays} />
              {t('nav.calendar')}
            </NavLink>
            <div className="px-2.5 pt-4 pb-1.5 text-[11px] tracking-wider text-ws-muted-fg uppercase">
              {t('nav.positions')}
            </div>
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
                    />
                  )
                })
              : positions.map((p) => (
                  <NavLink
                    key={p.position_id}
                    to={`/positions/${p.position_id}`}
                    className={navClass}
                    data-testid="nav-position"
                  >
                    <NavIcon icon={positionIcon(p.role_id)} />
                    <span className="truncate">{p.role_name}</span>
                  </NavLink>
                ))}
            <Separator className="my-2" />
            {/* 41 §1：每人自带的个人代理——问别人的代理、管自己的 profile 与日程 */}
            <NavLink to="/secretary" className={navClass}>
              <NavIcon icon={Bot} />
              {t('nav.secretary')}
            </NavLink>
            <NavLink to="/meetings" className={navClass}>
              <NavIcon icon={Users} />
              {t('nav.meetings')}
            </NavLink>
            <NavLink to="/knowledge" className={navClass}>
              <NavIcon icon={BookOpen} />
              {t('nav.knowledge')}
            </NavLink>
            <NavLink to="/skills" className={navClass}>
              <NavIcon icon={Sparkles} />
              {t('nav.skills')}
            </NavLink>
            {/* WP28 制度面：岗位 / 成员 / 职责（谁在做什么、能做到哪一步） */}
            <NavLink to="/org" className={navClass}>
              <NavIcon icon={Building2} />
              {t('nav.org')}
            </NavLink>
            <NavLink to="/connections" className={navClass}>
              <NavIcon icon={Plug} />
              {t('nav.connections')}
            </NavLink>
            {/* WP85（54 §5）：微信 / 企业微信——把代理接到聊天软件上 */}
            <NavLink to="/im-channels" className={navClass}>
              <NavIcon icon={MessageSquare} />
              {t('nav.im')}
            </NavLink>
            <NavLink to="/settings" className={navClass}>
              <NavIcon icon={Settings} />
              {t('nav.settings')}
            </NavLink>
          </nav>
          {/*
          WP71（36 §10）：品牌与账号在**最下面**。
          个人用户（一个人一个品牌）看不到品牌切换器，那一块自己不渲染（52 O1）。
        */}
          <div
            className="mt-2 flex flex-col gap-1 border-t border-ws-line pt-2"
            data-testid="rail-bottom"
          >
            <BrandSwitcher />
            {/* WP136（docs/79）：账户块上方一行「场景」——切到 dsh 的其他场景（只有所有者看得到） */}
            <SceneSwitcher />
            <AccountBlock {...(me === undefined ? {} : { me })} />
          </div>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          {/*
            WP96：顶栏还是那几样（⌘K / 模型 / 积分），只是换成纸底 + 一条浅线，
            并且 ⌘K 做成画布上那个"交给某个岗位一件事…"的长条搜索框样子。
          */}
          <header className="flex items-center justify-end gap-2 border-b border-ws-line bg-ws-paper px-5 py-2.5">
            {/* WP125（本单交付 4）：合成世界的「演示数据」标记——不显眼但始终在 */}
            <DemoBadge />
            <StandbyBadge />
            <button
              type="button"
              onClick={() => {
                setPaletteOpen(true)
              }}
              aria-label="命令面板 (⌘K)"
              data-testid="top-command"
              className="flex h-9 w-full max-w-[280px] items-center gap-2 rounded-[10px] bg-ws-card px-3 text-[13px] text-ws-muted-fg shadow-ws transition-shadow hover:shadow-ws-hover"
            >
              <CommandIcon aria-hidden className="size-4" />
              <span className="truncate">{t('nav.command')}</span>
              <span className="ws-num ml-auto hidden text-[11px] sm:inline">⌘K</span>
            </button>
            {/* WP71：顶栏只剩这两个数——现在用哪个模型、还剩多少积分（问不到就不出） */}
            {/*
              WP98（09-18 收口）：「还没接模型」原来是首页第一屏一整条黄条。
              它说的是**整个工作区的状态**，不是今天的哪一件事——所以它和模型 / 积分
              是同一类东西，收进顶栏当一个黄色小胶囊，第一屏还给岗位卡。
            */}
            {/*
              WP121b（70 §2.2 末段）：**向导期间这条不出**。向导第 ① 步问的就是
              "用哪个 AI"，同一屏上再顶一条黄条等于同一句话说两遍。走完向导
              （包括走了演示旁路那条路）之后它照常出现——那时它才是一条新消息。
            */}
            {onboarding ? null : <NoModelBanner variant="chip" />}
            <ModelChip />
            <CreditsChip />
          </header>
          <main className="min-w-0 flex-1 bg-ws-paper p-4 md:p-7">{children}</main>
        </div>

        {/* 36 §9 第三栏：默认收成 44px 图标轨，一次开一个面板 */}
        <RightRail {...(instances === undefined ? {} : { instances })} />

        <CommandPalette
          open={paletteOpen}
          onOpenChange={setPaletteOpen}
          positions={positions}
          {...(instances === undefined ? {} : { instances })}
          cards={cards}
          tileLibrary={tileLibrary}
          onAddTile={onAddTile}
        />
      </div>
    </RailStateProvider>
  )
}
