/**
 * WP469：「日历与待办」两面同一种页头——最左边「清单 / 日历」分段（来回切位置不动），后面标题和一句灰字，
 * 右边操作。WP456-T2 的 `PageHeader` 把标题放在最左、分段放在右边，这一页要反过来，所以单独一份，样子照它。
 */
import type { ReactNode } from 'react'

export function CalTodoHead({
  switcher,
  title,
  titleTestId,
  sub,
  actions,
  testId,
}: {
  switcher?: ReactNode
  title: ReactNode
  titleTestId?: string
  sub?: ReactNode
  actions?: ReactNode
  testId?: string
}): ReactNode {
  return (
    <header
      className="flex flex-wrap items-center gap-x-4 gap-y-2"
      data-slot="page-header"
      {...(testId === undefined ? {} : { 'data-testid': testId })}
    >
      {switcher}
      <h1
        className="ws-display text-ws-page text-ws-ink"
        {...(titleTestId === undefined ? {} : { 'data-testid': titleTestId })}
      >
        {title}
      </h1>
      {sub === undefined ? null : (
        <span className="ws-num mt-1 text-ws-ui text-ws-muted-fg" data-testid="caltodo-sub">
          {sub}
        </span>
      )}
      <span className="flex-1" />
      {actions === undefined || actions === null ? null : (
        <div className="flex flex-wrap items-center gap-2">{actions}</div>
      )}
    </header>
  )
}
