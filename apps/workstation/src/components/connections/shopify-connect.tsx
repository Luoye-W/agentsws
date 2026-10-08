/**
 * WP265：连接页 Shopify 卡的「连接 Shopify」一键授权（接私有云 WP263）。
 *
 * 用户没有 IT 知识（Luoye）：不建开发者应用、不填客户端 ID / 密钥。卡上一个主按钮——
 * 店铺域名自动带上（品牌档案 → 建站找到的店 → CLI 店铺清单；都没有才出一格）→ 系统浏览器
 * 打开 Shopify 授权页 → 「在浏览器里点『安装』，回来就好」+ 取消，2 秒问一次 → 连上之后：
 * 店名、域名、能管什么、「测试连接」「断开」；授权失效 / 缺权限给「重新授权」。
 *
 * 点不了的几种照实说一句：没登录 Agents 工坊账号（就地登录）/ 老令牌缺 `store`（WP267：一点「更新授权」
 * 就地补签，成了接着做刚才那一步；云上没这一条才退回就地重新登录）/ 连不上云 / 这家店暂不支持一键授权
 * （等公开应用；老表单在卡下「高级」里）。
 *
 * 这个组件里**没有任何令牌**：店铺令牌只在云上，接口回的也只有店名、域名与权限名。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, CircleCheck, ExternalLink, Loader2, Store } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { CloudAuthForm } from '@/components/cloud/cloud-auth-form'
import { Button } from '@/components/ui/button'
import { Hint } from '@/components/ui/hint'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import {
  ApiClientError,
  disconnectShopifyConnect,
  getShopifyConnect,
  getShopifyConnectAttempt,
  type ShopifyConnectRow,
  type ShopifyConnectTest,
  startShopifyConnect,
  testShopifyConnect,
  upgradeShopifyConnect,
} from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { openExternal } from './bridge'

/** 轮询：2 秒一次，最多 10 分钟（云上那张授权单自己也会过期）。 */
const POLL_MS = 2000
const POLL_LIMIT = 300

type Translate = (key: string, vars?: Record<string, string | number>) => string

/** Shopify 权限名 → 人话（同一样东西读写都有只说名字，只读的标「只看」）。 */
export function scopeWords(scopes: readonly string[], t: Translate): string[] {
  const res = new Map<string, 'read' | 'write'>()
  for (const s of scopes) {
    const m = /^(read|write)_(.+)$/u.exec(s)
    if (m === null) continue
    const op = m[1] as 'read' | 'write'
    const name = m[2] as string
    if (op === 'write' || !res.has(name)) res.set(name, op)
  }
  return [...res].map(([name, op]) => {
    const key = `shopconnect.scope.${name}`
    const label = t(key) === key ? name : t(key)
    return op === 'write' ? label : t('shopconnect.scope.read_only', { name: label })
  })
}

/** 卡上那一行出错 / 没连上的话（按 `details.reason` 说人话）。 */
type Outcome =
  | { kind: 'failed'; message?: string }
  | { kind: 'expired' }
  | { kind: 'unsupported'; message: string }
  | { kind: 'error'; message: string }

