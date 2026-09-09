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
import type { CalendarItem, GoalProgress, Todo } from '@agentsws/contracts'
import type { DeckCard, RangeName } from '@agentsws/deck'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlarmClock, CalendarDays, CheckSquare, Clock, ListTodo, Users } from 'lucide-react'
import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
// WP21 交付后把下面这行换成：import { DeckSection } from '@/components/deck'
import { DeckSection } from '@/components/deck-section'
import { StatTileView } from '@/components/stat-tile'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { type DecideInput, decide, getHome } from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { daysLeftLabel, hhmm, matterUrl, todoUrl } from '@/lib/work'

const RANGES: RangeName[] = ['yesterday', 'last_7d']

const SOURCE_ICON = {
  meeting: Users,
  todo: CheckSquare,
  scheduled_task: AlarmClock,
  card_due: ListTodo,
} as const

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

export function HomePage(): React.ReactNode {
  const { t } = useApp()
  const client = useQueryClient()
  const navigate = useNavigate()
  const [range, setRange] = useState<RangeName>('yesterday')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [pendingId, setPendingId] = useState<string | null>(null)

  const home = useQuery({ queryKey: ['home', range], queryFn: () => getHome(range) })

  const mutation = useMutation({
    mutationFn: (input: { card: DeckCard; body: DecideInput }) =>
      decide(input.card.id, input.body, input.card.position_id),
    onMutate: (input) => {
      setPendingId(input.card.id)
      setErrors((prev) => {
        const next = { ...prev }
        delete next[input.card.id]
        return next
      })
    },
    onError: (error, input) => {
      setErrors((prev) => ({ ...prev, [input.card.id]: error.message }))
    },
    onSettled: () => {
      setPendingId(null)
      void client.invalidateQueries({ queryKey: ['home'] })
      void client.invalidateQueries({ queryKey: ['cards'] })
    },
  })

  const onDecide = (card: DeckCard, body: DecideInput): void => {
    mutation.mutate({ card, body })
  }

  if (home.isPending) return <Skeleton className="h-64 w-full" />
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
      {/* ① 目标进度 */}
      {goals.length === 0 ? null : (
        <section data-testid="goals">
          <div className="mb-2 flex items-center justify-between gap-2">
            <h2 className="text-sm font-medium">{t('home.goals')}</h2>
            <Button size="xs" variant="ghost" asChild>
              <Link to="/goals">{t('home.tiles.more')}</Link>
            </Button>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {goals.map((goal) => (
              <GoalRow key={goal.goal_id} goal={goal} />
            ))}
          </div>
        </section>
      )}

      {/* 每岗位一条核心数据条（36 §3 保留） */}
      {data.tiles.map((bar) => (
        <section key={bar.position_id} data-testid="tile-bar" data-position={bar.position_id}>
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-medium">{bar.role_name}</h2>
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
                <Link to={`/positions/${bar.position_id}?tab=view`}>{t('home.tiles.more')}</Link>
              </Button>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {bar.tiles.map((tile) => (
              <StatTileView key={tile.id} tile={tile} />
            ))}
          </div>
        </section>
      ))}

      {/* ② 今天：左时间轴 / 右到期清单 */}
      {today === undefined ? null : (
        <section data-testid="today">
          <h2 className="mb-2 text-sm font-medium">{t('home.today')}</h2>
          <div className="grid gap-3 md:grid-cols-2">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-1.5 text-sm">
                  <CalendarDays className="size-4" aria-hidden />
                  {t('home.today.timeline')}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <TodayTimeline items={today.timeline} />
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-1.5 text-sm">
                  <ListTodo className="size-4" aria-hidden />
                  {t('home.today.due')}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <TodayDue todos={today.due.todos} cardsWaiting={today.due.cards_waiting} />
              </CardContent>
            </Card>
          </div>
        </section>
      )}

      {/* 告警仍然单列（06 §1.2 immediate 通知） */}
      {data.alerts.length === 0 ? null : (
        <section data-testid="alerts">
          <h2 className="mb-2 text-sm font-medium">{t('home.alerts')}</h2>
          <DeckSection cards={data.alerts} onDecide={onDecide} busyId={pendingId} errors={errors} />
        </section>
      )}

      {/* ③ 卡片：WP21 的 deck */}
      <section data-testid="queue">
        <div className="mb-2 flex items-center justify-between gap-2">
          <h2 className="text-sm font-medium">{t('home.deck')}</h2>
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
            <Clock className="size-3" aria-hidden />
            {t('home.estimate', { minutes: data.estimated_minutes })}
          </span>
        </div>
        <DeckSection
          cards={data.queue}
          onDecide={onDecide}
          onOpen={(card) => {
            navigate(matterUrl(card))
          }}
          busyId={pendingId}
          errors={errors}
        />
      </section>

      {/* ④ 复盘 / 战报（没装工作模型的服务进程两个都没有，整段不出） */}
      {data.review === undefined && data.report === undefined ? null : (
        <section data-testid="review">
          <h2 className="mb-2 text-sm font-medium">{t('home.review')}</h2>
          <div className="flex flex-col gap-3">
            {/* 白天是四格战报；晚上有复盘就在下面多几行亮点 */}
            <BattleReportGrid
              report={
                data.review?.cards ??
                data.report ?? { ai_handled: 0, you_handled: 0, auto_sent: 0, blocked: 0 }
              }
            />
            {data.review === undefined ? (
              <p className="text-sm text-muted-foreground">{t('home.review.empty')}</p>
            ) : (
              <ul className="flex flex-col gap-1 text-sm text-muted-foreground">
                {data.review.highlights.map((line) => (
                  <li key={line}>· {line}</li>
                ))}
              </ul>
            )}
          </div>
        </section>
      )}

      {/* 每日摘要（36 §3 保留） */}
      {data.digest === undefined ? null : (
        <section data-testid="digest">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">{t('home.digest')}</CardTitle>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">
              {data.digest.summary}
            </CardContent>
          </Card>
        </section>
      )}
    </div>
  )
}
