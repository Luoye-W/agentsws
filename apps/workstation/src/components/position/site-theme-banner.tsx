/**
 * WP253：建站岗位页「让 AI 改网站还差哪一步」——**一句话 + 一个按钮**，补上就消失。
 *
 * 用户没有 IT 知识：不让 AI 跑到一半才说「没有 CLI」。顺序与服务端 `site-theme.ts` 的 `readiness` 同一套：
 * 没装 CLI →「一键安装」；没登录 →「登录 Shopify」；不知道是哪家店 → 一格店铺地址（或去连接店铺）。
 * 装 / 登的进度与出错复用 WP245 那张卡（`PlatformCliCard`）：点了按钮就把它在这一行下面展开。
 *
 * WP258（Luoye 10-07：「店铺地址不是应该自动获取吗」）：登好了服务端自己去找这个账号下的店——
 * 只有一家 / 与官网对上就直接定，这一行不出现；好几家给一个下拉框（店名 · 域名 · 套餐），选了即存，
 * 定了之后留一行「改哪家店」可以换；一家都没有照实说 +「换个账号登录」「去 Shopify 开店」；
 * 没找成退回手填。手填一直留着兜底（「都不是？手动填」）。
 *
 * WP267（决策 164）：账号下只有一家、却不是官网那一家 → 不自动定，问一句「官网那家店不在这个账号下，
 * 要换个账号登录吗」+「换个账号」「就用这家」。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Download, ExternalLink, LogIn, RefreshCw, Store } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { Link } from 'react-router-dom'
import { openExternal } from '@/components/connections/bridge'
import { PlatformCliCard } from '@/components/connections/platform-cli-card'
import { Button } from '@/components/ui/button'
import { Hint } from '@/components/ui/hint'
import { Input } from '@/components/ui/input'
import {
  getSiteTheme,
  runPlatformCli,
  type SiteThemeStoreChoice,
  type SiteThemeView,
  setSiteThemeStore,
} from '@/lib/api'
import { useApp } from '@/lib/app-context'

/** 网页模板那条职责（旧名 `site.builder`）。 */
const THEME_ROLES = ['site.shopify-theme', 'site.builder']

/** WP258：没有店时「去 Shopify 开店」打开的地方。 */
const SHOPIFY_SIGNUP_URL = 'https://www.shopify.com/'

/** 下拉框里一行：店名 · 域名 · 套餐（没有的就不写）。 */
const choiceLabel = (c: SiteThemeStoreChoice): string =>
  [c.name, c.store, c.plan].filter((x) => x !== undefined && x !== '').join(' · ')

