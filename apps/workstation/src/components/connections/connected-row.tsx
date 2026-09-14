/**
 * 已连接的一条：身份展示名、状态、凭据存哪、上次测试，加"测试""断开"两个动作。
 *
 * 这里显示的每一样都来自 `GET /v1/connections`——那个响应里**没有凭据**，
 * 所以这个组件不可能把凭据画出来。
 */

import { AlertTriangle, Link2Off, Lock, RefreshCw, Undo2 } from 'lucide-react'
import { BrandIcon } from '@/components/brand-icons'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import type { ConnectionView, DeadLetterView } from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { formatDate } from '@/lib/format'
import { TestResultLine } from './test-result'

export function ConnectedRow({
  connection,
  busy,
  onTest,
  onDisconnect,
  deadLetters = [],
  requeueing,
  onRequeue,
}: {
  connection: ConnectionView
  busy: 'test' | 'remove' | undefined
  onTest: () => void
  onDisconnect: () => void
  /**
   * WP55 / 18 §2.2：这条连接上没进来的那几封信。
   *
   * 09-12 的真账号验收里，三封客户来信死在一个 `canonicalJson` 的 bug 上，修好
   * 之后只能手改 SQLite 才能让它们回到队列——这一行就是那次留下的后置项。
   */
  deadLetters?: readonly DeadLetterView[]
  requeueing?: string
  onRequeue?: (id: string) => void
}): React.ReactNode {
  const { t, lang } = useApp()
  return (
    <li
      data-testid="connection-row"
      data-service={connection.service}
      data-status={connection.status}
      className="flex flex-col gap-2 rounded-lg border p-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        <BrandIcon provider={connection.service} size={16} />
        <span className="text-sm font-medium">{connection.service_label}</span>
        <Badge variant={connection.status === 'active' ? 'secondary' : 'destructive'}>
          {t(`connections.status.${connection.status}`)}
        </Badge>
        <span className="text-xs text-muted-foreground">{connection.alias}</span>
        <div className="ml-auto flex items-center gap-1">
          <Button size="xs" variant="outline" onClick={onTest} disabled={busy !== undefined}>
            <RefreshCw aria-hidden />
            {busy === 'test' ? t('connections.testing') : t('connections.test')}
          </Button>
          <Button
            size="xs"
            variant="destructive"
            onClick={onDisconnect}
            disabled={busy !== undefined}
          >
            <Link2Off aria-hidden />
            {t('connections.disconnect')}
          </Button>
        </div>
      </div>
      {connection.legacy === undefined ? null : (
        <p
          className="flex items-start gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/5 px-2 py-1.5 text-xs text-amber-700 dark:text-amber-400"
          data-testid="connection-legacy"
          data-legacy-kind={connection.legacy.kind}
        >
          <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden />
          <span>
            <strong className="font-medium">{t('connections.legacy')}</strong>
            <span aria-hidden>：</span>
            {connection.legacy.hint}
          </span>
        </p>
      )}
      {connection.identity?.display_name === undefined ? null : (
        <p className="text-xs text-muted-foreground" data-testid="connection-identity">
          {connection.identity.display_name}
        </p>
      )}
      <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <Lock className="size-3" aria-hidden />
        {t(`connections.store.${connection.credential_store}`)}
        <span aria-hidden>·</span>
        {connection.last_tested_at === undefined
          ? t('connections.never_tested')
          : t('connections.last_tested', { at: formatDate(connection.last_tested_at, lang) })}
      </p>
      {connection.last_test === undefined ? null : <TestResultLine result={connection.last_test} />}
      {deadLetters.length === 0 || onRequeue === undefined ? null : (
        <div
          className="flex flex-col gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/5 px-2 py-1.5"
          data-testid="connection-dead-letters"
        >
          <p className="flex items-center gap-1.5 text-xs text-amber-700 dark:text-amber-400">
            <AlertTriangle className="size-3.5 shrink-0" aria-hidden />
            <strong className="font-medium">
              {t('connections.dead_letters', { n: String(deadLetters.length) })}
            </strong>
            <span className="text-muted-foreground">{t('connections.dead_letters.hint')}</span>
          </p>
          <ul className="flex flex-col gap-1">
            {deadLetters.map((d) => (
              <li
                key={d.id}
                data-testid="dead-letter"
                data-dead-letter-id={d.id}
                className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground"
              >
                <span>{d.from ?? d.channel}</span>
                <span aria-hidden>·</span>
                <span>{formatDate(d.at, lang)}</span>
                <span aria-hidden>·</span>
                <span>{d.reason}</span>
                <Button
                  size="xs"
                  variant="outline"
                  className="ml-auto"
                  onClick={() => onRequeue(d.id)}
                  disabled={requeueing !== undefined}
                >
                  <Undo2 aria-hidden />
                  {requeueing === d.id ? t('connections.requeuing') : t('connections.requeue')}
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </li>
  )
}
