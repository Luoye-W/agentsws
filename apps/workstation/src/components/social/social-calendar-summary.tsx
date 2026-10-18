/**
 * WP419（自查 S9 / U4）：右侧窄栏里的内容日历——七天挤在窄栏里帖子标题竖排、表头看不见。窄栏只放一行
 * 「本周 N 条 · 下一条 周三 09:00」+「在日历里看」（占满中栏的那个日历，带上社媒排期图层）；
 * 要在这里排一条再点「展开」（原来那张周视图，点某一天就能写）。没登记号照旧就地登记。
 */
import { useQuery } from '@tanstack/react-query'
import { CalendarDays } from 'lucide-react'
import { useState } from 'react'
import { CalendarLink } from '@/components/calendar/calendar-link'
import { Button } from '@/components/ui/button'
import { getSocialAccounts, getSocialCalendar, type SocialChannelId } from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { SocialCalendar } from './social-calendar'

const DAY_MS = 86_400_000

/** 「本周 N 条 · 下一条 周三 09:00」那一行（纯函数，好测）。 */
export function calendarSummaryLine(
  cells: readonly { channel: string; scheduled_at: string; status: string }[],
  channel: string,
  now: Date,
  t: (key: string, vars?: Record<string, string | number>) => string,
  lang: 'zh' | 'en',
): string {
  const mine = cells.filter((c) => c.channel === channel)
  const nowMs = now.getTime()
  const week = mine.filter((c) => {
    const at = Date.parse(c.scheduled_at)
    return at >= nowMs - 7 * DAY_MS && at <= nowMs + 7 * DAY_MS
  })
  const next = mine
    .filter((c) => c.status === 'scheduled' && Date.parse(c.scheduled_at) >= nowMs)
    .sort((a, b) => Date.parse(a.scheduled_at) - Date.parse(b.scheduled_at))[0]
  const when =
    next === undefined
      ? undefined
      : new Date(next.scheduled_at).toLocaleString(lang === 'en' ? 'en-US' : 'zh-CN', {
          weekday: 'short',
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        })
  return when === undefined
    ? t('social.summary.count', { n: week.length })
    : t('social.summary.next', { n: week.length, when })
}

export function SocialCalendarSummary(props: {
  assignment: string
  channel: SocialChannelId
  role_id: string
}): React.ReactNode {
  const { t, lang } = useApp()
  const [open, setOpen] = useState(false)
  const accounts = useQuery({
    queryKey: ['social-accounts', props.assignment, props.channel],
    queryFn: () => getSocialAccounts({ channel: props.channel }, props.assignment),
  })
  const cal = useQuery({
    queryKey: ['social-calendar-summary', props.assignment],
    queryFn: () =>
      getSocialCalendar(
        {
          from: new Date(Date.now() - 7 * DAY_MS).toISOString(),
          to: new Date(Date.now() + 14 * DAY_MS).toISOString(),
        },
        props.assignment,
      ),
    enabled: (accounts.data?.rows.length ?? 0) > 0,
    retry: false,
  })
  // 没登记号：照旧（就地登记那一块在完整那张里）
  if (open || (accounts.isSuccess && accounts.data.rows.length === 0))
    return (
      <div className="flex flex-col gap-1.5">
        <SocialCalendar assignment={props.assignment} channel={props.channel} />
        {open ? (
          <Button size="xs" variant="ghost" className="self-start" onClick={() => setOpen(false)}>
            {t('social.summary.collapse')}
          </Button>
        ) : null}
      </div>
    )
  return (
    <div
      className="flex flex-wrap items-center gap-2 text-[13px]"
      data-testid="social-calendar-summary"
    >
      <CalendarDays className="size-4 text-ws-muted-fg" aria-hidden />
      <span className="min-w-0 flex-1 truncate" data-testid="social-calendar-summary-line">
        {calendarSummaryLine(cal.data?.cells ?? [], props.channel, new Date(), t, lang)}
      </span>
      <CalendarLink role_id={props.role_id} />
      <Button
        size="xs"
        variant="ghost"
        onClick={() => setOpen(true)}
        data-testid="social-calendar-expand"
      >
        {t('social.summary.expand')}
      </Button>
    </div>
  )
}
