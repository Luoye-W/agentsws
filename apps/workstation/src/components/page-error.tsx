/**
 * WP139：一页（或一块）没取回来时的那一格——**一句人话 + 「重试」**。
 *
 * 以前是白底一行红字「出错了：……」，没有出路：限流、网络抖一下、身份不对，
 * 看起来都一样，人只能整页刷新。现在：
 * - 话按错误的种类说（`apiErrorText`：403 没权限 / 501 没装 / 429 太频繁 / 连不上……）；
 * - 给一个「重试」（传了 `onRetry` 才有）；
 * - 它只占主区里的一格，左栏照常在（外壳那一层也用它，见 `App.tsx`）。
 */
import { AlertCircle } from 'lucide-react'
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { useApp } from '@/lib/app-context'
import { apiErrorText, type ErrorTextOverrides } from '@/lib/error-text'

export function PageError({
  error,
  onRetry,
  overrides,
  testid = 'page-error',
  children,
}: {
  error: unknown
  onRetry?: () => void
  overrides?: ErrorTextOverrides
  testid?: string
  /** 话下面的补充（比如「去哪加这条职责」的链接） */
  children?: ReactNode
}): ReactNode {
  const { t } = useApp()
  return (
    <div
      role="alert"
      data-testid={testid}
      className="flex max-w-xl flex-col gap-3 rounded-[10px] border border-ws-line bg-ws-card p-4 text-sm"
    >
      <p className="flex items-start gap-2">
        <AlertCircle aria-hidden className="mt-0.5 size-4 shrink-0 text-destructive" />
        <span data-testid={`${testid}-text`}>{apiErrorText(error, t, overrides)}</span>
      </p>
      {children}
      {onRetry === undefined ? null : (
        <div>
          <Button size="sm" variant="outline" data-testid={`${testid}-retry`} onClick={onRetry}>
            {t('error.retry')}
          </Button>
        </div>
      )}
    </div>
  )
}
