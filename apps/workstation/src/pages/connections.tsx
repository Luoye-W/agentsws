/**
 * 连接页（WP20）：左栏「连接」指向这里。
 *
 * 三块，从上到下：
 * 1. **连接器状态**——WP210 起平时就一行「✓ 连接器就绪」，细节在问号里，要动手时才多一条；
 * 2. **已连接**——标题是账号本身（邮箱、店名），状态 + 测试 / 断开；没进来的信不在这里
 *    （系统自己按退避重投，放弃的进「设置 → 诊断」）；
 * 3. **可以连接**——每个 provider 一张卡：图标 + 名字 + 问号 + 按钮 + 看教程；安全承诺在
 *    这一节标题旁的问号里说一次。OAuth 类走授权页，表单类走**不经模型的原生表单**。
 * 4. **数据后端**（WP40 / 41 §2.4）——本地 / 接我的云 / 托管三个按钮 + 迁移向导。
 * 5. **搜索数据**（WP155 / docs/81）——官方（用积分）/ 自带 key / 不接。
 *
 * 凭据这条线：值从 `SecureForm` 的 FormData 出来 → `submitConnection` 发出去 → 结束。
 * 这个文件里没有一处把它放进 state、query 缓存、URL 或日志。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link2 } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { BrandScopeNote } from '@/components/brand-scope-note'
import { openExternal } from '@/components/connections/bridge'
// WP119（68）：浏览器插件的配对码与已配清单（只加一节，别处一个字没改）
import { BrowserExtensionSection } from '@/components/connections/browser-extension'
import { ConnectedRow } from '@/components/connections/connected-row'
import { DataBackend } from '@/components/connections/data-backend'
// WP83（54（将改号 55）§4 第一层）：按分类 + 搜索的「添加连接」，默认收起
import { ConnectionDirectorySection } from '@/components/connections/directory'
// WP247：本机连接器按需下载（点了要连接器的卡先问一句；下好、起来之后接着连）
import {
  DownloadConfirm,
  localBusy,
  useLocalConnectorAction,
} from '@/components/connections/local-connector'
// WP216：建站平台的官方 CLI 卡（平台没有 CLI 就不出）
import { PlatformCliCard } from '@/components/connections/platform-cli-card'
import { ProviderCard, type WizardPhase } from '@/components/connections/provider-card'
// WP155（docs/81）：「搜索数据」一行（官方用积分 / 自带 key / 不接）
import { ReadRoutesSection } from '@/components/connections/read-routes'
import { RuntimeBar } from '@/components/connections/runtime-bar'
import { SearchDataSection } from '@/components/connections/search-data'
// WP265：Shopify 卡的「连接 Shopify」一键授权（老的客户端 ID 表单收进卡内「高级」）
import { ShopifyConnect } from '@/components/connections/shopify-connect'
import { Hint } from '@/components/ui/hint'
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
  /** WP25：用户选的那条接法（Shopify 两种）。 */
  auth_option?: string
}

