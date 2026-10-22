/**
 * WP420（自查 ads-amazon A6 / A8）：投放「报表」里的看板。
 *
 * 以前职责定义里 8 块 `home_blocks`（今天花费、ROAS、转化、止损次数、广告系列表……）界面一块都没画，
 * 岗位页写「开工后这里出数」，广告库里明明有数，用户只能问 AI。现在：
 * - 四个数：今天花了 / 总闸还剩 / ROAS / 今天止损几条（没数写「—」，不出假的 0）；
 * - 一行「日报数据」：插件连没连、最近一次什么时候导进来（插件那一段没通时说清为什么没数）；
 * - 广告系列表（今天花得最多的在上面）。
 * 数全是服务端从广告库与看数据库算的（`GET /v1/ads/overview`），不经 AI。
 */
import { useQuery } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { money } from '@/components/ads/ads-change-body'
import { whenLabel } from '@/components/rail/card-status'
import { Hint } from '@/components/ui/hint'
import { ADS_OVERVIEW_KEY, type AdsOverviewView, getAdsOverview } from '@/lib/ads-changes-api'
import { useApp } from '@/lib/app-context'

const MAX_ROWS = 8

const PLATFORM_LABEL: Record<string, string> = {
  google: 'Google',
  meta: 'Meta',
  tiktok: 'TikTok',
  x: 'X',
}

/** 日报数据那一行说什么（纯函数，测试直接测）。 */
export function dataLineKey(data: AdsOverviewView['data']): {
  key: string
  when?: string
  bad: boolean
} {
  if (data === undefined) return { key: 'adsov.data.unavailable', bad: false }
  if (data.account === undefined) return { key: 'adsov.data.no_account', bad: true }
  if (data.plugin === 'not_connected') return { key: 'adsov.data.not_connected', bad: true }
  if (data.plugin === 'unavailable') return { key: 'adsov.data.unavailable', bad: true }
  if (data.last_import_at !== undefined)
    return { key: 'adsov.data.ready', when: data.last_import_at, bad: data.plugin === 'away' }
  if (data.plugin === 'away') return { key: 'adsov.data.away', bad: true }
  return { key: 'adsov.data.waiting', bad: false }
}

function Num({
  label,
  value,
  testId,
}: {
  label: string
  value: string
  testId: string
}): ReactNode {
  return (
    <div
      className="flex flex-col gap-0.5 rounded-lg bg-ws-surface px-2.5 py-2"
      data-testid={testId}
    >
      <span className="text-xs text-ws-muted-fg">{label}</span>
      <span className="ws-num text-base font-medium text-ws-ink">{value}</span>
    </div>
  )
}

export function AdsOverview({ assignment }: { assignment: string }): ReactNode {
  const { t } = useApp()
  const q = useQuery({
    queryKey: [...ADS_OVERVIEW_KEY, assignment],
    queryFn: () => getAdsOverview(assignment),
    retry: false,
    refetchInterval: 60_000,
  })
  const v = q.data
  if (v === undefined) return null
  const none = t('adsov.none')
  const line = dataLineKey(v.data)
  const rows = v.campaigns.slice(0, MAX_ROWS)
  return (
    <section className="flex flex-col gap-2" data-testid="ads-overview">
      <h4 className="flex items-center gap-1.5 text-sm font-medium">
        {/* 岗位层同时有 Google / Meta 两块时分得清是哪家 */}
        {t('adsov.title.platform', { platform: PLATFORM_LABEL[v.platform] ?? v.platform })}
        <Hint text={t('adsov.hint')} />
      </h4>
      <div className="grid grid-cols-2 gap-1.5">
        <Num
          label={t('adsov.spend')}
          value={v.spend_today === undefined ? none : money(v.spend_today, v.currency)}
          testId="ads-overview-spend"
        />
        <Num
          label={t('adsov.gate')}
          value={money(v.spend_gate.remaining, v.currency)}
          testId="ads-overview-gate"
        />
        <Num
          label={t('adsov.roas')}
          value={v.roas_today === undefined ? none : String(v.roas_today)}
          testId="ads-overview-roas"
        />
        <Num
          label={t('adsov.stops')}
          value={String(v.stop_losses_today)}
          testId="ads-overview-stops"
        />
      </div>
      <p
        className={line.bad ? 'text-xs text-ws-bad' : 'text-xs text-ws-muted-fg'}
        data-testid="ads-overview-data"
      >
        {t(line.key, line.when === undefined ? {} : { when: whenLabel(line.when, t) })}
      </p>
      {rows.length === 0 ? (
        <p className="text-xs text-ws-muted-fg">{t('adsov.empty')}</p>
      ) : (
        <table className="w-full text-left text-[13px]" data-testid="ads-overview-campaigns">
          <thead className="text-xs text-ws-muted-fg">
            <tr>
              <th className="py-1 font-normal">{t('adsov.col.name')}</th>
              <th className="py-1 text-right font-normal">{t('adsov.col.budget')}</th>
              <th className="py-1 text-right font-normal">{t('adsov.col.spend')}</th>
              <th className="py-1 text-right font-normal">{t('adsov.col.roas')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.id} className="border-t" data-testid="ads-overview-row">
                <td className="max-w-0 truncate py-1 pr-2">
                  {c.name}
                  {c.status === 'paused' ? (
                    <span className="ml-1 text-xs text-ws-muted-fg">{t('adsov.paused')}</span>
                  ) : null}
                </td>
                <td className="ws-num py-1 text-right">
                  {c.daily_budget === undefined ? none : money(c.daily_budget, v.currency)}
                </td>
                <td className="ws-num py-1 text-right">
                  {c.spend === undefined ? none : money(c.spend, v.currency)}
                </td>
                <td className="ws-num py-1 text-right">{c.roas === undefined ? none : c.roas}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}
