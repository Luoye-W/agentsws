/**
 * 首页 = 今天。**第一屏照画布《首页 · 新风格》的顺序**（WP98，09-18 收口）：
 *
 * ① 问候          "早上好，王岚" + 一句"今天 N 张卡等你决定，M 件到期"
 * ② 岗位卡一排    岗位是任务主入口（54 §4），所以它紧跟着问候
 * ③ 目标一行      原来那一整块下移到这儿，并折成一行"目标 3 项 · 2 项落后 →"
 * ④ 今天要你决定的 + 右侧「今天的数 / 今天」（两栏，2fr / 1fr）
 * ⑤ 复盘 / 战报
 *
 * 收口只删不加：「还没接模型」那条黄条搬去顶栏当胶囊（不占第一屏），
 * 快捷提示收进岗位卡右上角的 `···`（原来一张卡下面挂一串芯片，四张卡就是一片）。
 *
 * 硬约束照旧：**首页无图表无表格**（36 §5.2），数字全从服务端来（29 原则 ③），
 * 没有全局聊天框（对话只在卡片指导、问 AI、⌘K、事项页四处）。
 */
import type { CalendarItem, CalendarSource, GoalProgress, Todo } from '@agentsws/contracts'
import type { PositionTiles, RangeName } from '@agentsws/deck'
import { useMutation, useQuery } from '@tanstack/react-query'
import {
  Briefcase,
  CalendarDays,
  CheckSquare,
  Clock,
  HandHeart,
  ListTodo,
  type LucideIcon,
  MoreHorizontal,
  Target,
  Users,
} from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link, Navigate, useNavigate } from 'react-router-dom'
import { DeckSection } from '@/components/deck'
import { AlertBlocks, ReportBlocks } from '@/components/deck/panel-blocks'
import { PositionCard, type Tone, WsCard } from '@/components/design'
import { StatTileView } from '@/components/stat-tile'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { ClaimPool } from '@/components/work/claim-pool'
import { InProgressList } from '@/components/work/in-progress-list'
import {
  getHome,
  getPositions,
  listInProgress,
  listMembers,
  openMatterAtPosition,
  type PositionInstanceData,
} from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { LAYER_ICON } from '@/lib/calendar-layers'
import { formatValue } from '@/lib/format'
import type { Lang } from '@/lib/i18n'
import { hhmm, matterUrl, todoUrl } from '@/lib/work'

const RANGES: RangeName[] = ['yesterday', 'last_7d']

/** 岗位卡图标徽的配色：一排四张各不相同，只是分得开，不表示好坏。 */
const POSITION_TONES: Tone[] = ['info', 'good', 'warn', 'bad']

/**
 * WP69（54 §4）：**首页只有岗位，没有职责**。
 *
 * 一个人开着网站运营那四条职责的时候，照分配列就是四张卡（店铺管理 / 内容与博客 /
 * 邮件营销 / 订单履约），而他心里只有一个"网站运营"。所以这里按岗位聚合：
 * 一个岗位一张卡，计数是这个岗位下全部职责加起来的（"网站运营：3 张待审"），
 * 点开才看得到是哪条职责的。
 *
 * 没装岗位面的服务进程没有 `instances`——那时候整块不出，首页退回老样子。
 */
/** 一张卡上那句状态最多摆几个数：三个是一行的量，第四个就换行了。 */
const MAX_STATUS_FACTS = 3

/**
 * WP98：岗位卡中间那句**真状态**。
 *
 * 原来那句是 `position.counts`——"3 张待审 · 2 件在办"。它和卡上那个 28px 的大数字
 * 说的是同一件事，于是一张卡上同一个数印了两遍，而"这个岗位现在到底怎么样"一个字都没有。
 * 现在改成从**岗位面板已经算好的数字块**里抄：客服是"待回复 2 · 24h 回复率 96%"，
 * 网站运营是"改价 1 待审 · 库存告急 3"。
 *
 * 两条纪律：
 * - **一个数都不在这儿算**（29 原则 ③ / 14 §2）：`StatTile` 是服务端算好下发的，
 *   这里只把 `label` 与 `value` 拼成一句话；
 * - **没连上的数据源不出**（`status === 'not_connected'` 的块跳过），一个数都没有的岗位
 *   照实说"还没开工"，不编一句"一切正常"。
 *
 * 首页那份 `tiles` 按**分配 id** 分组（`PositionTiles.position_id` 是 assignment），
 * 而岗位实体的 id 是模板 id——所以这里按这个岗位下全部职责的 `assignment_ids` 去认。
 */