export function ConnectionsPage(): React.ReactNode {
  const { t } = useApp()
  const client = useQueryClient()
  const [params, setParams] = useSearchParams()
  const highlight = params.get('service')

  const [wizard, setWizard] = useState<Wizard | null>(null)
  const [results, setResults] = useState<Record<string, ConnectTestResult>>({})
  const [busyId, setBusyId] = useState<{ id: string; kind: 'test' | 'remove' } | null>(null)
  /** WP247：等连接器下好、起来之后要接着连的那一张（点卡时它还没就绪）。 */
  const [pendingConnect, setPendingConnect] = useState<{
    service: string
    label: string
    auth_option?: string
    confirm: boolean
  } | null>(null)
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
    // WP247：连接器下载中 / 启动中时 1.5 秒问一次（进度条要动、起来了要马上变绿）
    refetchInterval: (q) => (localBusy(q.state.data) ? 1500 : false),
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
    mutationFn: (input: { service: string; auth_option?: string }) =>
      beginConnect(
        input.service,
        input.auth_option === undefined ? {} : { auth_option: input.auth_option },
        ownerId,
      ),
    onSuccess: (result, { service, auth_option }) => {
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
      const chosen = result.secure_form?.auth_option ?? auth_option
      setWizard({
        service,
        phase: 'form',
        request_id: result.request_id,
        ...(result.secure_form === undefined ? {} : { fields: result.secure_form.fields }),
        ...(chosen === undefined ? {} : { auth_option: chosen }),
      })
    },
    onError: (error: Error, { service }) => {
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
    mutationFn: (input: {
      service: string
      request_id?: string
      auth_option?: string
      values: Record<string, string>
    }) =>
      submitConnection(
        input.service,
        {
          fields: input.values,
          ...(input.request_id === undefined ? {} : { request_id: input.request_id }),
          ...(input.auth_option === undefined ? {} : { auth_option: input.auth_option }),
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

  // WP247：连接器刚变成就绪 → 卡上的「先下载」标记跟着变；等着的那一张接着连（只接一次）
  const localStatus = runtime.data?.local?.status
  const localConnector = useLocalConnectorAction(ownerId)
  const lastLocal = useRef(localStatus)
  useEffect(() => {
    if (lastLocal.current !== localStatus && localStatus === 'ready')
      void client.invalidateQueries({ queryKey: ['connect-providers'] })
    lastLocal.current = localStatus
  }, [localStatus, client])
  const beginRef = useRef(begin)
  beginRef.current = begin
  useEffect(() => {
    if (localStatus !== 'ready' || pendingConnect === null || pendingConnect.confirm) return
    setPendingConnect(null)
    beginRef.current.mutate({
      service: pendingConnect.service,
      ...(pendingConnect.auth_option === undefined
        ? {}
        : { auth_option: pendingConnect.auth_option }),
    })
  }, [localStatus, pendingConnect])

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
        {/* WP66（52 O1）：连接按品牌各一份——多品牌时说一句这一页管的是谁 */}
        <BrandScopeNote testId="connections-brand-scope" />
      </header>

      {runtime.data === undefined ? null : (
        <RuntimeBar
          status={runtime.data}
          {...(ownerId === undefined ? {} : { assignment: ownerId })}
        />
      )}
      <DownloadConfirm
        open={pendingConnect?.confirm === true}
        bytes={runtime.data?.local?.download_bytes ?? 0}
        serviceLabel={pendingConnect?.label ?? ''}
        onCancel={() => setPendingConnect(null)}
        onConfirm={() => {
          setPendingConnect((p) => (p === null ? p : { ...p, confirm: false }))
          localConnector.mutate('install')
        }}
      />

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
                  // WP252：「请重新连接」那一行只是提醒，收起它什么都不删，不用确认
                  if (
                    c.brand_conflict?.kind !== 'reconnect' &&
                    !globalThis.confirm(t('connections.disconnect.confirm'))
                  )
                    return
                  setBusyId({ id: c.id, kind: 'remove' })
                  disconnect.mutate(c.id)
                }}
                assignment={ownerId}
              />
            ))}
          </ul>
        )}
      </section>

      {/*
        WP216：建站平台的官方 CLI（Shopify 品牌才有；别的平台服务端回 kit: null，这里什么都不画）。
        排在已连接下面：它和「已连接」是同一类问题——这台电脑上的工具接好了没有。
      */}
      <PlatformCliCard {...(ownerId === undefined ? {} : { assignment: ownerId })} />

      {/*
        WP83（54 §4）：目录二十多条，多数人一辈子只连三四个——所以它默认收起、
        带搜索、按分类分组，而不是铺在首屏把已连的那几条挤下去。
      */}
      <ConnectionDirectorySection {...(ownerId === undefined ? {} : { assignment: ownerId })} />

      <section className="flex flex-col gap-2">
        {/* WP210：安全承诺（密码只输在对方网站上 / 表单不经 AI）在这里说一次，卡上一句不留 */}
        <h3 className="flex items-center gap-1.5 text-sm font-medium">
          {t('connections.available')}
          <Hint text={t('connections.available.hint')} testId="connections-available-hint" />
        </h3>
        <div className="grid gap-3 lg:grid-cols-2">
          {catalog.map((p) => (
            <ProviderCard
              key={p.service}
              provider={p}
              highlighted={highlight === p.service}
              connected={rows.some((c) => c.service === p.service)}
              phase={wizard?.service === p.service ? wizard.phase : 'idle'}
              fields={wizard?.service === p.service ? wizard.fields : undefined}
              result={results[p.service]}
              assignment={ownerId}
              oauthUrl={wizard?.service === p.service ? wizard.authorization_url : undefined}
              {...(p.service === 'shopify_admin'
                ? {
                    oneClick: (
                      <ShopifyConnect
                        {...(ownerId === undefined ? {} : { assignment: ownerId })}
                        onChanged={refresh}
                      />
                    ),
                    advancedLabel: t('shopconnect.advanced'),
                  }
                : {})}
              onStart={(auth_option) => {
                setResults((prev) => {
                  const { [p.service]: _dropped, ...rest } = prev
                  return rest
                })
                // 开始向导就把高亮撤掉，免得跳转来的高亮一直挂着
                if (highlight !== null) setParams({}, { replace: true })
                // WP247：要连接器、它还没就绪——没下载（或下载失败）先问一句；在下 / 在起就排个队
                const local = runtime.data?.local
                if (p.needs_download === true && local !== undefined && local.status !== 'ready') {
                  const idle =
                    local.status === 'not_installed' ||
                    (local.status === 'error' && local.installed === undefined)
                  setPendingConnect({
                    service: p.service,
                    label: p.label,
                    ...(auth_option === undefined ? {} : { auth_option }),
                    confirm: idle,
                  })
                  if (!idle && (local.status === 'stopped' || local.status === 'error'))
                    localConnector.mutate('restart')
                  return
                }
                begin.mutate({
                  service: p.service,
                  ...(auth_option === undefined ? {} : { auth_option }),
                })
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
                  ...(wizard?.auth_option === undefined ? {} : { auth_option: wizard.auth_option }),
                  values,
                })
              }}
            />
          ))}
        </div>
      </section>

      {/* WP155（docs/81）：SEO / GEO 用的搜索数据从哪来 */}
      <SearchDataSection {...(ownerId === undefined ? {} : { assignment: ownerId })} />

      {/* WP246（决策 87 / 88）：取数路线——每个平台首选 → 备选、每级通不通、Reddit 读号 */}
      <ReadRoutesSection {...(ownerId === undefined ? {} : { assignment: ownerId })} />

      {/* WP119（68）：浏览器插件——6 位配对码 + 已配上的那几个浏览器 */}
      <BrowserExtensionSection {...(ownerId === undefined ? {} : { assignment: ownerId })} />

      {/* WP40 / 41 §2.4：数据后端三档（本地 / 接我的云 / 托管）+ 迁移向导 */}
      <DataBackend {...(ownerId === undefined ? {} : { assignment: ownerId })} />
    </div>
  )
}
