/**
 * 「正在进行」（40 §3.3「看得见谁在做」）。
 *
 * 一条一行：主人、在做什么、开始多久了、几张卡等他定。**没有表格、没有图表**——
 * 首页的规矩（36 §3）。数字全是服务端算好的，前端一个都不算。
 */
import { Clock3 } from 'lucide-react'
import { Link } from 'react-router-dom'
import type { InProgressItem } from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { formatDateTime } from '@/lib/format'

export function InProgressList({
  items,
  emptyKey = 'inprogress.empty',
}: {
  items: InProgressItem[]
  emptyKey?: string
}): React.ReactNode {
  const { t, lang } = useApp()
  if (items.length === 0) return <p className="text-sm text-muted-foreground">{t(emptyKey)}</p>
  return (
    <ul className="flex flex-col gap-1.5" data-testid="inprogress-list">
      {items.map((item) => {
        const href = item.matter_id === undefined ? undefined : `/matters/${item.matter_id}`
        return (
          <li
            key={`${item.kind}:${item.id}`}
            className="flex flex-col gap-0.5 rounded-md border px-2 py-1.5"
            data-testid="inprogress-row"
            data-owner={item.owner}
            data-cards={item.cards}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="truncate text-sm">
                {href === undefined ? (
                  item.title
                ) : (
                  <Link className="hover:underline" to={href}>
                    {item.title}
                  </Link>
                )}
              </span>
              <span className="shrink-0 text-xs font-medium">{item.owner_label}</span>
            </div>
            <p className="flex items-center gap-1 text-xs text-muted-foreground">
              <Clock3 className="size-3" aria-hidden />
              {t('inprogress.since', { at: formatDateTime(item.started_at, lang) })}
              {item.cards > 0 ? `｜${t('inprogress.cards', { count: item.cards })}` : null}
              {item.collaborators.length > 0
                ? `｜${t('inprogress.collaborators', { count: item.collaborators.length })}`
                : null}
            </p>
          </li>
        )
      })}
    </ul>
  )
}