function statusLine(
  position: PositionInstanceData,
  tiles: PositionTiles[],
  lang: Lang,
): string | undefined {
  const mine = new Set(position.roles.flatMap((r) => r.assignment_ids))
  const facts = tiles
    .filter((bar) => mine.has(bar.position_id))
    .flatMap((bar) => bar.tiles)
    .filter((tile) => tile.status === 'ok' && tile.value !== undefined)
    .slice(0, MAX_STATUS_FACTS)
    .map((tile) => `${tile.label} ${formatValue(tile.value, tile.format, lang, tile.currency)}`)
  return facts.length === 0 ? undefined : facts.join(' · ')
}

/**
 * WP98：持有人头像那一排（画布上卡左下角那几个圆头像）。
 *
 * `instances[].holders` 给的是 person id，卡上要的是**展示名**——所以这里拿成员清单
 * 换一次名字（`/v1/workspaces/:id/members` 是既有的读接口，没加路由）。
 * 换不到名字的 person **不画头像**：19 §3 / WP15 那条"先给再脱敏"的反面教训——
 * 与其在卡上印半个 `p_li`，不如那个位置什么都没有。问不到整份清单（403 / 离线）时
 * 一排头像整个不出，卡的其余部分照旧。
 *
 * 成员清单要 `policy:read`，而客服那条分配上没有——所以这里**拿所有者那条分配去问**
 * （与「还没接模型」那条黄条问模型时同一个做法）。不是所有者的人问不到，
 * 那就当作"这一排不归我看"，静静地不画，而不是给他一排点不动的灰头像。
 */
function useHolderNames(workspace_id: string | undefined): Map<string, string> {
  const positions = useQuery({ queryKey: ['positions'], queryFn: getPositions })
  const ownerId = positions.data?.positions.find((p) => p.role_id === 'common.owner')?.position_id
  const members = useQuery({
    queryKey: ['members', workspace_id, ownerId],
    enabled: workspace_id !== undefined && workspace_id !== '' && ownerId !== undefined,
    retry: false,
    queryFn: () => listMembers(workspace_id ?? '', ownerId),
  })
  return useMemo(
    () => new Map((members.data ?? []).map((m) => [m.person_id, m.name])),
    [members.data],
  )
}

function PositionCards({ tiles }: { tiles: PositionTiles[] }): React.ReactNode {
  const { t, lang } = useApp()
  const navigate = useNavigate()
  const positions = useQuery({ queryKey: ['positions'], queryFn: getPositions })
  const instances = positions.data?.instances ?? []
  const names = useHolderNames(instances[0]?.workspace_id)
  if (instances.length === 0) return null
  return (
    <section data-testid="position-cards">
      <h2 className="ws-display mb-2.5 text-[17px]">{t('home.positions')}</h2>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {instances.map((p, i) => {
          // 岗位页的地址用的是分配 id（36 §3 的"岗位"）：只能取**本人**那几条里的一条
          const to = p.roles.map((r) => r.my_assignment_id).find((x) => x !== undefined)
          const holders = p.holders
            .map((id) => ({ id, name: names.get(id) }))
            .filter((h): h is { id: string; name: string } => h.name !== undefined && h.name !== '')
          return (
            <div key={p.position_id} data-testid="position-card" data-position={p.position_id}>
              <PositionCard
                icon={<Briefcase className="size-4" aria-hidden />}
                tone={POSITION_TONES[i % POSITION_TONES.length] ?? 'brand'}
                name={p.name.zh}
                pending={p.pending_cards}
                pendingLabel={t('home.positions.pending')}
                line={statusLine(p, tiles, lang) ?? t('home.positions.idle')}
                holders={holders}
                {...(to === undefined
                  ? {}
                  : {
                      onOpen: () => {
                        navigate(`/positions/${to}`)
                      },
                      onEntry: () => {
                        navigate(`/positions/${to}`)
                      },
                    })}
                entryLabel={t('home.positions.entry')}
                menu={<QuickPromptMenu position={p} />}
              />
            </div>
          )
        })}
      </div>
    </section>
  )
}

