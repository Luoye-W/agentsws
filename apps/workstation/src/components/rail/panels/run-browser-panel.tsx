/**
 * WP95（36 §9 图标轨下组「浏览器」，`docs/upstream/sidebar-compare.md` #12 / #15）：
 * **运行中的浏览器**。
 *
 * 官方的浏览器面板是"一个 tab 一个独立浏览会话，iframe 载体，应用自己管历史"。
 * 那个**体我们不接**（spike ④：它的 iframe 直连目标 URL，与壳 `default-src 'self'`
 * 撞死，13 §5 那条不放宽），借的是**形**：右栏里看得见"它现在在哪家站上、
 * 刚才去了哪、被拦在哪、是不是在等我接管"。
 *
 * 官方 README 里那句 "never injects Electron or Node access into visited content"
 * 在我们这儿是更硬的一条：**这个面板一个网页都不渲染**。它是一份只读的状态，
 * 不是一个浏览器——真要接管，人去自己那个浏览器里接（WP92 的 BrowserSkill 附的
 * 就是你日常那一个）。
 *
 * 取数：`GET /v1/runs/:id/browser`（事件日志的投影）。run 从哪来——
 * 事项页的时间线里最近一条带 `run_id` 的；不在事项页就没有运行可看，照实说。
 */
import { useQuery } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { PanelError } from '@/components/rail/panel-error'
import { parseMatterPath } from '@/components/rail/rail-layout'
import type { RailPanelBodyProps } from '@/components/rail/registry'
import { Skeleton } from '@/components/ui/skeleton'
import { getMatter, getRunBrowser } from '@/lib/api'
import { useApp } from '@/lib/app-context'

/** 三种执行器各自的一句人话（55 §3 / §10）。 */
const EXECUTOR_KEY = {
  'playwright-mcp': 'rail.browser.executor.playwright',
  browserskill: 'rail.browser.executor.browserskill',
  none: 'rail.browser.executor.none',
} as const

export function RunBrowserPanel({ pathname }: RailPanelBodyProps): ReactNode {
  const { t } = useApp()
  const matter_id = parseMatterPath(pathname)

  // 事项 → 最近一次运行。两跳而不是一跳：事项与运行是两个对象，
  // 为第三栏在服务端新开一条"这件事最近那次运行"的路由不值得——
  // 时间线本来就带着 `run_id`。
  const matter = useQuery({
    queryKey: ['matter', matter_id],
    queryFn: () => getMatter(matter_id as string),
    enabled: matter_id !== undefined,
  })
  const run_id = matter.data?.timeline.filter((e) => e.run_id !== undefined).at(-1)?.run_id

  const browser = useQuery({
    queryKey: ['run-browser', run_id],
    queryFn: () => getRunBrowser(run_id as string),
    enabled: run_id !== undefined,
    // 还在跑的时候这一份每几秒就变一次（它正在点页面）
    refetchInterval: 5_000,
  })

  if (matter_id === undefined)
    return (
      <p className="text-muted-foreground" data-testid="rail-browser-no-matter">
        {t('rail.browser.no_matter')}
      </p>
    )
  if (matter.isPending) return <Skeleton className="h-24 w-full" />
  if (matter.error !== null) return <PanelError error={matter.error} />
  if (run_id === undefined)
    return (
      <p className="text-muted-foreground" data-testid="rail-browser-no-run">
        {t('rail.browser.no_run')}
      </p>
    )
  if (browser.isPending) return <Skeleton className="h-24 w-full" />
  if (browser.error !== null) return <PanelError error={browser.error} />

  const view = browser.data
  return (
    <div className="space-y-3" data-testid="rail-browser" data-executor={view.executor}>
      <div className="flex items-center gap-2">
        <span
          className={
            view.running
              ? 'inline-block size-2 rounded-full bg-emerald-500'
              : 'inline-block size-2 rounded-full bg-muted-foreground'
          }
          aria-hidden
        />
        <span className="text-sm" data-testid="rail-browser-executor">
          {t(EXECUTOR_KEY[view.executor])}
        </span>
        <span className="text-xs text-muted-foreground">
          {t(view.running ? 'rail.browser.running' : 'rail.browser.finished')}
        </span>
      </div>

      {/*
        人接管排在最上面：它是这个面板里唯一一条"等着你动手"的信息。
        别的几格是"它干了什么"，这一格是"它干不下去了"。
      */}
      {view.awaiting_handoff === undefined ? null : (
        <p
          className="rounded-md border border-amber-400/60 bg-amber-50 p-2 text-sm dark:bg-amber-950/30"
          data-testid="rail-browser-handoff"
        >
          {t('rail.browser.handoff')}
        </p>
      )}

      {view.current_host === undefined ? (
        <p className="text-muted-foreground" data-testid="rail-browser-nowhere">
          {t('rail.browser.nowhere')}
        </p>
      ) : (
        <p className="text-sm" data-testid="rail-browser-host">
          {t('rail.browser.host', { host: view.current_host })}
        </p>
      )}

      {view.last_navigation === undefined ? null : (
        <p className="text-xs text-muted-foreground" data-testid="rail-browser-last-nav">
          {t('rail.browser.last_nav', {
            tool: view.last_navigation.tool,
            host: view.last_navigation.host,
          })}
        </p>
      )}

      {view.last_blocked === undefined ? null : (
        <p className="text-xs text-destructive" data-testid="rail-browser-blocked">
          {t('rail.browser.blocked', {
            tool: view.last_blocked.tool,
            reason: view.last_blocked.reason,
          })}
        </p>
      )}

      <p className="text-xs text-muted-foreground" data-testid="rail-browser-counts">
        {t('rail.browser.counts', { navigations: view.navigations, blocked: view.blocked })}
      </p>

      {/* 只给域名不给整条 URL：路径里常带订单号、邮箱、一次性 token（21 敏感级） */}
      <p className="text-xs text-muted-foreground">{t('rail.browser.host_only')}</p>
    </div>
  )
}