export function ShopifyConnect({
  assignment,
  onChanged,
}: {
  assignment?: string
  /** 连上 / 断开之后（首页、岗位面板跟着刷新）。 */
  onChanged?: () => void
}): React.ReactNode {
  const { t } = useApp()
  const client = useQueryClient()
  const key = ['shopify-connect', assignment]
  const view = useQuery({ queryKey: key, queryFn: () => getShopifyConnect(assignment) })
  const [waiting, setWaiting] = useState<{ id: string; url: string; shop: string } | null>(null)
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  /** 手填的域名（`null` = 用自动带上的那家）。 */
  const [typed, setTyped] = useState<string | null>(null)
  const [authOpen, setAuthOpen] = useState(false)
  const [tests, setTests] = useState<Record<string, ShopifyConnectTest>>({})
  /** WP267：撞上「账号授权要更新」时手上正做的那一步（补签成了就接着做）。 */
  const [resume, setResume] = useState<
    { kind: 'start'; shop?: string } | { kind: 'test'; shop: string } | null
  >(null)
  /** WP267：一点补签没成（云上没这一条 / 令牌不认）→ 退回重新登录。 */
  const [upgradeFailed, setUpgradeFailed] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const stop = useCallback((): void => {
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = null
  }, [])
  useEffect(() => stop, [stop])

  const refresh = useCallback((): void => {
    void client.invalidateQueries({ queryKey: ['shopify-connect'] })
    void client.invalidateQueries({ queryKey: ['cloud-account'] })
    onChanged?.()
  }, [client, onChanged])

  const poll = useCallback(
    (id: string): void => {
      let tries = 0
      const tick = async (): Promise<void> => {
        tries += 1
        try {
          const a = await getShopifyConnectAttempt(id, assignment)
          if (a.status === 'connected') {
            setWaiting(null)
            setTyped(null)
            refresh()
            return
          }
          if (a.status === 'failed' || a.status === 'expired') {
            setWaiting(null)
            setOutcome(
              a.status === 'failed'
                ? { kind: 'failed', ...(a.message === undefined ? {} : { message: a.message }) }
                : { kind: 'expired' },
            )
            return
          }
        } catch {
          // 网络抖一下不打断，下一轮接着问
        }
        if (tries >= POLL_LIMIT) {
          setWaiting(null)
          setOutcome({ kind: 'expired' })
          return
        }
        timer.current = setTimeout(() => void tick(), POLL_MS)
      }
      timer.current = setTimeout(() => void tick(), POLL_MS)
    },
    [assignment, refresh],
  )

  const start = useMutation({
    mutationFn: (shop: string | undefined) =>
      startShopifyConnect(shop === undefined ? {} : { shop }, assignment),
    onMutate: () => {
      setOutcome(null)
    },
    onSuccess: (s) => {
      setWaiting({ id: s.attempt_id, url: s.authorize_url, shop: s.shop })
      // 授权页开在系统浏览器里（桌面壳经桥接；浏览器里是新标签页）
      openExternal(s.authorize_url)
      poll(s.attempt_id)
    },
    onError: (err: Error, shop) => {
      if (err instanceof ApiClientError) {
        if (err.reason === 'unsupported') {
          setOutcome({ kind: 'unsupported', message: err.message })
          return
        }
        // 账号 / 动作集 / 连不上：整张卡换状态
        if (
          err.reason === 'not_linked' ||
          err.reason === 'scope_missing' ||
          err.reason === 'offline'
        ) {
          if (err.reason === 'scope_missing')
            setResume({ kind: 'start', ...(shop === undefined ? {} : { shop }) })
          void client.invalidateQueries({ queryKey: ['shopify-connect'] })
          return
        }
      }
      setOutcome({ kind: 'error', message: err.message })
    },
  })

  const test = useMutation({
    mutationFn: (shop: string) => testShopifyConnect(shop, assignment),
    onSuccess: (r) => {
      setTests((prev) => ({ ...prev, [r.shop]: r }))
      void client.invalidateQueries({ queryKey: ['shopify-connect'] })
    },
    onError: (err: Error, shop) => {
      if (err instanceof ApiClientError && err.reason === 'scope_missing') {
        setResume({ kind: 'test', shop })
        void client.invalidateQueries({ queryKey: ['shopify-connect'] })
        return
      }
      setTests((prev) => ({
        ...prev,
        [shop]: { ok: false, shop, message: err.message, checked_at: new Date().toISOString() },
      }))
    },
  })

  /** WP267（决策 208）：一点补签；成了接着做刚才那一步，没成退回重新登录。 */
  const upgrade = useMutation({
    mutationFn: () => upgradeShopifyConnect(assignment),
    onSuccess: () => {
      setUpgradeFailed(false)
      const next = resume
      setResume(null)
      refresh()
      if (next?.kind === 'start') start.mutate(next.shop)
      else if (next?.kind === 'test') test.mutate(next.shop)
    },
    onError: (err: Error) => {
      if (err instanceof ApiClientError && err.reason === 'offline') {
        void view.refetch()
        return
      }
      setUpgradeFailed(true)
      setAuthOpen(true)
    },
  })

  const disconnect = useMutation({
    mutationFn: (shop: string) => disconnectShopifyConnect(shop, assignment),
    onSettled: () => {
      refresh()
    },
  })

  if (view.isPending) return <Skeleton className="h-9 w-full" />
  const data = view.data
  if (data === undefined)
    return (
      <p className="text-xs text-destructive" data-testid="shopconnect-error">
        {view.error instanceof Error ? view.error.message : t('shopconnect.offline')}
      </p>
    )

  const blocked = data.blocked
  if (blocked !== undefined) {
    const relogin = blocked.reason === 'scope_missing'
    return (
      <div className="flex flex-col gap-2" data-testid="shopconnect" data-state={blocked.reason}>
        <p className="flex items-center gap-1.5 text-xs text-ws-muted-fg" data-slot="status">
          <AlertTriangle aria-hidden className="size-3.5 shrink-0 text-amber-500" />
          {t(`shopconnect.${blocked.reason}`)}
        </p>
        {blocked.reason === 'offline' ? (
          <Button
            size="sm"
            variant="outline"
            className="self-start"
            data-testid="shopconnect-retry"
            onClick={() => void view.refetch()}
          >
            {t('shopconnect.retry')}
          </Button>
        ) : authOpen ? (
          <CloudAuthForm
            testPrefix="shopconnect"
            {...(assignment === undefined ? {} : { assignment })}
            {...(relogin ? { refresh: true, initialTab: 'login' as const } : {})}
            {...(data.email === undefined ? {} : { initialEmail: data.email })}
            onDone={() => {
              setAuthOpen(false)
              setUpgradeFailed(false)
              const next = resume
              setResume(null)
              refresh()
              if (next?.kind === 'start') start.mutate(next.shop)
              else if (next?.kind === 'test') test.mutate(next.shop)
            }}
          />
        ) : relogin && !upgradeFailed ? (
          <Button
            size="sm"
            className="self-start"
            data-testid="shopconnect-upgrade"
            disabled={upgrade.isPending}
            onClick={() => upgrade.mutate()}
          >
            {upgrade.isPending ? <Loader2 aria-hidden className="animate-spin" /> : null}
            {t('shopconnect.upgrade')}
          </Button>
        ) : (
          <Button
            size="sm"
            className="self-start"
            data-testid={relogin ? 'shopconnect-relogin' : 'shopconnect-login'}
            onClick={() => {
              setAuthOpen(true)
            }}
          >
            {t(relogin ? 'shopconnect.relogin' : 'shopconnect.login')}
          </Button>
        )}
        {relogin && upgradeFailed ? (
          <p className="text-xs text-ws-muted-fg" data-testid="shopconnect-upgrade-fallback">
            {t('shopconnect.upgrade.fallback')}
          </p>
        ) : null}
      </div>
    )
  }

  const rows = data.connections
  const shop = typed ?? data.suggested_shop ?? ''
  const askShop = typed !== null || data.suggested_shop === undefined
  const busy = start.isPending

  const outcomeLine =
    outcome === null ? null : (
      <p
        className="flex items-start gap-1 text-xs text-destructive"
        data-testid="shopconnect-outcome"
        data-kind={outcome.kind}
      >
        {outcome.kind === 'failed'
          ? t('shopconnect.failed', { message: outcome.message ?? t('shopconnect.failed.default') })
          : outcome.kind === 'expired'
            ? t('shopconnect.expired')
            : outcome.kind === 'unsupported'
              ? t('shopconnect.unsupported')
              : outcome.message}
        {outcome.kind === 'unsupported' ? <Hint text={t('shopconnect.unsupported.hint')} /> : null}
      </p>
    )

  return (
    <div
      className="flex flex-col gap-2"
      data-testid="shopconnect"
      data-state={waiting !== null ? 'waiting' : rows.length > 0 ? 'connected' : 'idle'}
    >
      {rows.map((row) => (
        <ShopRow
          key={row.shop}
          row={row}
          test={tests[row.shop]}
          busy={
            (test.isPending && test.variables === row.shop) ||
            (disconnect.isPending && disconnect.variables === row.shop) ||
            busy
          }
          onTest={() => test.mutate(row.shop)}
          onDisconnect={() => {
            if (!globalThis.confirm(t('shopconnect.disconnect.confirm'))) return
            disconnect.mutate(row.shop)
          }}
          onReauth={() => start.mutate(row.shop)}
        />
      ))}

      {waiting !== null ? (
        <div className="flex flex-col gap-1.5" data-testid="shopconnect-waiting">
          <p className="flex items-center gap-1.5 text-xs text-ws-muted-fg" data-slot="status">
            <Loader2 aria-hidden className="size-3.5 animate-spin" />
            {t('shopconnect.waiting')}
          </p>
          <div className="flex items-center gap-3">
            <a
              href={waiting.url}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex items-center gap-1 text-xs text-primary underline-offset-4 hover:underline"
            >
              {t('shopconnect.open_again')}
              <ExternalLink className="size-3" aria-hidden />
            </a>
            <Button
              size="xs"
              variant="ghost"
              data-testid="shopconnect-cancel"
              onClick={() => {
                stop()
                setWaiting(null)
              }}
            >
              {t('shopconnect.cancel')}
            </Button>
          </div>
        </div>
      ) : rows.length > 0 && typed === null ? (
        <Button
          size="xs"
          variant="ghost"
          className="self-start px-1 text-muted-foreground"
          data-testid="shopconnect-another"
          onClick={() => {
            setTyped('')
          }}
        >
          {t('shopconnect.another')}
        </Button>
      ) : (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            start.mutate(shop.trim() === '' ? undefined : shop.trim())
          }}
        >
          {askShop ? (
            <Input
              value={shop}
              className="h-8 max-w-64 text-xs"
              aria-label={t('shopconnect.shop')}
              placeholder={t('shopconnect.shop.placeholder')}
              data-testid="shopconnect-shop"
              onChange={(e) => {
                setTyped(e.target.value)
              }}
            />
          ) : (
            <span
              className="flex items-center gap-1 text-xs text-ws-muted-fg"
              data-testid="shopconnect-suggested"
            >
              <Store aria-hidden className="size-3.5" />
              {shop}
              <button
                type="button"
                className="text-primary underline-offset-2 hover:underline"
                data-testid="shopconnect-change"
                onClick={() => {
                  setTyped('')
                }}
              >
                {t('shopconnect.shop.change')}
              </button>
            </span>
          )}
          <Button
            size="sm"
            type="submit"
            disabled={busy || shop.trim() === ''}
            data-testid="shopconnect-connect"
          >
            {busy ? <Loader2 aria-hidden className="animate-spin" /> : null}
            {t('shopconnect.connect')}
          </Button>
          <Hint text={t('shopconnect.hint')} testId="shopconnect-hint" />
        </form>
      )}
      {outcomeLine}
    </div>
  )
}

