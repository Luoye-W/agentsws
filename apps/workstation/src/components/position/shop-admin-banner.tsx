/**
 * WP261（决策 175 第 1 步）：岗位页「授权管理商品和页面」那一行——**一句话 + 一个按钮**。
 *
 * 店铺管理 / 整站搭建 / 网页模板所在的岗位才出。顺序与服务端 `shop-auth.ts` 的 `compute` 同一套：
 * 没装 CLI →「一键安装」；不知道是哪家店 → 一格地址；没授权 →「授权管理商品和页面」（起 `store auth`，
 * 浏览器里批准）；等浏览器时转圈 +「没弹出来？」+「取消」；过期 / 被收回 / 缺权限 →「重新授权」并说缺哪项；
 * 授权好了留一行淡色的「已授权 · 到几点 / 会自动续期」，问号里是能做哪几件事。
 *
 * 网页模板所在的岗位上，「装 CLI / 填店铺」由那一行（`SiteThemeBanner`）带着走，这里不重复出。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CheckCircle2, Download, KeyRound, Loader2, Store } from 'lucide-react'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { openExternal } from '@/components/connections/bridge'
import { Button } from '@/components/ui/button'
import { Hint } from '@/components/ui/hint'
import { Input } from '@/components/ui/input'
import {
  cancelShopAdmin,
  getShopAdmin,
  runShopAdmin,
  type ShopAdminView,
  setShopAdminStore,
} from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { formatDateTime } from '@/lib/format'

/** 登记了运营工具的职责（与服务端 `PlatformStoreAdminSpec.scopes_by_role` 同一张表）。 */
export const SHOP_ADMIN_ROLES = ['dtc.store', 'site.shopify-build', 'site.shopify-theme']
/** 有这两条之一的岗位上，「装 CLI / 填店铺」由网页模板那一行带。 */
const THEME_ROLES = ['site.shopify-theme', 'site.builder']

