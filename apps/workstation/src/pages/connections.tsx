/**
 * 连接页（WP20）：左栏「连接」指向这里。
 *
 * 三块，从上到下：
 * 1. **连接器状态条**——没装 / 没加固 / 就绪，先说清楚这台机器能不能连；
 * 2. **已连接**——身份展示名、状态、上次测试，两个动作：测试、断开；
 * 3. **可以连接**——每个 provider 一张卡，说明要准备什么（≤ 5 步 + 外链），
 *    OAuth 类走授权页，表单类走**不经模型的原生表单**。
 *
 * 凭据这条线：值从 `SecureForm` 的 FormData 出来 → `submitConnection` 发出去 → 结束。
 * 这个文件里没有一处把它放进 state、query 缓存、URL 或日志。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link2 } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { openExternal } from '@/components/connections/bridge'
import { ConnectedRow } from '@/components/connections/connected-row'
import { ProviderCard, type WizardPhase } from '@/components/connections/provider-card'
import { RuntimeBar } from '@/components/connections/runtime-bar'
import { Skeleton } from '@/components/ui/skeleton'
import type { ConnectTestResult, ProviderFieldSpec } from '@/lib/api'
import {
  beginConnect,
  getConnectRuntime,
  getPositions,
  listConnections,
  listProviders,
  pollConnectRequest,
  removeConnection,
  submitConnection,
  testConnection,
} from '@/lib/api'
import { useApp } from '@/lib/app-context'

/** OAuth 轮询：2 秒一次，最多 5 分钟。 */
const POLL_MS = 2000
const POLL_LIMIT = 150

interface Wizard {
  service: string
  phase: WizardPhase
  request_id?: string
  fields?: ProviderFieldSpec[]
  authorization_url?: string
}

