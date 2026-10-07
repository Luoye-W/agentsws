/**
 * WP253：建站岗位页「让 AI 改网站还差哪一步」——**一句话 + 一个按钮**，补上就消失。
 *
 * 用户没有 IT 知识：不让 AI 跑到一半才说「没有 CLI」。顺序与服务端 `site-theme.ts` 的 `readiness` 同一套：
 * 没装 CLI →「一键安装」；没登录 →「登录 Shopify」；不知道是哪家店 → 一格店铺地址（或去连接店铺）。
 * 装 / 登的进度与出错复用 WP245 那张卡（`PlatformCliCard`）：点了按钮就把它在这一行下面展开。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Download, LogIn, Store } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { Link } from 'react-router-dom'
import { PlatformCliCard } from '@/components/connections/platform-cli-card'
import { Button } from '@/components/ui/button'
import { Hint } from '@/components/ui/hint'
import { Input } from '@/components/ui/input'
import { getSiteTheme, runPlatformCli, type SiteThemeView, setSiteThemeStore } from '@/lib/api'
import { useApp } from '@/lib/app-context'

/** 网页模板那条职责（旧名 `site.builder`）。 */
const THEME_ROLES = ['site.shopify-theme', 'site.builder']

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
    mutationFn: (value: string) => setSiteThemeStore(value, assignment ?? ''),
    onSuccess: set,
  })

  const v = view.data
  if (assignment === undefined || v === undefined || !v.applicable || v.next === undefined)
    return null
  const next = v.next

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
    return (
      <form
        className="flex shrink-0 items-center gap-1.5"
        onSubmit={(e) => {
          e.preventDefault()
          if (store.trim() !== '') save.mutate(store.trim())
        }}
      >
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
    <div className="flex flex-col gap-2" data-testid="site-theme-banner" data-next={next}>
      <div
        className="flex flex-wrap items-center gap-2 rounded-lg bg-ws-info-bg px-3 py-2 text-sm"
        data-slot="status"
      >
        <Store className="size-4 shrink-0 text-ws-info" aria-hidden />
        <span className="min-w-0 flex-1">{t(`site_theme.need.${next}`)}</span>
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
      {expanded && next !== 'store' ? (
        <PlatformCliCard
          {...(positionId === undefined ? {} : { positionId })}
          assignment={assignment}
        />
      ) : null}
    </div>
  )
}
