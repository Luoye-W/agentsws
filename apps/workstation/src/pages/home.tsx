/**
 * 首页 = 今天（37 §3 第三稿），四段：
 * ① 目标进度        数字块加「目标 / 进度 / 剩余天数」
 * ② 今天            左：时间轴（会议 / 排期待办 / 定时任务）  右：到期清单（待办 + 待我定的卡片数）
 * ③ 卡片            `<DeckSection />`（WP21 交付后换成一次一张的 deck）
 * ④ 复盘 / 战报     晚上是复盘卡；白天是四格战报
 *
 * 硬约束照旧：**首页无图表无表格**（36 §5.2），数字全从服务端来（29 原则 ③），
 * 没有全局聊天框（对话只在卡片指导、问 AI、⌘K、事项页四处）。
 */
import type { CalendarItem, CalendarSource, GoalProgress, Todo } from '@agentsws/contracts'
import type { RangeName } from '@agentsws/deck'
import { useMutation, useQuery } from '@tanstack/react-query'
import {
  Briefcase,
  CalendarDays,
  CheckSquare,
  Clock,
  HandHeart,
  ListTodo,
  type LucideIcon,
  Users,
} from 'lucide-react'
import { useState } from 'react'
import { Link, Navigate, useNavigate } from 'react-router-dom'
import { DeckSection } from '@/components/deck'
import { AlertBlocks, ReportBlocks } from '@/components/deck/panel-blocks'
import { PositionCard, type Tone, WsCard } from '@/components/design'
import { NoModelBanner } from '@/components/models/no-model-banner'
import { StatTileView } from '@/components/stat-tile'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { ClaimPool } from '@/components/work/claim-pool'
import { InProgressList } from '@/components/work/in-progress-list'
import {
  getHome,
  getPositions,
  listInProgress,
  openMatterAtPosition,
  type PositionInstanceData,
} from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { LAYER_ICON } from '@/lib/calendar-layers'
import { daysLeftLabel, hhmm, matterUrl, todoUrl } from '@/lib/work'

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
function PositionCards(): React.ReactNode {
  const { t } = useApp()
  const navigate = useNavigate()
  const positions = useQuery({ queryKey: ['positions'], queryFn: getPositions })
  const instances = positions.data?.instances ?? []
  if (instances.length === 0) return null
  return (
    <section data-testid="position-cards">
      <h2 className="ws-display mb-2.5 text-[17px]">{t('home.positions')}</h2>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {instances.map((p, i) => {
          // 岗位页的地址用的是分配 id（36 §3 的"岗位"）：只能取**本人**那几条里的一条
          const to = p.roles.map((r) => r.my_assignment_id).find((x) => x !== undefined)
          return (
            <div key={p.position_id} data-testid="position-card" data-position={p.position_id}>
              <PositionCard
                icon={<Briefcase className="size-4" aria-hidden />}
                tone={POSITION_TONES[i % POSITION_TONES.length] ?? 'brand'}
                name={p.name.zh}
                pending={p.pending_cards}
                pendingLabel={t('home.positions.pending')}
                line={t('position.counts', {
                  cards: p.pending_cards,
                  matters: p.open_matters,
                })}
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
              />
              {/* 快捷提示排在卡下面：它是"用这条职责开一件事"，不是卡的一部分 */}
              <QuickPrompts position={p} />
            </div>
          )
        })}
      </div>
    </section>
  )
}

/** 默认先露几条；一张卡读不完就等于没有（54 §4 认知成本）。 */
const QUICK_PROMPTS_SHOWN = 3

/**
 * WP84（53 §3 / 54 §1 第 6 行）：岗位卡下面的**快捷提示**，按职责分组。
 *
 * 三条纪律：
 * 1. **不是聊天框**（36 §3：对话入口只有指导 / 问 AI / ⌘K / 事项页）。点一条就是用
 *    这条职责在这个岗位下开一件事，走的还是 54 §2 那个岗位入口
 *    （`entry: 'position'` + `position_template_id`），只是把"该归哪条职责"这件
 *    已经知道的事直接告诉服务端——那句话本来就写在那条职责的 yml 里，让路由再猜一遍
 *    只会猜错。
 * 2. **只用本人那条分配**。没有 `my_assignment_id` 的职责（别人在做、我没有）
 *    连按钮都不出——拿别人那条去开就是借岗位扩权（54 §1 第三条纪律）。
 * 3. **一职责一组、默认只露前 3 条**；一个岗位只有一条职责时连职责名那行小字都不出。
 */
