/**
 * WP74（37 §2.5）：「在日历里看」——从岗位页 / 职责页进日历的那一下。
 *
 * 带着 `?layers=` 过去：从社媒运营的职责页进去，默认看到的是社媒排期与自己的待办，
 * 而不是七层一起糊在一屏上。这不是"另一个日历"——URL 指向的仍然是左栏那一项，
 * 只是**开着的图层**不一样，而且人到了那边随手就能再勾。
 */
import { CalendarDays } from 'lucide-react'
import { Link } from 'react-router-dom'
import { useApp } from '@/lib/app-context'
import { defaultLayersFor, serializeLayers } from '@/lib/calendar-layers'

export function CalendarLink({ role_id }: { role_id?: string }): React.ReactNode {
  const { t } = useApp()
  const layers = serializeLayers(defaultLayersFor(role_id))
  return (
    <Link
      to={`/calendar?layers=${layers}${role_id === undefined ? '' : `&role=${encodeURIComponent(role_id)}`}`}
      data-testid="calendar-link"
      data-layers={layers}
      className="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-muted"
    >
      <CalendarDays className="size-3.5" aria-hidden />
      {t('calendar.open')}
    </Link>
  )
}
