/**
 * WP246（决策 87 / 88）：连接页「取数路线」——每个平台一行：每一级一个状态图标（通 / 不通 / 关着 / 还没接），
 * 现在在用的那一级标「在用」；原因与怎么修进图标的提示（36 §7 少字）。一键「重新体检」。
 *
 * Reddit 那一行多一个「登录读号」：服务端有头打开只读浏览器那份目录到 Reddit 登录页，用户自己在网页上登录；
 * 窗口关掉后服务端自动体检，这一行显示「已登录：u/xxx」。「用一个普通号，别用版主号 / 品牌官方号」常显
 * （安全那句不许藏）。网页那一行有第三方转文字的开关（默认关，开了网址会经过对方）。
 *
 * 单独一个组件（WP245 / WP244 在改连接页别的卡），连接页只多一行挂载。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Captions,
  Cloud,
  ExternalLink,
  FileText,
  Globe,
  type LucideIcon,
  RefreshCw,
  Route,
} from 'lucide-react'
import { StatusIcons, type StatusItem } from '@/components/design'
import { Button } from '@/components/ui/button'
import { Hint, SafetyNote } from '@/components/ui/hint'
import { Switch } from '@/components/ui/switch'
import {
  getReadRoutes,
  openRedditReadAccountLogin,
  type ReadLevel,
  type ReadLevelCheck,
  type ReadRouteHealth,
  type ReadRoutesView,
  runReadRoutesDoctor,
  setReadRoutesSettings,
} from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { apiErrorText } from '@/lib/error-text'

const LEVEL_ICON: Record<ReadLevel, LucideIcon> = {
  workshop: Cloud,
  browser_readonly: Globe,
  page_captions: Captions,
  local_extract: FileText,
  third_party_reader: ExternalLink,
}

const STATE: Record<ReadLevelCheck['state'], StatusItem['state']> = {
  ok: 'ok',
  down: 'fail',
  off: 'unknown',
  pending: 'unknown',
}

type T = ReturnType<typeof useApp>['t']

/** 一级 → 一个状态图标（原因、怎么修、上次的结果进提示）。 */
function levelItem(route: ReadRouteHealth, c: ReadLevelCheck, t: T): StatusItem {
  const lines = [c.reason]
  if (c.fix !== undefined && c.state !== 'ok') lines.push(t('read_routes.fix', { fix: c.fix }))
  if (c.last !== undefined)
    lines.push(
      c.last.ok
        ? t('read_routes.last_ok')
        : t('read_routes.last_fail', { message: c.last.message ?? '' }),
    )
  // 在用的那一级只标「在用」（读号是谁在下面那一行说）；没在用的才把细节（读号）摆在旁边
  const value = route.active === c.level ? t('read_routes.active') : c.detail
  return {
    key: c.level,
    label: t(`read_routes.level.${c.level}`),
    state: STATE[c.state],
    icon: LEVEL_ICON[c.level],
    ...(c.state === 'off' || c.state === 'pending'
      ? { stateText: t(`read_routes.state.${c.state}`) }
      : {}),
    detail: lines.join('\n'),
    ...(value === undefined ? {} : { value }),
    testId: `read-level-${route.platform}-${c.level}`,
  }
}

