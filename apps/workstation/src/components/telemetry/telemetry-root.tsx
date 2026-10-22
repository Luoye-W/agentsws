/**
 * WP476（决策 1590）：工作台的匿名使用数据——挂在登录后的外壳里，一处管完：
 *
 * - 问本机服务要配置（`/v1/settings/telemetry`）：`active` 才加载 SDK，否则什么都不加载；
 * - 页面访问：路由**模板**一变记一条（具体 id、查询串不出门）；
 * - 关键按钮：全局一个点击监听，只认 `buttons.ts` 那张对照表里的固定编号；
 * - 第一次启动（真会发、还没看过）在右下角提示一句，「知道了 / 不发送」，点了就不再出。
 *
 * 前端报错由 `client-errors.ts` 顺手记（只有错误类名）。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { type ReactNode, useEffect } from 'react'
import { useLocation } from 'react-router-dom'
import { TELEMETRY_KEY } from '@/components/settings/telemetry-setting'
import { getTelemetrySettings, putTelemetrySettings, type TelemetrySettings } from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { useAppVersion } from '@/lib/app-version'
import { useMode } from '@/lib/mode'
import { buttonIdOf } from '@/lib/telemetry/buttons'
import { applyTelemetry, track } from '@/lib/telemetry/client'
import { routeTemplate } from '@/lib/telemetry/routes'

const isDesktop = (): boolean =>
  (globalThis.window as unknown as { agentsws?: unknown } | undefined)?.agentsws !== undefined

export function TelemetryRoot(): ReactNode {
  const { lang } = useApp()
  const { mode, known } = useMode()
  const { version } = useAppVersion()
  const view = useQuery({
    queryKey: TELEMETRY_KEY,
    queryFn: getTelemetrySettings,
    retry: false,
    staleTime: 10 * 60_000,
  })

  // 配置 / 公共属性变了就重新对一遍（关了 → 停发、攒的扔掉；老服务进程没有这条路 → 当没配置）
  useEffect(() => {
    if (view.isPending) return
    void applyTelemetry(view.isError ? undefined : view.data, {
      shell: isDesktop() ? 'desktop' : 'web',
      lang,
      ...(version === undefined ? {} : { app_version: version }),
      ...(known ? { mode } : {}),
    })
  }, [view.isPending, view.isError, view.data, lang, version, mode, known])

  useEffect(() => {
    track('app_opened')
  }, [])

  const location = useLocation()
  const route = routeTemplate(location)
  useEffect(() => {
    track('$pageview', { route })
  }, [route])

  useEffect(() => {
    const onClick = (e: MouseEvent): void => {
      const button_id = buttonIdOf(e.target)
      if (button_id !== undefined) track('ui_click', { button_id })
    }
    document.addEventListener('click', onClick, true)
    return () => {
      document.removeEventListener('click', onClick, true)
    }
  }, [])

  return view.data === undefined ? null : <TelemetryNotice view={view.data} />
}

/** 第一次启动那一句（真会发、还没看过才出）。 */
export function TelemetryNotice({ view }: { view: TelemetrySettings }): ReactNode {
  const { t } = useApp()
  const client = useQueryClient()
  const answer = useMutation({
    mutationFn: (enabled: boolean) => putTelemetrySettings({ enabled, notice_seen: true }),
    onSuccess: (next) => {
      client.setQueryData(TELEMETRY_KEY, next)
    },
  })
  if (!view.active || view.notice_seen) return null
  return (
    <div
      role="status"
      data-testid="telemetry-notice"
      className="fixed right-4 bottom-4 z-50 flex max-w-sm items-center gap-3 rounded-lg bg-ws-card px-3 py-2 text-sm text-ws-ink shadow-[inset_0_0_0_1px_var(--ws-line)]"
    >
      <span className="min-w-0 flex-1">{t('telemetry.notice')}</span>
      <button
        type="button"
        data-testid="telemetry-notice-off"
        disabled={answer.isPending}
        className="shrink-0 rounded-md px-2 py-1 text-xs text-ws-muted-fg hover:text-ws-ink disabled:opacity-50"
        onClick={() => {
          answer.mutate(false)
        }}
      >
        {t('telemetry.notice.off')}
      </button>
      <button
        type="button"
        data-testid="telemetry-notice-ok"
        disabled={answer.isPending}
        className="shrink-0 rounded-md bg-ws-ink px-2.5 py-1 text-xs font-medium text-ws-paper hover:opacity-90 disabled:opacity-50"
        onClick={() => {
          answer.mutate(true)
        }}
      >
        {t('telemetry.notice.ok')}
      </button>
    </div>
  )
}