export function SiteThemeBanner({
  positionId,
  duties,
}: {
  positionId: string | undefined
  duties: readonly { role_id: string; assignment_id: string }[]
}): ReactNode {
  const { t } = useApp()
  const client = useQueryClient()
  const assignment = duties.find((d) => THEME_ROLES.includes(d.role_id))?.assignment_id
  const [expanded, setExpanded] = useState(false)
  const [store, setStore] = useState('')
  /** WP258：找到店（或确定没有）时，人点了「都不是？手动填」才出手填那一格。 */
  const [manual, setManual] = useState(false)
  /** WP258：一家店都没有时点了「换个账号登录」（登录卡在下面展开）。 */
  const [relogin, setRelogin] = useState(false)
  const key = ['site-theme', assignment ?? '']
  const view = useQuery({
    queryKey: key,
    queryFn: () => getSiteTheme(assignment ?? ''),
    enabled: assignment !== undefined,
    retry: false,
    // 卡在下面展开着（装 / 登录进行中）就接着问，好了这一行自己消失
    refetchInterval: expanded ? 2000 : false,
  })
  const set = (next: SiteThemeView): void => {
    client.setQueryData(key, next)
  }
  const run = useMutation({
    mutationFn: (action: 'install' | 'login') => runPlatformCli(action, assignment),
    onSuccess: () => {
      setExpanded(true)
      void client.invalidateQueries({ queryKey: ['platform-kit'] })
    },
  })
  const save = useMutation({
    mutationFn: (input: { store: string; source?: 'manual' | 'list' }) =>
      setSiteThemeStore(input.store, assignment ?? '', input.source),
    onSuccess: (next) => {
      set(next)
      setManual(false)
    },
  })
  const retry = useMutation({
    mutationFn: () => getSiteTheme(assignment ?? '', true),
    onSuccess: set,
  })

  const v = view.data
  if (assignment === undefined || v === undefined || !v.applicable) return null
  const lookup = v.store_lookup
  const stores = lookup?.status === 'ok' ? lookup.stores : []

  /** 从找到的那几家里选（选了即存）。 */
  const picker = (current: string | undefined, testid: string): ReactNode => (
    <select
      className="h-7 max-w-full rounded-md border bg-card px-2 text-xs"
      aria-label={t('site_theme.pick.label')}
      data-testid={testid}
      value={current ?? ''}
      disabled={save.isPending}
      onChange={(e) => {
        if (e.target.value !== '') save.mutate({ store: e.target.value, source: 'list' })
      }}
    >
      {current === undefined ? <option value="">{t('site_theme.pick.placeholder')}</option> : null}
      {stores.map((c) => (
        <option key={c.store} value={c.store}>
          {choiceLabel(c)}
        </option>
      ))}
    </select>
  )

  if (v.next === undefined) {
    // WP258：自动定 / 选过的店，账号下有好几家：留一行可以换（只有一家就什么都不画）
    if (v.store_source !== 'cli' || stores.length < 2) return null
    return (
      <div
        className="flex flex-wrap items-center gap-2 px-1 text-xs text-ws-muted-fg"
        data-testid="site-theme-store-row"
      >
        <Store className="size-3.5 shrink-0" aria-hidden />
        <span>{t('site_theme.pick.label')}</span>
        {picker(v.store, 'site-theme-store-switch')}
      </div>
    )
  }
  const next = v.next
  /** 找店的结果决定「还差店铺」那一行怎么说：好几家 → 选；一家都没有 → 照实说；没找成 / 没找 → 手填。 */
  const only = stores.length === 1 ? stores[0] : undefined
  const storeMode: 'pick' | 'none' | 'manual' | 'mismatch' =
    next !== 'store' || manual
      ? 'manual'
      : only !== undefined && v.site_store !== undefined && only.store !== v.site_store
        ? 'mismatch'
        : lookup?.status === 'ok' && stores.length > 0
          ? 'pick'
          : lookup?.status === 'none'
            ? 'none'
            : 'manual'
  const manualLink = (
    <button
      type="button"
      className="text-xs text-ws-muted-fg underline-offset-2 hover:underline"
      onClick={() => setManual(true)}
      data-testid="site-theme-manual"
    >
      {t('site_theme.pick.manual')}
    </button>
  )

  const action = (): ReactNode => {
    if (next === 'install_cli' || next === 'node')
      return (
        <Button
          size="xs"
          className="gap-1"
          disabled={run.isPending}
          onClick={() => run.mutate('install')}
          data-testid="site-theme-install"
        >
          <Download className="size-3.5" aria-hidden />
          {t('site_theme.install')}
        </Button>
      )
    if (next === 'login')
      return (
        <Button
          size="xs"
          className="gap-1"
          disabled={run.isPending}
          onClick={() => run.mutate('login')}
          data-testid="site-theme-login"
        >
          <LogIn className="size-3.5" aria-hidden />
          {t('site_theme.login')}
        </Button>
      )
    if (storeMode === 'pick')
      return (
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          {picker(undefined, 'site-theme-store-pick')}
          {manualLink}
        </div>
      )
    if (storeMode === 'mismatch' && only !== undefined)
      return (
        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            size="xs"
            className="gap-1"
            disabled={run.isPending}
            onClick={() => {
              setRelogin(true)
              run.mutate('login')
            }}
            data-testid="site-theme-mismatch-relogin"
          >
            <LogIn className="size-3.5" aria-hidden />
            {t('site_theme.mismatch.relogin')}
          </Button>
          <Button
            size="xs"
            variant="outline"
            disabled={save.isPending}
            onClick={() => save.mutate({ store: only.store, source: 'list' })}
            data-testid="site-theme-mismatch-use"
          >
            {t('site_theme.mismatch.use', { store: choiceLabel(only) })}
          </Button>
        </div>
      )
    if (storeMode === 'none')
      return (
        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            size="xs"
            className="gap-1"
            disabled={run.isPending}
            onClick={() => {
              setRelogin(true)
              run.mutate('login')
            }}
            data-testid="site-theme-relogin"
          >
            <LogIn className="size-3.5" aria-hidden />
            {t('site_theme.none.relogin')}
          </Button>
          <Button
            size="xs"
            variant="outline"
            className="gap-1"
            onClick={() => openExternal(SHOPIFY_SIGNUP_URL)}
            data-testid="site-theme-open-shopify"
          >
            <ExternalLink className="size-3.5" aria-hidden />
            {t('site_theme.none.open')}
          </Button>
          {manualLink}
        </div>
      )
    return (
      <form
        className="flex shrink-0 flex-wrap items-center gap-1.5"
        onSubmit={(e) => {
          e.preventDefault()
          if (store.trim() !== '') save.mutate({ store: store.trim(), source: 'manual' })
        }}
      >
        {lookup?.status === 'failed' && !manual ? (
          <Button
            size="xs"
            variant="ghost"
            type="button"
            className="gap-1"
            disabled={retry.isPending}
            onClick={() => retry.mutate()}
            data-testid="site-theme-retry"
          >
            <RefreshCw
              className={`size-3.5 ${retry.isPending ? 'animate-spin' : ''}`}
              aria-hidden
            />
            {t('site_theme.retry')}
          </Button>
        ) : null}
        <Input
          value={store}
          onChange={(e) => setStore(e.target.value)}
          placeholder={t('site_theme.store.placeholder')}
          className="h-7 w-56 bg-card text-xs"
          aria-label={t('site_theme.need.store')}
          data-testid="site-theme-store-input"
        />
        <Button
          size="xs"
          type="submit"
          disabled={save.isPending || store.trim() === ''}
          data-testid="site-theme-store-save"
        >
          {t('site_theme.store.save')}
        </Button>
        <Link
          to="/connections?service=shopify_admin"
          className="text-xs text-ws-muted-fg underline-offset-2 hover:underline"
        >
          {t('site_theme.store.connect')}
        </Link>
      </form>
    )
  }

  return (
    <div
      className="flex flex-col gap-2"
      data-testid="site-theme-banner"
      data-next={next}
      data-store-mode={next === 'store' ? storeMode : undefined}
    >
      <div
        className="flex flex-wrap items-center gap-2 rounded-lg bg-ws-info-bg px-3 py-2 text-sm"
        data-slot="status"
      >
        <Store className="size-4 shrink-0 text-ws-info" aria-hidden />
        <span className="min-w-0 flex-1">
          {t(
            storeMode === 'pick'
              ? 'site_theme.need.pick'
              : storeMode === 'none'
                ? 'site_theme.need.none'
                : storeMode === 'mismatch'
                  ? 'site_theme.need.mismatch'
                  : `site_theme.need.${next}`,
            storeMode === 'mismatch' && v.site_store !== undefined
              ? { site: v.site_store }
              : undefined,
          )}
        </span>
        <Hint text={t('site_theme.hint')} />
        {action()}
      </div>
      {save.error === null ? null : (
        <p role="alert" className="text-xs text-destructive">
          {t('site_theme.store.invalid')}
        </p>
      )}
      {run.error === null ? null : (
        <p role="alert" className="text-xs text-destructive">
          {run.error.message}
        </p>
      )}
      {(expanded && next !== 'store') ||
      (relogin && (storeMode === 'none' || storeMode === 'mismatch')) ? (
        <PlatformCliCard
          {...(positionId === undefined ? {} : { positionId })}
          assignment={assignment}
        />
      ) : null}
    </div>
  )
}
