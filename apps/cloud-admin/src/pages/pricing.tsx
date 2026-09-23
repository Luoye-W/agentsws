/**
 * 价目（WP131）：每条能力的现价、来历与核对状态。
 *
 * 与总览页「成本价目还没有人核对过」那句同一套做法：`reviewed_at` 没日期就挂「未核」。
 * 这一页只给员工看——来历里写着成本与倍率，那是中间量，不进用户界面（49 M4）。
 * 建议价不在这里：重算表在 docs/77，数字等 Luoye 定了再改 `pricing.json`。
 */

import { Note, Spinner, StatusPill, WsCard } from '@/components/design'
import { PageHeader } from '@/components/layout'
import { useApp, useQuery } from '@/lib/app'
import { credits } from '@/lib/format'

export interface PricingRow {
  capability: string
  label_zh: string
  unit: string
  credits_per_unit: number
  block?: string
  basis: string
  reviewed_at: string | null
  needs_review: boolean
}

export interface PricingPageData {
  as_of: string
  version: number
  rows: PricingRow[]
  unreviewed: number
}

export function PricingTable({ data }: { data: PricingPageData }): React.ReactNode {
  const { t } = useApp()
  return (
    <WsCard className="overflow-x-auto p-0">
      <table className="w-full min-w-[640px] text-[13px]">
        <thead>
          <tr className="border-ws-border border-b text-left text-ws-muted-fg text-xs">
            <th className="px-4 py-2 font-medium">{t('pricing.col.capability')}</th>
            <th className="px-4 py-2 font-medium">{t('pricing.col.price')}</th>
            <th className="px-4 py-2 font-medium">{t('pricing.col.basis')}</th>
            <th className="px-4 py-2 font-medium">{t('pricing.col.review')}</th>
          </tr>
        </thead>
        <tbody>
          {data.rows.map((row) => (
            <tr
              key={row.capability}
              className="border-ws-border border-b align-top last:border-0"
              data-testid="pricing-row"
            >
              <td className="px-4 py-3">
                <div className="text-ws-ink">{row.label_zh}</div>
                <div className="ws-num text-ws-muted-fg text-xs">{row.capability}</div>
              </td>
              <td className="ws-num whitespace-nowrap px-4 py-3 text-ws-ink">
                {credits(row.credits_per_unit)} / {row.unit}
              </td>
              <td className="px-4 py-3 text-ws-body leading-relaxed">{row.basis}</td>
              <td className="whitespace-nowrap px-4 py-3">
                {row.needs_review ? (
                  <StatusPill tone="warn">{t('pricing.unreviewed')}</StatusPill>
                ) : (
                  <StatusPill tone="good">
                    {t('pricing.reviewed', { at: row.reviewed_at ?? '' })}
                  </StatusPill>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </WsCard>
  )
}

export function PricingPage(): React.ReactNode {
  const { t } = useApp()
  const page = useQuery<PricingPageData>('/v1/admin/pricing')
  const data = page.data
  return (
    <>
      <PageHeader
        title={t('nav.pricing')}
        note={
          data !== undefined && data.unreviewed > 0 ? (
            <Note tone="warn">
              {t('pricing.note', {
                n: data.unreviewed,
                total: data.rows.length,
                as_of: data.as_of,
              })}
            </Note>
          ) : undefined
        }
      />
      {page.loading && data === undefined && <Spinner label={t('loading')} />}
      {data !== undefined && <PricingTable data={data} />}
    </>
  )
}
