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
 * WP456-T6（WP456 §3.8，示意稿 6）：设置 → 账号连接改成**列表**——顶上一个搜索框；「已连接 N」
 * 一张列表组；「常用」一张列表组（店铺、邮箱、Google 三件、Meta 广告这几样，一行一个服务）；最底下一行
 * 「看全部 N 个」展开成全部（连同目录里列表没有的那几条：还没做的、去别的页接的、自定义 MCP）。
 * 原来「添加连接」「可以连接」两个标题说的是同一件事，合成这一张列表；「看全部」从右上角挪到底下。
 *
 * 凭据这条线：值从 `SecureForm` 的 FormData 出来 → `submitConnection` 发出去 → 结束。
 * 这个文件里没有一处把它放进 state、query 缓存、URL 或日志。
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link2, Plug, Search } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { BrandScopeNote } from '@/components/brand-scope-note'
import { openExternal } from '@/components/connections/bridge'
// WP119（68）：浏览器插件的配对码与已配清单（只加一节，别处一个字没改）
import { BrowserExtensionSection } from '@/components/connections/browser-extension'
import { ConnectedRow } from '@/components/connections/connected-row'
import { DataBackend } from '@/components/connections/data-backend'
// WP83（54（将改号 55）§4 第一层）：按分类的目录；WP456-T6 起嵌在列表下面（「看全部」之后）
import {
  ConnectionDirectorySection,
  matches as directoryMatches,
  inCatalog,
} from '@/components/connections/directory'
// WP247：本机连接器按需下载（点了要连接器的卡先问一句；下好、起来之后接着连）
import {
  DownloadConfirm,
  localBusy,
  useLocalConnectorAction,
} from '@/components/connections/local-connector'
// WP216：建站平台的官方 CLI 卡（平台没有 CLI 就不出）
import { PlatformCliCard } from '@/components/connections/platform-cli-card'
import { ProviderCard, providerSub, type WizardPhase } from '@/components/connections/provider-card'
// WP155（docs/81）：「搜索数据」一行（官方用积分 / 自带 key / 不接）
import { ReadRoutesSection } from '@/components/connections/read-routes'
import { RuntimeBar } from '@/components/connections/runtime-bar'
import { SearchDataSection } from '@/components/connections/search-data'
// WP265：Shopify 卡的「连接 Shopify」一键授权（老的客户端 ID 表单收进卡内「高级」）
import { ShopifyConnect } from '@/components/connections/shopify-connect'
import { useConnectAs } from '@/components/connections/use-connect-as'
import { EmptyState, ListGroup, SectionHeader, SkeletonList } from '@/components/design'
import { PrWatchSources, useMonitorAssignment } from '@/components/pr/pr-watch-sources'
import { Hint } from '@/components/ui/hint'
import { Input } from '@/components/ui/input'
import type { ConnectTestResult, ProviderFieldSpec, ProviderView } from '@/lib/api'
import {
  beginConnect,
  getConnectionDirectory,
  getConnectRuntime,
  listConnections,
  listProviders,
  pollConnectRequest,
  removeConnection,
  submitConnection,
  testConnection,
} from '@/lib/api'
import { setConnectionOwnership } from '@/lib/api-peers'
import { useApp } from '@/lib/app-context'
import { useMode } from '@/lib/mode'

/**
 * WP456-T6：「常用」那几样（示意稿 6 的顺序）——店铺、邮箱、Google 三件、Meta 广告。
 * 目录里一个都不认得（第三方装的、测试夹具）时退回目录的前六个。
 */
export const COMMON_SERVICES = ['shopify_admin', 'imap_smtp', 'gmail', 'ga4', 'gsc', 'meta_ads']
const COMMON_FALLBACK = 6