/**
 * WP84（53 §3 / 54 §1 第 6 行）+ WP98（09-18 收口）：岗位卡右上角 `···` 里的**快捷提示**。
 *
 * WP84 把它们平铺在岗位卡下面：一个岗位一串芯片，四个岗位就是四串——第一屏一眼看过去
 * 全是小圆角标签，而它们回答的是"我现在想自己起一件事"，不是"今天有什么等我决定"。
 * 09-18 收口把它们折进画布上本来就画着的那个 `···`：**数据与路由一个字没改**，
 * 只是默认不占地方。
 *
 * 三条纪律原样保留：
 * 1. **不是聊天框**（36 §3：对话入口只有指导 / 问 AI / ⌘K / 事项页）。点一条就是用
 *    这条职责在这个岗位下开一件事，走的还是 54 §2 那个岗位入口
 *    （`entry: 'position'` + `position_template_id`），只是把"该归哪条职责"这件
 *    已经知道的事直接告诉服务端——那句话本来就写在那条职责的 yml 里，让路由再猜一遍
 *    只会猜错。
 * 2. **只用本人那条分配**。没有 `my_assignment_id` 的职责（别人在做、我没有）
 *    连按钮都不出——拿别人那条去开就是借岗位扩权（54 §1 第三条纪律）。
 * 3. **一职责一组**；一个岗位只有一条职责时连职责名那行小字都不出。
 */
function QuickPromptMenu({ position }: { position: PositionInstanceData }): React.ReactNode {
  const { t, lang } = useApp()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)

  const openMatter = useMutation({
    mutationFn: (input: { assignment: string; role_id: string; prompt: string }) =>
      openMatterAtPosition(input.assignment, { title: input.prompt, role_id: input.role_id }),
    onSuccess: (out) => {
      navigate(`/matters/${out.matter.id}`)
    },
  })

  const groups = position.roles.filter(
    (r) => r.my_assignment_id !== undefined && (r.quick_prompts ?? []).length > 0,
  )
  if (groups.length === 0) return null

  return (
    <span className="relative inline-flex" data-testid="quick-prompts">
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={t('home.quick.menu')}
        title={t('home.quick.menu')}
        data-testid="quick-prompt-menu"
        className="inline-flex size-6 items-center justify-center rounded-md text-ws-muted-fg hover:bg-ws-surface hover:text-ws-ink"
        onClick={() => {
          setOpen(!open)
        }}
      >
        <MoreHorizontal className="size-4" aria-hidden />
      </button>
      {open ? (
        // 与账号块、品牌切换器同一种朴素下拉：一个按钮 + 一张列表，不引浮层引擎
        <div
          role="menu"
          data-testid="quick-prompt-list"
          className="absolute top-full right-0 z-50 mt-1 flex w-64 flex-col gap-2 rounded-md border bg-popover p-2 shadow-md"
        >
          {groups.map((role) => {
            const assignment = role.my_assignment_id
            return (
              <div key={role.role_id} data-testid="quick-prompt-group" data-role={role.role_id}>
                {groups.length === 1 ? null : (
                  <p className="mb-1 text-[11px] text-muted-foreground">{role.role_name}</p>
                )}
                <div className="flex flex-col">
                  {(role.quick_prompts ?? []).map((q) => (
                    <button
                      key={q.id}
                      type="button"
                      role="menuitem"
                      className="rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent disabled:opacity-50"
                      data-testid="quick-prompt"
                      data-prompt={q.id}
                      data-kind={q.kind}
                      title={q.prompt}
                      disabled={assignment === undefined || openMatter.isPending}
                      onClick={() => {
                        if (assignment === undefined) return
                        setOpen(false)
                        openMatter.mutate({ assignment, role_id: role.role_id, prompt: q.prompt })
                      }}
                    >
                      {lang === 'en' ? q.label.en : q.label.zh}
                    </button>
                  ))}
                </div>
              </div>
            )
          })}
          <p className="text-[11px] text-muted-foreground">{t('home.quick.hint')}</p>
        </div>
      ) : null}
    </span>
  )
}

/** 七个图层各一个图标（WP74）；与日历页那一列用的是同一张表（`lib/calendar-layers`）。 */
const SOURCE_ICON: Record<CalendarSource, LucideIcon> = LAYER_ICON

