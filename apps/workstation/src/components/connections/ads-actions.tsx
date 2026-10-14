/**
 * 连接页「浏览器插件」一节里的「广告动作」（WP313；docs/101 §5.4）。
 *
 * 三样东西，字尽量少（说明进问号）：
 * 1. **默认不碰**十个开关（决策 557）：全部默认关；打开某一项 = 允许 AI 碰它，这类动作一律 L1；
 * 2. 两家后台连没连（决策 562 的同意在插件设置页里勾，这里只看得见、能断开）；
 * 3. 排着 / 在做 / 刚做完的活：在做的能停，平台预览后等确认的能在这里点「确认提交」。
 *
 * 本机服务没装插件动作通道（老版本 / 托管实例）→ 整块不出。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { Hint } from '@/components/ui/hint'
import { Switch } from '@/components/ui/switch'
import {
  type AdsActionJobView,
  type AdsGuardedZone,
  type AdsPlatform,
  confirmAdsActionJob,
  getAdsActionSettings,
  listAdsActionJobs,
  revokeAdsActionConsent,
  setAdsActionZone,
  stopAdsActionJob,
} from '@/lib/api'
import { useApp } from '@/lib/app-context'

export const ADS_ZONES: readonly AdsGuardedZone[] = [
  'payment',
  'billing',
  'balance',
  'users',
  'business_settings',
  'verification',
  'appeal',
  'new_account',
  'pixel_conversion',
  'delete_campaign',
]

const PLATFORMS: readonly AdsPlatform[] = ['google_ads', 'meta_ads']

const LIVE: readonly AdsActionJobView['status'][] = ['queued', 'running', 'waiting_confirm']

export function AdsActionsPanel(props: { assignment?: string }): React.ReactNode {
  const { t } = useApp()
  const client = useQueryClient()
  const settings = useQuery({
    queryKey: ['ads-actions-settings', props.assignment],
    queryFn: () => getAdsActionSettings(props.assignment),
    retry: false,
  })
  const jobs = useQuery({
    queryKey: ['ads-actions-jobs', props.assignment],
    queryFn: () => listAdsActionJobs(props.assignment),
    retry: false,
    enabled: settings.isSuccess,
    // 有活在跑就 5 秒刷一次（进度、等确认）；没有就不刷
    refetchInterval: (q) =>
      (q.state.data?.jobs ?? []).some((j) => LIVE.includes(j.status)) ? 5_000 : false,
  })
  const refresh = (): void => {
    void client.invalidateQueries({ queryKey: ['ads-actions-settings'] })
    void client.invalidateQueries({ queryKey: ['ads-actions-jobs'] })
  }
  const zone = useMutation({
    mutationFn: (v: { zone: AdsGuardedZone; enabled: boolean }) =>
      setAdsActionZone(v.zone, v.enabled, props.assignment),
    onSettled: refresh,
  })
  const revoke = useMutation({
    mutationFn: (p: AdsPlatform) => revokeAdsActionConsent(p, props.assignment),
    onSettled: refresh,
  })
  const stop = useMutation({
    mutationFn: (id: string) => stopAdsActionJob(id, props.assignment),
    onSettled: refresh,
  })
  const confirm = useMutation({
    mutationFn: (id: string) => confirmAdsActionJob(id, props.assignment),
    onSettled: refresh,
  })

  // 没装配 / 老版本：整块不出（工作台其余照常）
  if (!settings.isSuccess) return null
  const s = settings.data
  const connected = PLATFORMS.filter((p) => s.consent[p] !== undefined)
  const rows = (jobs.data?.jobs ?? []).slice(0, 5)

  return (
    <div
      className="flex flex-col gap-3 rounded-2xl bg-card p-4 shadow-[var(--ws-shadow)]"
      data-testid="ads-actions"
    >
      <h4 className="text-sm font-medium">{t('extension.ads.title')}</h4>

      <div className="flex flex-wrap items-center gap-2 text-sm" data-testid="ads-actions-consent">
        {connected.length === 0 ? (
          <span className="text-muted-foreground">{t('extension.ads.consent.none')}</span>
        ) : (
          connected.map((p) => (
            <span key={p} className="flex items-center gap-1">
              {t('extension.ads.consent.on', { platform: t(`extension.ads.platform.${p}`) })}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => revoke.mutate(p)}
                disabled={revoke.isPending}
              >
                {t('extension.ads.consent.revoke')}
              </Button>
            </span>
          ))
        )}
      </div>

      <div className="flex flex-col gap-2">
        <p className="flex items-center gap-1 text-sm text-muted-foreground">
          {t('extension.ads.zones')}
          <Hint text={t('extension.ads.zones.hint')} />
        </p>
        <ul
          className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3"
          data-testid="ads-actions-zones"
        >
          {ADS_ZONES.map((z) => (
            <li key={z} className="flex items-center justify-between gap-2 text-sm">
              <span>{t(`extension.ads.zone.${z}`)}</span>
              <Switch
                size="sm"
                checked={s.zones[z]}
                disabled={zone.isPending}
                onCheckedChange={(enabled) => zone.mutate({ zone: z, enabled })}
                aria-label={t(`extension.ads.zone.${z}`)}
                data-testid={`ads-zone-${z}`}
              />
            </li>
          ))}
        </ul>
      </div>

      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('extension.ads.jobs.empty')}</p>
      ) : (
        <ul className="flex flex-col gap-1" data-testid="ads-actions-jobs">
          {rows.map((j) => (
            <li key={j.id} className="flex items-center gap-2 text-sm">
              <span className="min-w-0 flex-1 truncate" title={j.result?.message ?? j.waiting}>
                {j.title}
              </span>
              <span className="text-xs text-muted-foreground" data-slot="status">
                {t(`extension.ads.job.${j.status}`, {
                  step: String(j.progress?.step ?? 0),
                  of: String(j.progress?.of ?? 0),
                })}
              </span>
              {j.status === 'waiting_confirm' ? (
                <Button size="sm" onClick={() => confirm.mutate(j.id)} disabled={confirm.isPending}>
                  {t('extension.ads.job.confirm')}
                </Button>
              ) : null}
              {LIVE.includes(j.status) ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => stop.mutate(j.id)}
                  disabled={stop.isPending}
                >
                  {t('extension.ads.job.stop')}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