/** 搜索：名字、service id、那一行说明、问号里那一句，空格隔开的每个词都要有。 */
function providerMatches(p: ProviderView, q: string, t: (key: string) => string): boolean {
  const terms = q.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return true
  const line = t(`connections.line.${p.service}`)
  const hay = [p.label, p.service, providerSub(p.service, t) ?? '', line].join(' ').toLowerCase()
  return terms.every((term) => hay.includes(term))
}

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

/**
 * WP356（决策 923）：`embedded` = 设置弹窗里的「账号连接」一节——不画页头，搜索数据 / 取数路线 /
 * 浏览器插件 / 数据后端各归弹窗里自己那一节（数据接口 / 浏览器插件 / 数据与隐私），这里不重复。
 */
export function ConnectionsPage({
  embedded = false,
}: {
  embedded?: boolean
} = {}): React.ReactNode {
  const { t } = useApp()
  const client = useQueryClient()
  const [params, setParams] = useSearchParams()
  const highlight = params.get('service')
  /** WP456-T6：顶上那一个搜索框、底下「看全部」展没展开。 */
  const [query, setQuery] = useState('')
  const [showAll, setShowAll] = useState(false)

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

  // 连接用哪条分配去问：所有者那条；② 里没有就用自己任意一条（`useConnectAs`）
  const { ownerId, asId, pending } = useConnectAs()
  const { mode, t: tm } = useMode()
  const ready = !pending && asId !== undefined

  const runtime = useQuery({
    queryKey: ['connect-runtime', asId],
    enabled: ready,
    queryFn: () => getConnectRuntime(asId),
    // WP247：连接器下载中 / 启动中时 1.5 秒问一次（进度条要动、起来了要马上变绿）
    refetchInterval: (q) => (localBusy(q.state.data) ? 1500 : false),
  })
  const providers = useQuery({
    queryKey: ['connect-providers', asId],
    enabled: ready,
    queryFn: () => listProviders(asId),
  })
  const connections = useQuery({
    queryKey: ['connections', asId],
    enabled: ready,
    queryFn: () => listConnections(asId),
  })
  // WP456-T6：「看全部 N 个」要数目录里列表没有的那几条（同一份缓存，展开后目录那块直接用）
  const directory = useQuery({
    queryKey: ['connection-directory', asId],
    enabled: ready,
    queryFn: () => getConnectionDirectory(asId),
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
          const outcome = await pollConnectRequest(request_id, asId)
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
    [asId, refresh, t],
  )

  const begin = useMutation({
    mutationFn: (input: { service: string; auth_option?: string }) =>
      beginConnect(
        input.service,
        input.auth_option === undefined ? {} : { auth_option: input.auth_option },
        asId,
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
        asId,
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
  const localConnector = useLocalConnectorAction(asId)
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
    mutationFn: (id: string) => testConnection(id, asId),
    onSettled: () => {
      setBusyId(null)
      void client.invalidateQueries({ queryKey: ['connections'] })
    },
  })

  /** WP278（决策 278）：② 里自己接的那条标「个人 / 共用」。 */
  const ownership = useMutation({
    mutationFn: (input: { id: string; personal: boolean }) =>
      setConnectionOwnership(input.id, input.personal ? 'person' : 'workspace', asId),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: ['connections'] })
    },
  })

  const disconnect = useMutation({
    mutationFn: (id: string) => removeConnection(id, asId),
    onSettled: () => {
      setBusyId(null)
      refresh()
    },
  })

  if (pending) return <SkeletonList rows={6} check={false} />
  if (!ready) {
    // 不是所有者：老实说清楚，而不是给一页 403
    return (
      <p className="text-sm text-muted-foreground" data-testid="connections-not-owner">
        {tm('connections.owner_only')}
      </p>
    )
  }
  if (runtime.isPending || providers.isPending || connections.isPending) {
    return <SkeletonList rows={6} check={false} />
  }

  const rows = connections.data?.connections ?? []
  const catalog = providers.data?.providers ?? []
  const catalogServices = new Set(catalog.map((p) => p.service))
  const searching = query.trim() !== ''
  /** 目录里列表没有的那几条（还没做的、去别的页接的、自定义 MCP）。 */
  const extras = (directory.data?.entries ?? []).filter((e) => !inCatalog(e, catalogServices))
  const known = catalog.filter((p) => COMMON_SERVICES.includes(p.service))
  const common = new Set(
    (known.length > 0 ? known : catalog.slice(0, COMMON_FALLBACK)).map((p) => p.service),
  )
  /** 「常用」之外也要露出来的：跳过来要高亮的、正在填表 / 等授权的、刚出了试连结果的。 */
  const pinned = new Set([
    ...(highlight === null ? [] : [highlight]),
    ...(wizard === null ? [] : [wizard.service]),
    ...Object.keys(results),
  ])
  const listed = searching
    ? catalog.filter((p) => providerMatches(p, query, t))
    : showAll
      ? catalog
      : catalog.filter((p) => common.has(p.service) || pinned.has(p.service))
  const total = catalog.length + extras.length
  const extraHits = searching ? extras.filter((e) => directoryMatches(e, query)).length : 0

  return (
    <div className="flex flex-col gap-6" data-testid="connections-page">
      {embedded ? (
        // WP66（52 O1）：连接按品牌各一份——多品牌时说一句这一页管的是谁
        <BrandScopeNote testId="connections-brand-scope" />
      ) : (
        <header className="flex flex-col gap-1">
          <h2 className="flex items-center gap-2 text-ws-title font-semibold">
            <Link2 className="size-4" aria-hidden />
            {t('connections.title')}
          </h2>
          <p className="text-ws-ui text-ws-muted-fg">{t('connections.subtitle')}</p>
          <BrandScopeNote testId="connections-brand-scope" />
        </header>
      )}

      {/* WP456-T6：顶上一个搜索框——搜的是下面整张列表（连同「看全部」里的目录） */}
      <div className="relative">
        <Search
          aria-hidden
          className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ws-faint"
        />
        <Input
          type="search"
          value={query}
          className="pl-9"
          data-testid="connections-search"
          aria-label={t('connections.search')}
          placeholder={t('connections.search')}
          onChange={(e) => {
            setQuery(e.target.value)
          }}
        />
      </div>

      {/* WP416（自查 kol U18）：「开发替身」只在 demo / 开发时出现，对用户没有意义——不出这一行 */}
      {runtime.data === undefined || runtime.data.state === 'stand_in' ? null : (
        <RuntimeBar status={runtime.data} {...(asId === undefined ? {} : { assignment: asId })} />
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

      {searching ? null : (
        <section className="flex flex-col gap-2" data-testid="connections-connected">
          <SectionHeader as="h3" title={t('connections.connected')} count={rows.length} />
          <ListGroup as="ul">
            {rows.length === 0 ? (
              <li className="ws-row">
                <EmptyState
                  icon={Plug}
                  text={t('connections.empty')}
                  data-testid="connections-empty"
                />
              </li>
            ) : (
              rows.map((c) => (
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
                  assignment={asId}
                  {...(mode === 'peers'
                    ? {
                        onPersonal: (personal: boolean) => {
                          ownership.mutate({ id: c.id, personal })
                        },
                      }
                    : {})}
                />
              ))
            )}
          </ListGroup>
        </section>
      )}

      {/*
        WP216：建站平台的官方 CLI（Shopify 品牌才有；别的平台服务端回 kit: null，这里什么都不画）。
        排在已连接下面：它和「已连接」是同一类问题——这台电脑上的工具接好了没有。
      */}
      {ownerId === undefined || searching ? null : <PlatformCliCard assignment={asId} />}

      <section className="flex flex-col gap-2" data-testid="connections-available">
        {/* WP210：安全承诺（密码只输在对方网站上 / 表单不经 AI）在这里说一次，行上一句不留 */}
        <SectionHeader
          as="h3"
          title={
            <>
              {searching
                ? t('connections.found')
                : showAll
                  ? t('connections.all.title')
                  : t('connections.common')}
              <Hint text={t('connections.available.hint')} testId="connections-available-hint" />
            </>
          }
          {...(searching ? { count: listed.length + extraHits } : {})}
        />
        {listed.length === 0 ? (
          extraHits > 0 ? null : (
            <ListGroup>
              <div className="ws-row">
                <EmptyState
                  icon={Search}
                  text={t('connections.directory.no_match')}
                  data-testid="connections-no-match"
                />
              </div>
            </ListGroup>
          )
        ) : (
          <ListGroup data-testid="connections-list">
            {listed.map((p) => (
              <ProviderCard
                key={p.service}
                provider={p}
                highlighted={highlight === p.service}
                connected={rows.some((c) => c.service === p.service)}
                phase={wizard?.service === p.service ? wizard.phase : 'idle'}
                fields={wizard?.service === p.service ? wizard.fields : undefined}
                result={results[p.service]}
                assignment={asId}
                oauthUrl={wizard?.service === p.service ? wizard.authorization_url : undefined}
                {...(p.service === 'shopify_admin'
                  ? {
                      oneClick: (
                        <ShopifyConnect
                          {...(asId === undefined ? {} : { assignment: asId })}
                          onChanged={refresh}
                        />
                      ),
                      advancedLabel: t('shopconnect.advanced'),
                      advancedNote: t('shopconnect.advanced.note'),
                    }
                  : p.service === 'google_alerts'
                    ? // WP386：Google Alerts 能放很多条（信息监控）：汇总一句 + 每条状态 + 贴 RSS
                      { oneClick: <PrWatchCard /> }
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
                  if (
                    p.needs_download === true &&
                    local !== undefined &&
                    local.status !== 'ready'
                  ) {
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
                    ...(wizard?.auth_option === undefined
                      ? {}
                      : { auth_option: wizard.auth_option }),
                    values,
                  })
                }}
              />
            ))}
          </ListGroup>
        )}
      </section>

      {/*
        WP83（54 §4）：目录二十多条，多数人一辈子只连三四个——默认不铺。WP456-T6：搜索时、「看全部」之后
        才出，只列上面那张列表里没有的几条（同一个搜索框管着）。
      */}
      {searching || showAll ? (
        <ConnectionDirectorySection
          {...(asId === undefined ? {} : { assignment: asId })}
          embedded={{ query, catalog: catalogServices }}
        />
      ) : null}
      {searching || (!showAll && total <= listed.length) ? null : (
        <div>
          <button
            type="button"
            className="ws-link-muted text-ws-ui"
            aria-expanded={showAll}
            data-testid="connections-show-all"
            onClick={() => {
              setShowAll((v) => !v)
            }}
          >
            {showAll ? t('connections.all.less') : t('connections.all', { n: total })}
          </button>
        </div>
      )}

      {/* WP155（docs/81）：SEO / GEO 用的搜索数据从哪来 */}
      {ownerId === undefined || embedded ? null : <SearchDataSection assignment={asId} />}

      {/* WP246（决策 87 / 88）：取数路线——每个平台首选 → 备选、每级通不通、Reddit 读号 */}
      {ownerId === undefined || embedded ? null : <ReadRoutesSection assignment={asId} />}

      {/* WP119（68）：浏览器插件——6 位配对码 + 已配上的那几个浏览器 */}
      {ownerId === undefined || embedded ? null : <BrowserExtensionSection assignment={asId} />}

      {/* WP40 / 41 §2.4：数据后端三档（本地 / 接我的云 / 托管）+ 迁移向导 */}
      {ownerId === undefined || embedded ? null : <DataBackend assignment={asId} />}
    </div>
  )
}

/** WP386：连接页那张 Google Alerts 卡里的多条监控源（本人担着「信息监控」才看得到）。 */
function PrWatchCard(): React.ReactNode {
  return <PrWatchSources assignment={useMonitorAssignment()} />
}