/**
 * ③ 目标：**折成一行**（WP98，09-18 收口）。
 *
 * 原来这里是一块网格，每个目标一张带进度条的小卡，排在第一屏最上面——于是第一屏
 * 一开始就是几个与"今天要做什么"无关的百分比。目标是**季度尺度**的东西，它该出现在
 * 岗位卡之后，而且只要一行就够："目标 3 项 · 2 项落后 →"；要看细的点进 `/goals`，
 * 那一页本来就在。落后几项从 `status` 数，一个数都不在这儿算（29 原则 ③）。
 */
function GoalsLine({ goals }: { goals: GoalProgress[] }): React.ReactNode {
  const { t } = useApp()
  if (goals.length === 0) return null
  const behind = goals.filter((g) => g.status === 'behind').length
  return (
    <Link
      to="/goals"
      data-testid="goals-line"
      data-behind={behind}
      className="flex w-fit items-center gap-1 text-[13px] text-ws-muted-fg hover:text-ws-ink"
    >
      <Target className="size-3.5" aria-hidden />
      <span>
        {behind === 0
          ? t('home.goals.line', { count: goals.length })
          : t('home.goals.line.behind', { count: goals.length, behind })}
      </span>
      <span aria-hidden>→</span>
    </Link>
  )
}

/** ② 左：今天的时间轴。 */
function TodayTimeline({ items }: { items: CalendarItem[] }): React.ReactNode {
  const { t } = useApp()
  if (items.length === 0)
    return <p className="text-sm text-muted-foreground">{t('home.today.timeline.empty')}</p>
  return (
    <ol className="flex flex-col gap-2" data-testid="today-timeline">
      {items.map((item) => {
        const Icon = SOURCE_ICON[item.source]
        return (
          <li key={item.id} className="flex items-start gap-2 text-sm" data-source={item.source}>
            <span className="w-10 shrink-0 pt-0.5 text-xs tabular-nums text-muted-foreground">
              {item.all_day ? '—' : hhmm(item.start)}
            </span>
            <Icon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
            <span className="min-w-0 flex-1 truncate">{item.title}</span>
            <span className="shrink-0 text-[11px] text-muted-foreground">
              {t(`calendar.source.${item.source}`)}
            </span>
          </li>
        )
      })}
    </ol>
  )
}

/** ② 右：今天的到期清单。 */
function TodayDue({
  todos,
  cardsWaiting,
}: {
  todos: Todo[]
  cardsWaiting: number
}): React.ReactNode {
  const { t } = useApp()
  return (
    <div className="flex flex-col gap-2" data-testid="today-due">
      {todos.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('home.today.due.empty')}</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {todos.map((todo) => {
            const href = todoUrl(todo)
            return (
              <li key={todo.id} className="flex items-center gap-2 text-sm">
                <CheckSquare className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                {href === undefined ? (
                  <span className="truncate">{todo.title}</span>
                ) : (
                  <Link className="truncate hover:underline" to={href}>
                    {todo.title}
                  </Link>
                )}
              </li>
            )
          })}
        </ul>
      )}
      <Link
        to="/todos"
        className="text-xs text-muted-foreground hover:underline"
        data-testid="cards-waiting"
      >
        {t('home.today.cards', { count: cardsWaiting })}
      </Link>
    </div>
  )
}

/** ④ 战报四格（白天）。 */
function BattleReportGrid({
  report,
}: {
  report: { ai_handled: number; you_handled: number; auto_sent: number; blocked: number }
}): React.ReactNode {
  const { t } = useApp()
  const cells = [
    ['ai_handled', report.ai_handled],
    ['you_handled', report.you_handled],
    ['auto_sent', report.auto_sent],
    ['blocked', report.blocked],
  ] as const
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4" data-testid="battle-report">
      {cells.map(([key, value]) => (
        <div key={key} className="rounded-lg border p-3">
          <div className="text-2xl font-semibold tabular-nums">{value}</div>
          <div className="text-xs text-muted-foreground">{t(`report.${key}`)}</div>
        </div>
      ))}
    </div>
  )
}

/**
 * 「正在进行」（40 §3.3）：本岗位 + 相关岗位正在做的事。
 *
 * 自己取数、挂在 `todos` 这把 key 下——WS 一收到 `todo.* / matter.*` 摘要就自动重取。
 */
