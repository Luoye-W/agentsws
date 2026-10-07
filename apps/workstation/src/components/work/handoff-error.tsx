/**
 * WP259：「交给它」没交出去时框下那一句人话（含服务端给的那句），不再静默。
 * 与 `handoffErrorText` 同一个口径；几个入口都用它，样子一致。
 */
import { useApp } from '@/lib/app-context'
import { handoffErrorText } from '@/lib/handoff'

export function HandoffError({
  error,
  testId = 'handoff-error',
  className = 'text-xs text-destructive',
}: {
  error: unknown
  testId?: string
  className?: string
}): React.ReactNode {
  const { t } = useApp()
  if (error === null || error === undefined) return null
  return (
    <p role="alert" className={className} data-testid={testId}>
      {handoffErrorText(error, t)}
    </p>
  )
}