export function ConnectionsPage(): React.ReactNode {
  const { t } = useApp()
  const client = useQueryClient()
  const [params, setParams] = useSearchParams()
  const highlight = params.get('service')

  const [wizard, setWizard] = useState<Wizard | null>(null)
  const [results, setResults] = useState<Record<string, ConnectTestResult>>({})
  const [busyId, setBusyId] = useState<{ id: string; kind: 'test' | 'remove' } | null>(null)
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 连接由**工作区所有者**管（05 common.owner 的 authorize_connector）。一个人可能同时
  // 是客服和所有者，网关又是一次请求绑一个 Assignment（31 §3.1），所以这一页显式用
  // 所有者那条，而不是跟着左栏当前选中的岗位走。
  const positions = useQuery({ queryKey: ['positions'], queryFn: getPositions })
  const ownerId = positions.data?.positions.find((p) => p.role_id === 'common.owner')?.position_id
  const ready = positions.data !== undefined && ownerId !== undefined

  const runtime = useQuery({
    queryKey: ['connect-runtime', ownerId],
    enabled: ready,
    queryFn: () => getConnectRuntime(ownerId),
  })
  const providers = useQuery({
    queryKey: ['connect-providers', ownerId],
    enabled: ready,
    queryFn: () => listProviders(ownerId),
  })
  const connections = useQuery({
    queryKey: ['connections', ownerId],
    enabled: ready,
    queryFn: () => listConnections(ownerId),
  })

  const refresh = useCallback((): void => {
    void client.invalidateQueries({ queryKey: ['connections'] })
    void client.invalidateQueries({ queryKey: ['connect-providers'] })
    // 连上 / 断开都会改数据源状态，首页与岗位面板要跟着变
    void client.invalidateQueries({ queryKey: ['home'] })
    void client.invalidateQueries({ queryKey: ['view'] })
  }, [client])

  const stopPolling = useCallback((): void => {
    if (pollTimer.current !== null) {
      clearTimeout(pollTimer.current)
      pollTimer.current = null
    }
  }, [])

  useEffect(() => stopPolling, [stopPolling])

  /** OAuth：起一轮轮询，直到 connected / failed / expired 或者超时。 */
  const startPolling = useCallback(
    (service: string, request_id: string): void => {
      let tries = 0
      const tick = async (): Promise<void> => {
        tries += 1
        try {
          const outcome = await pollConnectRequest(request_id, ownerId)
          if (outcome.status === 'connected') {
            setWizard(null)
            refresh()
            return
          }
          if (outcome.status !== 'initiated') {
            setResults((prev) => ({
              ...prev,
              [service]: {
                ok: false,
                reason: outcome.status,
                detail: t('connections.oauth.failed'),
                checked_at: new Date().toISOString(),
              },
            }))
            setWizard(null)
            return
          }
        } catch {
          // 网络抖一下不该把向导打断，下一轮接着来
        }
        if (tries >= POLL_LIMIT) {
          setWizard(null)
          return
        }
        pollTimer.current = setTimeout(() => void tick(), POLL_MS)
      }
      pollTimer.current = setTimeout(() => void tick(), POLL_MS)
    },
    [ownerId, refresh, t],
  )

  const begin = useMutation({
    mutationFn: (service: string) => beginConnect(service, {}, ownerId),
    onSuccess: (result, service) => {
      if (result.authorization_url !== undefined) {
        openExternal(result.authorization_url)
        setWizard({
          service,
          phase: 'authorizing',
          request_id: result.request_id,
          authorization_url: result.authorization_url,
        })
        startPolling(service, result.request_id)
        return
      }
      setWizard({
        service,
        phase: 'form',
        request_id: result.request_id,
        ...(result.secure_form === undefined ? {} : { fields: result.secure_form.fields }),
      })
    },
    onError: (error: Error, service) => {
      setResults((prev) => ({
        ...prev,
        [service]: { ok: false, detail: error.message, checked_at: new Date().toISOString() },
      }))
    },
  })

  /**
   * 提交表单。`values` 只在这一次调用里存在——不进 state、不进 query key、不进 URL。
   * 失败时只把**错误消息**记进结果，不回显任何用户填的值。
   */
  const submit = useMutation({
    mutationFn: (input: { service: string; request_id?: string; values: Record<string, string> }) =>
      submitConnection(
        input.service,
        {
          fields: input.values,
          ...(input.request_id === undefined ? {} : { request_id: input.request_id }),
        },
        ownerId,
      ),
    onSuccess: (outcome, input) => {
      setResults((prev) => ({ ...prev, [input.service]: outcome.test }))
      setWizard(null)
      refresh()
    },
    onError: (error: Error, input) => {
      setResults((prev) => ({
        ...prev,
        [input.service]: { ok: false, detail: error.message, checked_at: new Date().toISOString() },
      }))
      // 表单留在原地，用户改一改再提交
      setWizard((w) => (w === null ? w : { ...w, phase: 'form' }))
    },
  })

  const runTest = useMutation({
    mutationFn: (id: string) => testConnection(id, ownerId),
    onSettled: () => {
      setBusyId(null)
      void client.invalidateQueries({ queryKey: ['connections'] })
    },
  })

  const disconnect = useMutation({
    mutationFn: (id: string) => removeConnection(id, ownerId),
    onSettled: () => {
      setBusyId(null)
      refresh()
    },
  })

  if (positions.isPending) return <Skeleton className="h-96 w-full" />
  if (!ready) {
    // 不是所有者：老实说清楚，而不是给一页 403
    return (
      <p className="text-sm text-muted-foreground" data-testid="connections-not-owner">
        {t('connections.owner_only')}
      </p>
    )
  }
  if (runtime.isPending || providers.isPending || connections.isPending) {
    return <Skeleton className="h-96 w-full" />
  }

  const rows = connections.data?.connections ?? []
  const catalog = providers.data?.providers ?? []

  return (
    <div className="flex flex-col gap-6" data-testid="connections-page">
      <header className="flex flex-col gap-1">
        <h2 className="flex items-center gap-2 text-base font-semibold">
          <Link2 className="size-4" aria-hidden />
          {t('connections.title')}
        </h2>
        <p className="text-sm text-muted-foreground">{t('connections.subtitle')}</p>
      </header>

      {runtime.data === undefined ? null : <RuntimeBar status={runtime.data} />}

      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-medium">{t('connections.connected')}</h3>
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="connections-empty">
            {t('connections.empty')}
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {rows.map((c) => (
              <ConnectedRow
                key={c.id}
                connection={c}
                busy={busyId?.id === c.id ? busyId.kind : undefined}
                onTest={() => {
                  setBusyId({ id: c.id, kind: 'test' })
                  runTest.mutate(c.id)
                }}
                onDisconnect={() => {
                  if (!globalThis.confirm(t('connections.disconnect.confirm'))) return
                  setBusyId({ id: c.id, kind: 'remove' })
                  disconnect.mutate(c.id)
                }}
              />
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-medium">{t('connections.available')}</h3>
        <div className="grid gap-3 lg:grid-cols-2">
          {catalog.map((p) => (
            <ProviderCard
              key={p.service}
              provider={p}
              highlighted={highlight === p.service}
              phase={wizard?.service === p.service ? wizard.phase : 'idle'}
              fields={wizard?.service === p.service ? wizard.fields : undefined}
              result={results[p.service]}
              oauthUrl={wizard?.service === p.service ? wizard.authorization_url : undefined}
              onStart={() => {
                setResults((prev) => {
                  const { [p.service]: _dropped, ...rest } = prev
                  return rest
                })
                // 开始向导就把高亮撤掉，免得跳转来的高亮一直挂着
                if (highlight !== null) setParams({}, { replace: true })
                begin.mutate(p.service)
              }}
              onCancel={() => {
                stopPolling()
                setWizard(null)
              }}
              onSubmit={(values) => {
                setWizard((w) => (w === null ? w : { ...w, phase: 'saving' }))
                submit.mutate({
                  service: p.service,
                  ...(wizard?.request_id === undefined ? {} : { request_id: wizard.request_id }),
                  values,
                })
              }}
            />
          ))}
        </div>
      </section>
    </div>
  )
}