function InProgressSection(): React.ReactNode {
  const { t } = useApp()
  const board = useQuery({
    queryKey: ['todos', 'in-progress', 'position'],
    queryFn: () => listInProgress('position'),
  })
  if (board.isPending) return <Skeleton className="h-12 w-full" />
  if (board.error !== null)
    return <p className="text-sm text-muted-foreground">{t('inprogress.empty')}</p>
  return <InProgressList items={board.data.items} />
}

export function HomePage(): React.ReactNode {
  const { t } = useApp()
  const navigate = useNavigate()
  const [range, setRange] = useState<RangeName>('yesterday')

  const home = useQuery({ queryKey: ['home', range], queryFn: () => getHome(range) })
  const positions = useQuery({ queryKey: ['positions'], queryFn: getPositions })

  /*
   * WP69（54 §4）：**一个人只有一个岗位时，首页直接就是那个岗位页**。
   *
   * 只有一个岗位的人，首页上那张唯一的岗位卡除了多点一下之外不提供任何信息。
   * 有两个及以上才需要"先选一个"。等岗位清单真回来了才判——还在加载时就跳，
   * 会把"其实有两个岗位"的人也甩进去。
   */
  const instances = positions.data?.instances
  const only = instances?.length === 1 ? instances[0] : undefined
  const onlyTo = only?.roles.map((r) => r.my_assignment_id).find((x) => x !== undefined)

  if (home.isPending) return <Skeleton className="h-64 w-full" />
  if (onlyTo !== undefined) return <Navigate to={`/positions/${onlyTo}`} replace />
  if (home.error !== null) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {t('error.generic')}：{home.error.message}
      </p>
    )
  }
  const data = home.data
  const goals = data.goals ?? []
  const today = data.today

  return (
    <div className="flex flex-col gap-6" data-testid="home">
      {/*
        ① WP96（09-18 画布《首页 · 新风格》）：一句话开头。
        标题是 Outfit 的大字，下面那行回答"今天还剩多少事"——
        这两行之后**紧跟着就是岗位卡**，因为岗位是任务主入口（54）。
        WP98：「还没接模型」那条黄条从这儿搬去了顶栏（`app-shell` 的 `NoModelBanner
        variant="chip"`）——它说的是整个工作区的状态，不占今天这一屏。
      */}
      <header className="flex items-end gap-4" data-testid="home-header">
        <div>
          <h1 className="ws-display text-[30px]">{t('home.headline')}</h1>
          <p className="mt-1 text-[13px] text-ws-muted-fg">
            {t('home.greeting.line', {
              cards: data.counts.total,
              matters: today?.due.todos.length ?? 0,
            })}
          </p>
        </div>
      </header>

      {/* ② WP69（54 §4）：首页只列**岗位**卡，职责不出现 */}
      <PositionCards tiles={data.tiles} />

      {/* ③ 目标：一行（WP98 收口——原来是第一屏最上面那一整块网格） */}
      <GoalsLine goals={goals} />

      {/*
        WP96：下半屏照画布分两栏——
        左 2fr 是"今天要你决定的"（告警 / 报表 / 一副牌 / 复盘），
        右 1fr 是"今天的数"与"今天"。两栏都只是重排，没删任何一段。
      */}
      <div className="grid items-start gap-4 lg:grid-cols-[2fr_1fr]">
        <div className="flex min-w-0 flex-col gap-5">
          {/*
            WP96：**不是卡的那两样**。
            告警块 = 系统卡（06 §1.2 已经走过 immediate 通知），报表块 = 日报 / 检查单。
            两样都不要人决定，所以都不进下面那副 deck；它们引出的决定才出卡。
          */}
          <AlertBlocks
            alerts={data.alerts}
            onOpen={(card) => {
              navigate(matterUrl(card))
            }}
          />
          <ReportBlocks
            reports={data.reports}
            onOpen={(card) => {
              navigate(matterUrl(card))
            }}
          />

          {/* ③ 卡片 deck —— 一次一张（37 §1） */}
          <section data-testid="queue">
            <div className="mb-2.5 flex items-center justify-between gap-2">
              <h2 className="ws-display text-[17px]">{t('home.deck')}</h2>
              <span className="inline-flex items-center gap-1 text-xs text-ws-muted-fg">
                <Clock className="size-3" aria-hidden />
                {t('home.estimate', { minutes: data.estimated_minutes })}
              </span>
            </div>
            <DeckSection
              onOpen={(card) => {
                navigate(matterUrl(card))
              }}
            />
          </section>

          {/* ④ 复盘 / 战报（没装工作模型的服务进程两个都没有，整段不出） */}
          {data.review === undefined && data.report === undefined ? null : (
            <section data-testid="review">
              <h2 className="ws-display mb-2.5 text-[17px]">{t('home.review')}</h2>
              <div className="flex flex-col gap-3">
                {/* 白天是四格战报；晚上有复盘就在下面多几行亮点 */}
                <BattleReportGrid
                  report={
                    data.review?.cards ??
                    data.report ?? { ai_handled: 0, you_handled: 0, auto_sent: 0, blocked: 0 }
                  }
                />
                {data.review === undefined ? (
                  <p className="text-sm text-ws-muted-fg">{t('home.review.empty')}</p>
                ) : (
                  <ul className="flex flex-col gap-1 text-sm text-ws-muted-fg">
                    {data.review.highlights.map((line) => (
                      <li key={line}>· {line}</li>
                    ))}
                  </ul>
                )}
              </div>
            </section>
          )}
        </div>

        <div className="flex min-w-0 flex-col gap-5">
          {/* 每岗位一条核心数据条（36 §3 保留） */}
          {data.tiles.map((bar) => (
            <section key={bar.position_id} data-testid="tile-bar" data-position={bar.position_id}>
              <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2">
                <h2 className="ws-display text-[17px]">{bar.role_name}</h2>
                <div className="flex items-center gap-1">
                  {RANGES.map((r) => (
                    <Button
                      key={r}
                      size="xs"
                      variant={range === r ? 'secondary' : 'ghost'}
                      aria-pressed={range === r}
                      onClick={() => {
                        setRange(r)
                      }}
                    >
                      {t(`range.${r}`)}
                    </Button>
                  ))}
                  <Button size="xs" variant="ghost" asChild>
                    <Link to={`/positions/${bar.position_id}?tab=view`}>
                      {t('home.tiles.more')}
                    </Link>
                  </Button>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                {bar.tiles.map((tile) => (
                  <StatTileView key={tile.id} tile={tile} />
                ))}
              </div>
            </section>
          ))}

          {/* ② 今天：时间轴 + 到期清单 + 正在进行 + 待认领（40 §3.2 / §3.3） */}
          {today === undefined ? null : (
            <section data-testid="today" className="flex flex-col gap-3">
              <h2 className="ws-display text-[17px]">{t('home.today')}</h2>
              <WsCard className="p-4">
                <h3 className="mb-2 flex items-center gap-1.5 text-sm font-medium">
                  <CalendarDays className="size-4" aria-hidden />
                  {t('home.today.timeline')}
                </h3>
                <TodayTimeline items={today.timeline} />
              </WsCard>
              <WsCard className="p-4">
                <h3 className="mb-2 flex items-center gap-1.5 text-sm font-medium">
                  <ListTodo className="size-4" aria-hidden />
                  {t('home.today.due')}
                </h3>
                <TodayDue todos={today.due.todos} cardsWaiting={today.due.cards_waiting} />
              </WsCard>
              <WsCard className="p-4" data-testid="home-inprogress">
                <h3 className="mb-2 flex items-center gap-1.5 text-sm font-medium">
                  <Users className="size-4" aria-hidden />
                  {t('home.inprogress')}
                </h3>
                <InProgressSection />
              </WsCard>
              <WsCard className="p-4" data-testid="home-claim-pool">
                <h3 className="mb-2 flex items-center gap-1.5 text-sm font-medium">
                  <HandHeart className="size-4" aria-hidden />
                  {t('home.claim_pool')}
                </h3>
                <ClaimPool />
              </WsCard>
            </section>
          )}

          {/* 每日摘要（36 §3 保留） */}
          {data.digest === undefined ? null : (
            <section data-testid="digest">
              <WsCard className="p-4">
                <h3 className="mb-1.5 text-sm font-medium">{t('home.digest')}</h3>
                <p className="text-sm text-ws-muted-fg">{data.digest.summary}</p>
              </WsCard>
            </section>
          )}
        </div>
      </div>
    </div>
  )
}