function QuickPrompts({ position }: { position: PositionInstanceData }): React.ReactNode {
  const { t, lang } = useApp()
  const navigate = useNavigate()
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})

  const open = useMutation({
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
    <div className="flex flex-col gap-2 border-t pt-2" data-testid="quick-prompts">
      {groups.map((role) => {
        const prompts = role.quick_prompts ?? []
        const assignment = role.my_assignment_id
        const isOpen = expanded[role.role_id] === true
        const shown = isOpen ? prompts : prompts.slice(0, QUICK_PROMPTS_SHOWN)
        const rest = prompts.length - shown.length
        return (
          <div key={role.role_id} data-testid="quick-prompt-group" data-role={role.role_id}>
            {groups.length === 1 ? null : (
              <p className="mb-1 text-[11px] text-muted-foreground">{role.role_name}</p>
            )}
            <div className="flex flex-wrap gap-1.5">
              {shown.map((q) => (
                <button
                  key={q.id}
                  type="button"
                  className="rounded-full border px-2.5 py-0.5 text-xs hover:bg-accent disabled:opacity-50"
                  data-testid="quick-prompt"
                  data-prompt={q.id}
                  data-kind={q.kind}
                  title={q.prompt}
                  disabled={assignment === undefined || open.isPending}
                  onClick={() => {
                    if (assignment === undefined) return
                    open.mutate({ assignment, role_id: role.role_id, prompt: q.prompt })
                  }}
                >
                  {lang === 'en' ? q.label.en : q.label.zh}
                </button>
              ))}
              {rest <= 0 && !isOpen ? null : (
                <button
                  type="button"
                  className="rounded-full px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground"
                  data-testid="quick-prompt-more"
                  aria-expanded={isOpen}
                  onClick={() => {
                    setExpanded((v) => ({ ...v, [role.role_id]: !isOpen }))
                  }}
                >
                  {isOpen ? t('home.quick.less') : t('home.quick.more', { count: rest })}
                </button>
              )}
            </div>
          </div>
        )
      })}
      <p className="text-[11px] text-muted-foreground">{t('home.quick.hint')}</p>
    </div>
  )
}

/** 七个图层各一个图标（WP74）；与日历页那一列用的是同一张表（`lib/calendar-layers`）。 */
const SOURCE_ICON: Record<CalendarSource, LucideIcon> = LAYER_ICON

/** ① 一个目标：值 / 目标 / 进度 / 剩余天数。没有图表。 */
function GoalRow({ goal }: { goal: GoalProgress }): React.ReactNode {
  const { t } = useApp()
  const pct = goal.progress_pct ?? 0
  return (
    <div
      className="rounded-lg border p-3"
      data-testid="goal-row"
      data-status={goal.status}
      data-goal={goal.goal_id}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate text-sm font-medium">{goal.title}</span>
        <span className="shrink-0 text-xs text-muted-foreground">
          {daysLeftLabel(goal.days_left, t)}
        </span>
      </div>
      <div className="mt-1 flex items-baseline gap-2">
        <span className="text-2xl font-semibold tabular-nums">
          {goal.value === undefined ? '—' : goal.value.toLocaleString()}
        </span>
        <span className="text-xs text-muted-foreground">
          / {goal.target.toLocaleString()} · {t('goal.progress')} {pct}%
        </span>
        {goal.status === 'behind' ? (
          <span className="rounded border border-destructive/30 bg-destructive/10 px-1.5 py-0.5 text-[11px] text-destructive">
            {t('goal.behind')}
          </span>
        ) : null}
      </div>
      {/* 进度条是一条 div，不是图表 */}
      <div className="mt-2 h-1.5 w-full rounded-full bg-muted" aria-hidden>
        <div
          className={
            goal.status === 'behind'
              ? 'h-1.5 rounded-full bg-destructive/60'
              : 'h-1.5 rounded-full bg-primary/70'
          }
          style={{ width: `${Math.min(100, pct)}%` }}
        />
      </div>
    </div>
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
      {/* WP25：没接模型时先说清楚——不然界面看着一切正常，Agent 却跑不起来 */}
      <NoModelBanner />

      {/*
        WP96（09-18 画布《首页 · 新风格》）：一句话开头。
        标题是 Outfit 的大字，下面那行回答"今天还剩多少事"——
        这两行之后才是岗位卡，因为岗位是任务主入口（54）。
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

      {/* ① 目标进度 */}
      {goals.length === 0 ? null : (
        <section data-testid="goals">
          <div className="mb-2.5 flex items-center justify-between gap-2">
            <h2 className="ws-display text-[17px]">{t('home.goals')}</h2>
            <Button size="xs" variant="ghost" asChild>
              <Link to="/goals">{t('home.tiles.more')}</Link>
            </Button>
          </div>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {goals.map((goal) => (
              <GoalRow key={goal.goal_id} goal={goal} />
            ))}
          </div>
        </section>
      )}

      {/* WP69（54 §4）：首页只列**岗位**卡，职责不出现 */}
      <PositionCards />

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
