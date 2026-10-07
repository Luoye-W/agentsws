/**
 * WP247：设置 · 诊断里的「连接器」一块——版本、状态、重启、换回上一版、删除下载
 * （只删我们下载的那份程序；连上的账号在另一个目录里，不动）。
 *
 * 只有本机连接器归工作台管时才出现（桌面版）；Docker / 外部 runtime / 替身那几档这一块不画。
 */
import { useQuery } from '@tanstack/react-query'
import { Plug } from 'lucide-react'
import {
  LocalConnectorLine,
  localBusy,
  useLocalConnectorAction,
} from '@/components/connections/local-connector'
import { Button } from '@/components/ui/button'
import { Hint } from '@/components/ui/hint'
import { getConnectRuntime, type LocalConnectorAction } from '@/lib/api'
import { useApp } from '@/lib/app-context'

export function ConnectorDiagnostics({ assignment }: { assignment: string }): React.ReactNode {
  const { t } = useApp()
  const runtime = useQuery({
    queryKey: ['connect-runtime', assignment],
    queryFn: () => getConnectRuntime(assignment),
    retry: false,
    refetchInterval: (q) => (localBusy(q.state.data) ? 1500 : false),
  })
  const act = useLocalConnectorAction(assignment)
  const status = runtime.data
  const local = status?.local
  if (status === undefined || local === undefined) return null

  const button = (action: LocalConnectorAction, label: string, testId: string) => (
    <Button
      size="xs"
      variant="outline"
      data-testid={`connector-diag-${testId}`}
      disabled={act.isPending || local.status === 'downloading'}
      onClick={() => {
        if (action === 'remove' && !globalThis.confirm(t('diagnostics.connector.remove.confirm')))
          return
        act.mutate(action)
      }}
    >
      {label}
    </Button>
  )

  return (
    <section className="flex flex-col gap-1.5" data-testid="connector-diagnostics">
      <h4 className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <Plug className="size-3.5" aria-hidden />
        {t('diagnostics.connector.title')}
        <Hint text={t('diagnostics.connector.hint')} />
      </h4>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span data-slot="status" data-testid="connector-diag-version">
          {local.installed === undefined
            ? t('diagnostics.connector.none')
            : t('diagnostics.connector.version', { v: local.installed })}
        </span>
        {local.status === 'ready' ? (
          <span className="text-emerald-700 dark:text-emerald-400" data-slot="status">
            {t('connections.runtime.ready')}
          </span>
        ) : null}
        {local.installed === undefined ? null : (
          <span className="ml-auto flex flex-wrap gap-1.5">
            {local.update_available
              ? button('install', t('diagnostics.connector.update', { v: local.version }), 'update')
              : null}
            {button('restart', t('diagnostics.connector.restart'), 'restart')}
            {local.previous === undefined
              ? null
              : button(
                  'rollback',
                  t('diagnostics.connector.rollback', { v: local.previous }),
                  'rollback',
                )}
            {button('remove', t('diagnostics.connector.remove'), 'remove')}
          </span>
        )}
      </div>
      {local.status === 'ready' ? null : (
        <LocalConnectorLine status={status} assignment={assignment} />
      )}
      {act.error === null ? null : (
        <p className="text-xs text-destructive" data-slot="status">
          {act.error.message}
        </p>
      )}
    </section>
  )
}
