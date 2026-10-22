/**
 * WP469：清单右边三张小卡（示意稿 `list`）——今天的安排、还没排期的、目标（决策 1525 甲：
 * 目标放这儿一张小卡，「全部目标」进现在的目标页 `?tab=goals`，目标页本身不动）。
 */
import type { CalendarItem, Todo } from '@agentsws/contracts'
import { useQuery } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { SectionHeader, WsCard } from '@/components/design'
import { getCalendar, listGoals } from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { clock, unscheduled } from '@/lib/cal-todo'
import { LAYER_COLOR } from '@/lib/calendar-layers'
import { cn } from '@/lib/utils'

/** 今天这一段（本地零点到明天零点）。 */
function todayRange(now: Date): { from: string; to: string } {
  const from = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const to = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
  return { from: from.toISOString(), to: to.toISOString() }
}

/** 今天的安排只列这几层（定时任务、值守续期是 AI 和账上的事，不进这张卡）。 */
const TODAY_SOURCES = 'todo,meeting,card_due,social_post,kol_deliverable'

export function TodaySchedule({ now }: { now: Date }): ReactNode {
  const { t } = useApp()
  const range = todayRange(now)
  const today = useQuery({
    queryKey: ['calendar', 'today', range.from, TODAY_SOURCES],
    queryFn: () => getCalendar(range.from, range.to, TODAY_SOURCES),
    retry: false,
  })
  const items = [...(today.data?.items ?? [])].sort(
    (a, b) => Number(a.all_day) - Number(b.all_day) || Date.parse(a.start) - Date.parse(b.start),
  )
  return (
    <WsCard className="flex flex-col gap-2 p-4" data-testid="caltodo-today">
      <SectionHeader
        title={t('caltodo.side.today')}
        actions={
          <Link to="/planner?view=calendar" className="ws-link-muted text-xs">
            {t('caltodo.side.today.go')}
          </Link>
        }
      />
      {items.length === 0 ? (
        <p className="text-[13px] text-ws-faint">{t('caltodo.side.today.empty')}</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {items.slice(0, 6).map((i) => (
            <TodayItem key={i.id} item={i} now={now} />
          ))}
        </ul>
      )}
    </WsCard>
  )
}

function TodayItem({ item, now }: { item: CalendarItem; now: Date }): ReactNode {
  const { t } = useApp()
  const past =
    item.status === 'done' || (!item.all_day && Date.parse(item.end ?? item.start) < now.getTime())
  return (
    <li className="flex items-center gap-2.5 text-[13px]" data-testid="caltodo-today-item">
      <span className="ws-num w-11 shrink-0 text-ws-muted-fg">
        {item.all_day ? t('calendar.all_day') : clock(new Date(item.start))}
      </span>
      <span
        aria-hidden
        className="h-4 w-[3px] shrink-0 rounded-full"
        style={{ background: LAYER_COLOR[item.source] }}
      />
      <span className={cn('min-w-0 truncate', past ? 'text-ws-faint' : 'text-ws-ink')}>
        {item.title}
      </span>
    </li>
  )
}

export function UndatedCard({ open }: { open: readonly Todo[] }): ReactNode {
  const { t } = useApp()
  const u = unscheduled(open)
  return (
    <WsCard className="flex flex-col gap-1.5 p-4" data-testid="caltodo-undated">
      <SectionHeader
        title={t('caltodo.rail.title')}
        count={u.week.length + u.later.length}
        actions={
          <Link to="/planner?view=calendar" className="ws-link-muted text-xs">
            {t('caltodo.side.undated.go')}
          </Link>
        }
      />
      <p className="ws-num text-[13px] text-ws-muted-fg">
        {t('caltodo.side.undated.line', { week: u.week.length, later: u.later.length })}
      </p>
    </WsCard>
  )
}

export function GoalsCard(): ReactNode {
  const { t } = useApp()
  const goals = useQuery({ queryKey: ['goals'], queryFn: listGoals, retry: false })
  const progress = goals.data?.progress ?? []
  return (
    <WsCard className="flex flex-col gap-2 p-4" data-testid="caltodo-goals">
      <SectionHeader
        title={t('goals.title')}
        count={progress.length}
        actions={
          <Link
            to="/planner?view=list&tab=goals"
            className="ws-link-muted text-xs"
            data-testid="caltodo-goals-all"
          >
            {t('caltodo.side.goals.all')}
          </Link>
        }
      />
      {progress.length === 0 ? (
        <p className="text-[13px] text-ws-faint">{t('caltodo.side.goals.empty')}</p>
      ) : (
        <ul className="flex flex-col">
          {progress.slice(0, 3).map((p) => {
            const pct = Math.max(0, Math.min(100, p.progress_pct ?? 0))
            return (
              <li
                key={p.goal_id}
                className="flex flex-col gap-1.5 border-t border-ws-line py-2.5 first:border-t-0 first:pt-1"
              >
                <div className="flex items-baseline gap-2 text-[13px]">
                  <span className="min-w-0 flex-1 truncate font-semibold text-ws-ink">
                    {p.title}
                  </span>
                  <span className="ws-num shrink-0 text-xs text-ws-muted-fg">
                    {p.value === undefined
                      ? t('goal.no_data')
                      : `${p.value.toLocaleString()} / ${p.target.toLocaleString()}`}
                  </span>
                </div>
                <div className="h-1 w-full rounded-full bg-ws-surface" aria-hidden>
                  <div
                    className={cn(
                      'h-1 rounded-full',
                      p.status === 'behind' ? 'bg-ws-warn' : 'bg-ws-brand',
                    )}
                    style={{ width: `${pct}%` }}
                  />
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </WsCard>
  )
}
