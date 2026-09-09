/**
 * 已连接的一条：身份展示名、状态、凭据存哪、上次测试，加"测试""断开"两个动作。
 *
 * 这里显示的每一样都来自 `GET /v1/connections`——那个响应里**没有凭据**，
 * 所以这个组件不可能把凭据画出来。
 */

import { Link2Off, Lock, RefreshCw } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import type { ConnectionView } from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { formatDate } from '@/lib/format'
import { TestResultLine } from './test-result'

export function ConnectedRow({
  connection,
  busy,
  onTest,
  onDisconnect,
}: {
  connection: ConnectionView
  busy: 'test' | 'remove' | undefined
  onTest: () => void
  onDisconnect: () => void
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
    </li>
  )
}