function ShopRow({
  row,
  test,
  busy,
  onTest,
  onDisconnect,
  onReauth,
}: {
  row: ShopifyConnectRow
  test: ShopifyConnectTest | undefined
  busy: boolean
  onTest: () => void
  onDisconnect: () => void
  onReauth: () => void
}): React.ReactNode {
  const { t } = useApp()
  const broken = row.status === 'reauth_required'
  const missing = scopeWords(row.missing_scopes, t)
  const can = scopeWords(row.scopes, t)
  return (
    <div
      className="flex flex-col gap-1 rounded-md border p-2"
      data-testid="shopconnect-row"
      data-shop={row.shop}
      data-status={row.status}
    >
      <p className="flex flex-wrap items-center gap-1.5 text-sm">
        {broken ? (
          <AlertTriangle aria-hidden className="size-4 text-amber-500" />
        ) : (
          <CircleCheck aria-hidden className="size-4 text-primary" />
        )}
        <span className="font-medium">{row.name ?? row.shop}</span>
        {row.name === undefined ? null : (
          <span className="text-xs text-ws-muted-fg">{row.shop}</span>
        )}
        <span className="text-xs text-ws-muted-fg" data-slot="status">
          {broken ? t('shopconnect.reauth.why') : t('shopconnect.connected')}
        </span>
      </p>
      {can.length === 0 ? null : (
        <p className="text-xs text-ws-muted-fg" data-testid="shopconnect-can">
          {t('shopconnect.can', { list: can.join('、') })}
        </p>
      )}
      {missing.length === 0 ? null : (
        <p className="text-xs text-amber-600" data-testid="shopconnect-missing">
          {t('shopconnect.missing', { list: missing.join('、') })}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {broken || missing.length > 0 ? (
          <Button size="xs" data-testid="shopconnect-reauth" disabled={busy} onClick={onReauth}>
            {t('shopconnect.reauth')}
          </Button>
        ) : null}
        <Button
          size="xs"
          variant="outline"
          data-testid="shopconnect-test"
          disabled={busy}
          onClick={onTest}
        >
          {t('shopconnect.test')}
        </Button>
        <Button
          size="xs"
          variant="ghost"
          data-testid="shopconnect-disconnect"
          disabled={busy}
          onClick={onDisconnect}
        >
          {t('shopconnect.disconnect')}
        </Button>
        {test === undefined ? null : (
          <span
            className={test.ok ? 'text-xs text-primary' : 'text-xs text-destructive'}
            data-testid="shopconnect-test-result"
            data-ok={test.ok ? 'true' : 'false'}
          >
            {test.ok
              ? t('shopconnect.test.ok', { name: test.name ?? test.domain ?? test.shop })
              : t('shopconnect.test.fail', { message: test.message ?? '' })}
          </span>
        )}
      </div>
    </div>
  )
}