export function ShopAdminBanner({
  duties,
}: {
  duties: readonly { role_id: string; assignment_id: string }[]
}): ReactNode {
  const { t, lang } = useApp()
  const navigate = useNavigate()
  const client = useQueryClient()
  const mine = duties.filter((d) => SHOP_ADMIN_ROLES.includes(d.role_id))
  const roles = [...new Set(mine.map((d) => d.role_id))].sort()
  const assignment = mine[0]?.assignment_id
  const themeHere = duties.some((d) => THEME_ROLES.includes(d.role_id))
  const [store, setStore] = useState('')
  const opened = useRef<string | undefined>(undefined)
  const key = ['shop-admin', assignment ?? '', roles.join(',')]
  const view = useQuery({
    queryKey: key,
    queryFn: () => getShopAdmin(assignment ?? '', roles),
    enabled: assignment !== undefined,
    retry: false,
    refetchInterval: (q) => {
      const v = q.state.data as ShopAdminView | undefined
      return v?.state === 'authorizing' || v?.job?.phase === 'running' ? 1500 : false
    },
  })
  const set = (next: ShopAdminView): void => {
    client.setQueryData(key, next)
  }
  const run = useMutation({
    mutationFn: (action: 'install' | 'authorize') => runShopAdmin(action, assignment ?? '', roles),
    onSuccess: set,
  })
  const cancel = useMutation({
    mutationFn: () => cancelShopAdmin(assignment ?? '', roles),
    onSuccess: set,
  })
  const save = useMutation({
    mutationFn: (raw: string) => setShopAdminStore(raw, assignment ?? '', roles),
    onSuccess: set,
  })
  const v = view.data
  const job = v?.job
  // CLI 自己开不了浏览器时把授权网址打出来：由工作台开一次（同一次授权只开一回）
  useEffect(() => {
    const url = job?.auth_url
    if (v?.state !== 'authorizing' || url === undefined || job?.browser_opened === true) return
    if (opened.current === job?.started_at) return
    opened.current = job?.started_at
    openExternal(url)
  }, [v?.state, job?.auth_url, job?.browser_opened, job?.started_at])

  if (assignment === undefined || v === undefined || !v.applicable || v.state === undefined)
    return null
  if (themeHere && (v.state === 'no_cli' || v.state === 'no_store')) return null

  const scopeWords = (list: readonly string[]): string =>
    list
      .map((s) => t(`shop_admin.scope.${s}`))
      .filter((w, i, all) => !w.startsWith('shop_admin.') && all.indexOf(w) === i)
      .join(lang === 'zh' ? '、' : ', ')
  const hint = <Hint text={t('shop_admin.hint')} />
  const failure =
    job?.phase === 'failed' && job.error !== undefined
      ? job.action === 'install'
        ? t('shop_admin.err.install')
        : t(`shop_admin.err.${job.error.code}`, { list: scopeWords(job.error.missing ?? []) })
      : undefined

  const row = (
    tone: 'info' | 'warn' | 'muted',
    icon: ReactNode,
    text: string,
    action?: ReactNode,
  ): ReactNode => (
    <div className="flex flex-col gap-1" data-testid="shop-admin-banner" data-state={v.state}>
      <div
        className={`flex flex-wrap items-center gap-2 rounded-lg px-3 py-2 text-sm ${
          tone === 'info'
            ? 'bg-ws-info-bg'
            : tone === 'warn'
              ? 'bg-ws-warn-bg'
              : 'px-1 py-0.5 text-xs text-ws-muted-fg'
        }`}
      >
        {icon}
        <span className="min-w-0 flex-1">{text}</span>
        {hint}
        {action}
      </div>
      {failure === undefined ? null : (
        <p role="alert" className="px-1 text-xs text-destructive" data-testid="shop-admin-error">
          {failure}
        </p>
      )}
      {run.error === null ? null : (
        <p role="alert" className="px-1 text-xs text-destructive">
          {run.error.message}
        </p>
      )}
      {save.error === null ? null : (
        <p role="alert" className="px-1 text-xs text-destructive">
          {save.error.message}
        </p>
      )}
    </div>
  )
  /** WP265：云端一键授权那一路的（重新）授权在连接页 Shopify 卡上做，不起 CLI。 */
  const reauthorize = (): void => {
    if (v?.via === 'cloud') navigate('/connections?service=shopify_admin')
    else run.mutate('authorize')
  }
  const authorizeButton = (label: string): ReactNode => (
    <Button
      size="xs"
      className="gap-1"
      disabled={run.isPending}
      onClick={() => reauthorize()}
      data-testid="shop-admin-authorize"
    >
      <KeyRound className="size-3.5" aria-hidden />
      {label}
    </Button>
  )
  const storeIcon = <Store className="size-4 shrink-0 text-ws-info" aria-hidden />

  switch (v.state) {
    case 'no_cli':
      return job?.action === 'install' && job.phase === 'running'
        ? row(
            'info',
            <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden />,
            t('shop_admin.installing'),
          )
        : row(
            'info',
            storeIcon,
            t('shop_admin.no_cli'),
            <Button
              size="xs"
              className="gap-1"
              disabled={run.isPending}
              onClick={() => run.mutate('install')}
              data-testid="shop-admin-install"
            >
              <Download className="size-3.5" aria-hidden />
              {t('shop_admin.install')}
            </Button>,
          )
    case 'no_store':
      return row(
        'info',
        storeIcon,
        t('shop_admin.no_store'),
        <form
          className="flex shrink-0 flex-wrap items-center gap-1.5"
          onSubmit={(e) => {
            e.preventDefault()
            if (store.trim() !== '') save.mutate(store.trim())
          }}
        >
          <Input
            value={store}
            onChange={(e) => setStore(e.target.value)}
            placeholder={t('shop_admin.store.placeholder')}
            className="h-7 w-56 bg-card text-xs"
            aria-label={t('shop_admin.no_store')}
            data-testid="shop-admin-store-input"
          />
          <Button size="xs" type="submit" disabled={save.isPending || store.trim() === ''}>
            {t('shop_admin.store.save')}
          </Button>
        </form>,
      )
    case 'unauthorized':
      return row(
        'info',
        storeIcon,
        t('shop_admin.unauthorized'),
        authorizeButton(t('shop_admin.authorize')),
      )
    case 'authorizing':
      return row(
        'info',
        <Loader2 className="size-4 shrink-0 animate-spin text-ws-info" aria-hidden />,
        t('shop_admin.authorizing'),
        <div className="flex flex-wrap items-center gap-1.5">
          {job?.auth_url === undefined ? null : (
            <button
              type="button"
              className="text-xs text-ws-muted-fg underline-offset-2 hover:underline"
              onClick={() => openExternal(job.auth_url as string)}
              data-testid="shop-admin-open"
            >
              {t('shop_admin.open')}
            </button>
          )}
          <Button
            size="xs"
            variant="ghost"
            disabled={cancel.isPending}
            onClick={() => cancel.mutate()}
          >
            {t('shop_admin.cancel')}
          </Button>
        </div>,
      )
    case 'expired':
      return row(
        'warn',
        <KeyRound className="size-4 shrink-0 text-ws-warn" aria-hidden />,
        t(v.problem?.code === 'revoked' ? 'shop_admin.revoked' : 'shop_admin.expired'),
        authorizeButton(t('shop_admin.reauthorize')),
      )
    case 'missing_scopes':
      return row(
        'warn',
        <KeyRound className="size-4 shrink-0 text-ws-warn" aria-hidden />,
        t('shop_admin.missing', { list: scopeWords(v.missing) }),
        authorizeButton(t('shop_admin.reauthorize')),
      )
    case 'authorized': {
      const until =
        v.refreshable === true
          ? t('shop_admin.refreshable')
          : v.expires_at === undefined
            ? undefined
            : t('shop_admin.until', { time: formatDateTime(v.expires_at, lang) })
      return (
        <div
          className="flex flex-wrap items-center gap-1.5 px-1 text-xs text-ws-muted-fg"
          data-testid="shop-admin-banner"
          data-state="authorized"
        >
          <CheckCircle2 className="size-3.5 shrink-0 text-ws-good" aria-hidden />
          <span>
            {t('shop_admin.authorized')}
            {until === undefined ? '' : ` · ${until}`}
          </span>
          <Hint
            text={t('shop_admin.granted', {
              list: scopeWords(
                v.scopes_granted.filter(
                  (s) =>
                    s.startsWith('write_') ||
                    !v.scopes_granted.includes(s.replace(/^read_/, 'write_')),
                ),
              ),
            })}
          />
          <button
            type="button"
            className="underline-offset-2 hover:underline"
            disabled={run.isPending}
            onClick={() => reauthorize()}
            data-testid="shop-admin-reauthorize"
          >
            {t('shop_admin.reauthorize')}
          </button>
        </div>
      )
    }
    default:
      return null
  }
}