export function ReadRoutesSection({ assignment }: { assignment?: string }): React.ReactNode {
  const { t } = useApp()
  const client = useQueryClient()
  const key = ['read-routes', assignment]
  const view = useQuery({
    queryKey: key,
    queryFn: () => getReadRoutes(assignment),
    retry: false,
    // 登录窗口开着时隔几秒问一次：关掉窗口后服务端体检完，这一行自己变绿
    refetchInterval: (q) =>
      (q.state.data as ReadRoutesView | undefined)?.reddit_account?.state === 'logging_in'
        ? 3_000
        : false,
  })
  const put = (data: ReadRoutesView): void => {
    client.setQueryData(key, data)
  }
  const recheck = useMutation({
    mutationFn: () => runReadRoutesDoctor(assignment),
    onSuccess: put,
  })
  const settings = useMutation({
    mutationFn: (on: boolean) => setReadRoutesSettings({ web_third_party_reader: on }, assignment),
    onSuccess: put,
  })
  const login = useMutation({
    mutationFn: () => openRedditReadAccountLogin(assignment),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['read-routes'] }),
  })

  // 服务进程没装这一块（老版本 / 云上没开）：整块不画
  if (view.isError || view.data === undefined) return null
  const data = view.data
  const account = data.reddit_account
  const error = recheck.error ?? settings.error ?? login.error
  const time = new Date(data.doctor.checked_at).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  })

  return (
    <section className="flex flex-col gap-2" data-testid="read-routes">
      <div className="flex items-center gap-2">
        <h3 className="flex items-center gap-1.5 text-sm font-medium">
          <Route className="size-4" aria-hidden />
          {t('read_routes.title')}
          <Hint text={t('read_routes.hint')} testId="read-routes-hint" />
        </h3>
        <span className="flex-1" />
        <span className="text-[11px] text-muted-foreground" data-slot="status">
          {t('read_routes.checked_at', { time })}
        </span>
        <Button
          size="xs"
          variant="outline"
          disabled={recheck.isPending}
          onClick={() => recheck.mutate()}
          data-testid="read-routes-recheck"
        >
          <RefreshCw className={recheck.isPending ? 'size-3 animate-spin' : 'size-3'} aria-hidden />
          {t('read_routes.recheck')}
        </Button>
      </div>
      <ul className="flex flex-col divide-y rounded-md border">
        {data.doctor.routes.map((route) => (
          <li
            key={route.platform}
            className="flex flex-col gap-1 px-3 py-2"
            data-testid={`read-route-${route.platform}`}
            data-active={route.active ?? ''}
          >
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="w-24 shrink-0 text-xs font-medium">
                {t(`read_routes.platform.${route.platform}`)}
              </span>
              <StatusIcons
                items={route.levels.map((c) => levelItem(route, c, t))}
                label={t(`read_routes.platform.${route.platform}`)}
                testId={`read-route-levels-${route.platform}`}
                className="flex-1"
              />
              {route.active === undefined ? (
                <span className="text-[11px] text-ws-bad" data-slot="status">
                  {t('read_routes.none_active')}
                </span>
              ) : null}
              {route.platform === 'reddit' && account !== undefined ? (
                <Button
                  size="xs"
                  variant={account.state === 'logged_in' ? 'ghost' : 'outline'}
                  disabled={login.isPending || account.state === 'logging_in'}
                  onClick={() => login.mutate()}
                  data-testid="read-account-login"
                >
                  {account.state === 'logging_in'
                    ? t('read_routes.login.open')
                    : t('read_routes.login')}
                </Button>
              ) : null}
              {route.platform === 'web' ? (
                <span className="flex items-center gap-1.5 text-[11px]">
                  <Switch
                    checked={data.settings.web_third_party_reader}
                    disabled={settings.isPending}
                    onCheckedChange={(on) => settings.mutate(on)}
                    aria-label={t('read_routes.third_party')}
                    data-testid="read-third-party-switch"
                  />
                  {t('read_routes.third_party')}
                  <Hint text={t('read_routes.third_party_hint')} testId="read-third-party-hint" />
                </span>
              ) : null}
            </div>
            {route.platform === 'reddit' && account !== undefined ? (
              <RedditAccountLine account={account} t={t} />
            ) : null}
          </li>
        ))}
      </ul>
      {error === null || error === undefined ? null : (
        <p role="alert" className="text-[11px] text-destructive" data-testid="read-routes-error">
          {apiErrorText(error, t)}
        </p>
      )}
    </section>
  )
}

/** Reddit 读号那一行：已登录 / 登录中 / 被拦 + 常显的安全那句。 */
function RedditAccountLine({
  account,
  t,
}: {
  account: NonNullable<ReadRoutesView['reddit_account']>
  t: T
}): React.ReactNode {
  const status =
    account.state === 'logged_in' && account.username !== undefined
      ? { text: t('read_routes.account.logged_in', { name: account.username }), bad: false }
      : account.state === 'logging_in'
        ? { text: t('read_routes.account.logging_in'), bad: false }
        : account.state === 'refused' || account.state === 'unknown'
          ? { text: account.message ?? '', bad: true }
          : undefined
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 pl-24" data-testid="read-account">
      {status === undefined || status.text === '' ? null : (
        <span
          className={status.bad ? 'text-[11px] text-ws-bad' : 'text-[11px]'}
          data-slot="status"
          data-testid="read-account-status"
          data-state={account.state}
        >
          {status.text}
        </span>
      )}
      <SafetyNote text={t('read_routes.login.safety')} hint={t('read_routes.login.safety_hint')} />
    </div>
  )
}
