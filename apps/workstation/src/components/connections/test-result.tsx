/**
 * 试连结果的人话（36 原则：报错要说"密码不对"，不是 `EAUTH`）。
 *
 * 服务端给的是原因码 + 一句兜底；界面优先按原因码出自己的中文，
 * 认不出来的码才退回服务端那句话——两边都没有时才显示"没连上"。
 */

import { CircleAlert, CircleCheck, CircleHelp } from 'lucide-react'
import type { ConnectTestResult } from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { cn } from '@/lib/utils'

/** 这些原因码前端有自己的中文文案。 */
const KNOWN = new Set([
  'bad_credentials',
  'host_not_found',
  'unreachable',
  'timeout',
  'tls_failed',
  'forbidden',
  'not_found',
  'test_unavailable',
])

export function humanReason(
  t: (key: string) => string,
  result: ConnectTestResult,
): string | undefined {
  if (result.ok) return undefined
  if (result.reason !== undefined && KNOWN.has(result.reason))
    return t(`connections.reason.${result.reason}`)
  return result.detail
}

export function TestResultLine({ result }: { result: ConnectTestResult }): React.ReactNode {
  const { t } = useApp()
  // "还不能自检"不是失败，别涂成红的
  const neutral = !result.ok && result.reason === 'test_unavailable'
  const Icon = result.ok ? CircleCheck : neutral ? CircleHelp : CircleAlert
  return (
    <p
      data-testid="test-result"
      data-ok={result.ok ? 'true' : 'false'}
      data-reason={result.reason ?? ''}
      className={cn(
        'flex items-start gap-1.5 text-xs',
        result.ok
          ? 'text-emerald-700 dark:text-emerald-400'
          : neutral
            ? 'text-muted-foreground'
            : 'text-destructive',
      )}
    >
      <Icon className="mt-px size-3.5 shrink-0" aria-hidden />
      <span>
        {result.ok ? t('connections.test.ok') : neutral ? '' : `${t('connections.test.failed')}：`}
        {humanReason(t, result) ?? ''}
      </span>
    </p>
  )
}
