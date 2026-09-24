/**
 * 设置 → **电脑操控**（docs/80，WP144）。
 *
 * 一句话：有些活只能在电脑上的某个应用里干（只有桌面版的软件、系统对话框），这一节决定
 * **AI 能不能碰这台电脑**。官方 `dsh-computer-use` + Cua Driver（MCP 那一种，驱动是独立进程）。
 *
 * 三层开关（docs/80 §3），这张卡管前两层：
 * 1. 总开关——默认关，打开时下面那段白话把风险说清楚；
 * 2. 哪几条职责可以——默认一条都不勾；
 * 3. 每次运行第一次要动电脑时的授权卡——在牌堆里批，不在这里。
 *
 * 打开后出三步向导（照 WP92 的浏览器向导）：① 下载驱动（钉版本 + sha256）② 授权系统权限
 * （打开系统设置那一页，不替用户点）③ 自检（驱动 `check_permissions`，`prompt: false`），
 * 结果原样列出 + 怎么修。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Loader2, Monitor, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Hint } from '@/components/ui/hint'
import { Skeleton } from '@/components/ui/skeleton'
import {
  ApiClientError,
  type ComputerUseSelfCheck,
  checkComputerUse,
  getComputerUseSettings,
  installComputerUseDriver,
  listRoleDefinitions,
  openComputerUseSystemSettings,
  setComputerUseSettings,
  stopComputerUse,
} from '@/lib/api'
import { useApp } from '@/lib/app-context'

/** 授权到几点（本地 HH:MM）。 */
export function clockOf(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function Step({
  title,
  note,
  children,
}: {
  title: string
  note: string
  children?: React.ReactNode
}): React.ReactNode {
  return (
    <div className="flex flex-col gap-1 rounded-md border p-2.5">
      <span className="text-xs font-medium">{title}</span>
      <span className="text-[11px] text-muted-foreground">{note}</span>
      {children}
    </div>
  )
}

function errorText(err: unknown, fallback: string): string {
  return err instanceof ApiClientError ? err.message : fallback
}

export function ComputerUseCard({ assignment }: { assignment?: string }): React.ReactNode {
  const { t } = useApp()
  const client = useQueryClient()
  const settings = useQuery({
    queryKey: ['computer-use-settings', assignment],
    queryFn: () => getComputerUseSettings(assignment),
    retry: false,
  })
  const roles = useQuery({
    queryKey: ['computer-use-roles', assignment],
    queryFn: () => listRoleDefinitions(assignment),
    retry: false,
    enabled: settings.data?.enabled === true,
  })
  const [minutes, setMinutes] = useState('')
  useEffect(() => {
    if (settings.data !== undefined && minutes === '') setMinutes(String(settings.data.minutes))
  }, [settings.data, minutes])

  const refresh = async (): Promise<void> => {
    await client.invalidateQueries({ queryKey: ['computer-use-settings'] })
    await client.invalidateQueries({ queryKey: ['computer-use-active'] })
  }
  const save = useMutation({
    mutationFn: (input: { enabled?: boolean; roles?: string[]; minutes?: number }) =>
      setComputerUseSettings(input, assignment),
    onSuccess: refresh,
  })
  const install = useMutation({
    mutationFn: () => installComputerUseDriver(assignment),
    onSuccess: refresh,
  })
  const open = useMutation({
    mutationFn: (pane: 'accessibility' | 'screen_recording') =>
      openComputerUseSystemSettings(pane, assignment),
  })
  const [check, setCheck] = useState<ComputerUseSelfCheck | undefined>(undefined)
  const selfCheck = useMutation({
    mutationFn: () => checkComputerUse(assignment),
    onSuccess: setCheck,
  })
  const stop = useMutation({ mutationFn: () => stopComputerUse(assignment), onSuccess: refresh })

  if (settings.isPending) return <Skeleton className="h-40 w-full" />
  // 服务进程没装配这一节（not_implemented）就整张卡不出——不摆一张点不动的卡
  if (settings.isError) return null
  const view = settings.data
  const allowed = view.allowed
  const on = view.enabled && allowed
  const mac = view.platform === 'darwin'

  const toggleRole = (id: string, checked: boolean): void => {
    const next = checked ? [...view.roles, id] : view.roles.filter((r) => r !== id)
    save.mutate({ roles: next })
  }

  return (
    <Card data-testid="settings-computer-use" data-enabled={on ? 'on' : 'off'}>
      <CardHeader>
        <CardTitle className="flex items-center gap-1 text-sm">
          <Monitor className="size-4" aria-hidden />
          {t('settings.cu')}
          <Hint text={t('settings.cu.hint')} testId="settings-computer-use-hint" />
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        <p className="text-xs text-muted-foreground">{t('settings.cu.summary')}</p>

        {view.active === undefined ? null : (
          <div
            className="flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-2.5 py-2 text-xs"
            data-testid="computer-use-active"
          >
            <span className="size-2 rounded-full bg-destructive" aria-hidden />
            <span className="flex-1">{t('cu.active', { until: clockOf(view.active.until) })}</span>
            <Button
              size="sm"
              variant="destructive"
              disabled={stop.isPending}
              data-testid="computer-use-stop"
              onClick={() => {
                stop.mutate()
              }}
            >
              {t('cu.stop')}
            </Button>
          </div>
        )}

        <label
          className={`flex items-start gap-2 rounded-md border p-2.5 ${
            allowed ? 'cursor-pointer' : 'opacity-50'
          } ${on ? 'border-primary' : ''}`}
        >
          <input
            type="checkbox"
            className="mt-0.5"
            checked={on}
            disabled={!allowed || save.isPending}
            data-testid="computer-use-enable"
            onChange={(e) => {
              save.mutate({ enabled: e.target.checked })
            }}
          />
          <span className="flex flex-col gap-0.5">
            <span className="text-sm font-medium">{t('settings.cu.enable')}</span>
            <span className="text-xs text-muted-foreground">
              {allowed ? t('settings.cu.risk') : (view.blocked_reason ?? t('settings.cu.blocked'))}
            </span>
          </span>
        </label>
        {save.error === null || save.error === undefined ? null : (
          <span className="text-[11px] text-destructive" data-testid="computer-use-save-error">
            {errorText(save.error, t('error.generic'))}
          </span>
        )}

        {!on ? null : (
          <div className="flex flex-col gap-2 pl-6" data-testid="computer-use-wizard">
            <div className="flex items-center gap-2 text-xs">
              <span>{t('settings.cu.minutes')}</span>
              <input
                type="number"
                min={1}
                max={60}
                className="h-7 w-16 rounded-md border bg-background px-2 text-xs"
                value={minutes}
                data-testid="computer-use-minutes"
                onChange={(e) => {
                  setMinutes(e.target.value)
                }}
                onBlur={() => {
                  const n = Number(minutes)
                  if (Number.isFinite(n) && n >= 1 && n <= 60 && n !== view.minutes)
                    save.mutate({ minutes: Math.round(n) })
                }}
              />
              <span className="text-muted-foreground">{t('settings.cu.minutes.suffix')}</span>
            </div>

            <Step title={t('settings.cu.roles')} note={t('settings.cu.roles.note')}>
              <div className="flex flex-col gap-1" data-testid="computer-use-roles">
                {roles.isPending ? <Skeleton className="h-6 w-full" /> : null}
                {(roles.data ?? []).length === 0 && !roles.isPending ? (
                  <span className="text-[11px] text-muted-foreground">
                    {t('settings.cu.roles.empty')}
                  </span>
                ) : null}
                {(roles.data ?? []).map((r) => (
                  <label key={r.id} className="flex items-center gap-2 text-xs">
                    <input
                      type="checkbox"
                      checked={view.roles.includes(r.id)}
                      disabled={save.isPending}
                      data-testid={`computer-use-role-${r.id}`}
                      onChange={(e) => {
                        toggleRole(r.id, e.target.checked)
                      }}
                    />
                    <span>{r.name}</span>
                  </label>
                ))}
              </div>
            </Step>

            <Step title={t('settings.cu.step1')} note={t('settings.cu.step1.note')}>
              <span className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={install.isPending}
                  data-testid="computer-use-install"
                  onClick={() => {
                    install.mutate()
                  }}
                >
                  {install.isPending ? <Loader2 className="animate-spin" aria-hidden /> : null}
                  {view.driver.installed
                    ? t('settings.cu.step1.reinstall')
                    : t('settings.cu.step1.install')}
                </Button>
                <span
                  className="text-[11px] text-muted-foreground"
                  data-testid="computer-use-driver"
                >
                  {view.driver.installed
                    ? t('settings.cu.step1.installed', {
                        version: view.driver.pinned_version ?? '?',
                      })
                    : (view.driver.detail ?? t('settings.cu.step1.missing'))}
                </span>
              </span>
              {install.error === null || install.error === undefined ? null : (
                <span
                  className="text-[11px] text-destructive"
                  data-testid="computer-use-install-error"
                >
                  {errorText(install.error, t('error.generic'))}
                </span>
              )}
            </Step>

            <Step
              title={t('settings.cu.step2')}
              note={mac ? t('settings.cu.step2.note.mac') : t('settings.cu.step2.note.other')}
            >
              {mac ? (
                <span className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    data-testid="computer-use-open-ax"
                    onClick={() => {
                      open.mutate('accessibility')
                    }}
                  >
                    {t('settings.cu.step2.ax')}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    data-testid="computer-use-open-sr"
                    onClick={() => {
                      open.mutate('screen_recording')
                    }}
                  >
                    {t('settings.cu.step2.sr')}
                  </Button>
                </span>
              ) : null}
            </Step>

            <Step title={t('settings.cu.step3')} note={t('settings.cu.step3.note')}>
              <span className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={selfCheck.isPending || !view.driver.installed}
                  data-testid="computer-use-check"
                  onClick={() => {
                    selfCheck.mutate()
                  }}
                >
                  {selfCheck.isPending ? <Loader2 className="animate-spin" aria-hidden /> : null}
                  {t('settings.cu.step3.run')}
                </Button>
                {check === undefined ? null : (
                  <span
                    className={`text-[11px] ${check.ok ? 'text-emerald-600' : 'text-destructive'}`}
                    data-testid="computer-use-check-summary"
                  >
                    {check.ok ? t('settings.cu.step3.ok') : (check.detail ?? '')}
                  </span>
                )}
              </span>
              {check === undefined ? null : (
                <ul className="flex flex-col gap-1" data-testid="computer-use-checks">
                  {check.checks.map((c) => (
                    <li key={c.name} className="flex flex-col text-[11px]">
                      <span className="flex items-center gap-1">
                        {c.ok ? (
                          <Check className="size-3 text-emerald-600" aria-hidden />
                        ) : (
                          <X className="size-3 text-destructive" aria-hidden />
                        )}
                        <span>{c.detail}</span>
                      </span>
                      {c.fix === undefined ? null : (
                        <span className="pl-4 text-muted-foreground">{c.fix}</span>
                      )}
                    </li>
                  ))}
                  {check.raw === undefined ? null : (
                    <details className="text-[11px] text-muted-foreground">
                      <summary>{t('settings.cu.step3.raw')}</summary>
                      <pre className="whitespace-pre-wrap">{check.raw}</pre>
                    </details>
                  )}
                </ul>
              )}
            </Step>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
