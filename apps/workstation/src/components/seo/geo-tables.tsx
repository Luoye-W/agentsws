/**
 * WP335（docs/99 §5.4 / §5.6）：看板下半——**关注词排名表**、**被引用最多的站 Top 10**、**我们 vs 竞品**。
 *
 * 出现条件（docs/96 P3）：排名表有行才出；站表有行才出；对比要有 ≥ 1 个竞品。
 * 排名是「估算」（问号里说）；真实排名一列是 Search Console 的平均排名。数全是服务端算好的。
 */
import type {
  GeoBrandShare,
  GeoCitedSource,
  GeoMetricsView,
  RankMetricsView,
} from '@agentsws/contracts'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { DeltaPill } from '@/components/design'
import { Hint } from '@/components/ui/hint'
import { useApp } from '@/lib/app-context'
import { KindTag, pct } from './geo-bits'

const TH = 'px-3 py-2.5 text-left text-xs font-medium text-ws-muted-fg'

export function GeoRankTable({ rank }: { rank: RankMetricsView }): ReactNode {
  const { t } = useApp()
  if (rank.rows.length === 0) return null
  const many = new Set(rank.rows.map((r) => `${r.market}|${r.device}`)).size > 1
  return (
    <div className="flex flex-col gap-2" data-testid="geo-rank">
      <h4 className="flex items-center gap-1 text-sm font-medium">
        {t('geo.rank')}
        <Hint text={t('geo.rank.est.hint')} />
      </h4>
      <div className="-mx-1 overflow-x-auto">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="bg-ws-surface">
              <th scope="col" className={`${TH} rounded-l-lg`}>
                {t('geo.rank.keyword')}
              </th>
              <th scope="col" className={`${TH} text-right`}>
                {t('geo.rank.now')}
              </th>
              <th scope="col" className={TH}>
                {t('geo.rank.change')}
              </th>
              <th scope="col" className={TH}>
                {t('geo.rank.aio')}
              </th>
              <th scope="col" className={`${TH} rounded-r-lg text-right`}>
                <span className="inline-flex items-center gap-1">
                  {t('geo.rank.gsc')}
                  <Hint text={t('geo.rank.gsc.hint')} />
                </span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rank.rows.map((r) => (
              <tr
                key={`${r.keyword}|${r.market}|${r.device}`}
                className="border-b border-ws-line last:border-0"
                data-testid="geo-rank-row"
              >
                <td className="px-3 py-2.5">
                  {r.keyword}
                  {many ? (
                    <span className="ml-1 text-xs text-ws-muted-fg">
                      {r.market} · {t(`geo.watch.device.${r.device}`)}
                    </span>
                  ) : null}
                </td>
                <td className="ws-num px-3 py-2.5 text-right">
                  {r.rank === undefined ? t('geo.rank.out') : r.rank}
                </td>
                <td className="px-3 py-2.5">
                  {r.change === undefined || r.change === 0 ? (
                    <span className="text-ws-muted-fg">—</span>
                  ) : (
                    <DeltaPill direction={r.change > 0 ? 'up' : 'down'}>
                      {Math.abs(r.change)}
                    </DeltaPill>
                  )}
                </td>
                <td className="px-3 py-2.5">
                  {!r.features.ai_overview ? (
                    <span className="text-ws-muted-fg">—</span>
                  ) : r.aio_mentions_us || r.aio_cites_us ? (
                    <span className="text-ws-good" data-testid="geo-rank-aio-us">
                      ✓
                    </span>
                  ) : (
                    <span className="text-ws-muted-fg">✗</span>
                  )}
                </td>
                <td className="ws-num px-3 py-2.5 text-right">
                  {r.gsc_position === undefined ? '—' : r.gsc_position}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/** 一个站被引的那几页（从近 4 周的「按页面」里挑这个域名的）。 */
function pagesOf(view: GeoMetricsView, domain: string): GeoCitedSource[] {
  const seen = new Set<string>()
  return [...view.our_pages, ...view.competitor_pages, ...view.top_pages].filter((p) => {
    const key = p.url_norm ?? p.url ?? ''
    if (p.domain !== domain || key === '' || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function GeoSites({ view }: { view: GeoMetricsView }): ReactNode {
  const { t } = useApp()
  const [open, setOpen] = useState<string | undefined>(undefined)
  if (view.top_domains.length === 0) return null
  return (
    <div className="flex flex-col gap-2" data-testid="geo-sites">
      <h4 className="flex items-center gap-1 text-sm font-medium">
        {t('geo.sites')}
        <Hint text={t('geo.sites.hint')} />
      </h4>
      <ol className="flex flex-col" data-slot="data">
        {view.top_domains.map((s) => {
          const pages = pagesOf(view, s.domain)
          const expanded = open === s.domain
          return (
            <li key={s.domain} className="border-b border-ws-line last:border-0">
              <button
                type="button"
                className="flex w-full items-center gap-2 py-2 text-left text-[13px] hover:bg-ws-surface"
                aria-expanded={expanded}
                disabled={pages.length === 0}
                data-testid="geo-site"
                data-domain={s.domain}
                onClick={() => setOpen(expanded ? undefined : s.domain)}
              >
                {pages.length === 0 ? (
                  <span className="size-3.5" />
                ) : expanded ? (
                  <ChevronDown className="size-3.5" aria-hidden />
                ) : (
                  <ChevronRight className="size-3.5" aria-hidden />
                )}
                <span className={`min-w-0 truncate ${s.group === 'ours' ? 'font-semibold' : ''}`}>
                  {s.domain}
                </span>
                <KindTag kind={s.site_kind} />
                <span className="ml-auto flex shrink-0 items-center gap-2 text-xs text-ws-muted-fg">
                  <span className="ws-num">{t('geo.sites.count', { n: String(s.citations) })}</span>
                  <span title={s.platforms.map((p) => t(`geo.platform.${p}`)).join(' · ')}>
                    {t('geo.sites.ais', { n: String(s.platforms.length) })}
                  </span>
                  {s.new ? (
                    <span className="font-medium text-ws-info">{t('geo.sites.new')}</span>
                  ) : s.citations !== s.previous ? (
                    <DeltaPill direction={s.citations > s.previous ? 'up' : 'down'}>
                      {Math.abs(s.citations - s.previous)}
                    </DeltaPill>
                  ) : null}
                </span>
              </button>
              {expanded ? (
                <ul className="mb-2 ml-6 flex flex-col gap-1 text-xs" data-testid="geo-site-pages">
                  {pages.map((p) => (
                    <li key={p.url_norm ?? p.url} className="flex items-center gap-2">
                      <a
                        href={p.url ?? p.url_norm}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="truncate underline-offset-2 hover:underline"
                      >
                        {p.title ?? p.url_norm ?? p.url}
                      </a>
                      <span className="ws-num shrink-0 text-ws-muted-fg">
                        {t('geo.sites.count', { n: String(p.citations) })}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          )
        })}
      </ol>
    </div>
  )
}

/** 我们 vs 竞品（横条：被提到几次；右边是声量份额）。只在有 ≥ 1 个竞品时出。 */
export function GeoCompare({ brands }: { brands: readonly GeoBrandShare[] }): ReactNode {
  const { t } = useApp()
  if (brands.filter((b) => b.entity !== 'ours').length === 0) return null
  const max = Math.max(1, ...brands.map((b) => b.mentioned))
  return (
    <div className="flex flex-col gap-2" data-testid="geo-compare">
      <h4 className="flex items-center gap-1 text-sm font-medium">
        {t('geo.compare')}
        <Hint text={t('geo.compare.hint')} />
      </h4>
      <ul className="flex flex-col gap-2" data-slot="data">
        {brands.map((b) => (
          <li
            key={b.entity}
            className="grid grid-cols-[7rem_minmax(0,1fr)_5rem] items-center gap-2 text-[13px]"
            data-testid="geo-compare-row"
            data-entity={b.entity}
          >
            <span className={`truncate ${b.entity === 'ours' ? 'font-semibold' : ''}`}>
              {b.name}
            </span>
            <span className="h-2 rounded-full bg-ws-surface">
              <span
                className={`block h-2 rounded-full ${b.entity === 'ours' ? 'bg-ws-good' : 'bg-ws-warn'}`}
                style={{ width: `${Math.max(2, (b.mentioned / max) * 100)}%` }}
              />
            </span>
            <span className="ws-num text-right text-xs text-ws-muted-fg">
              {t('geo.compare.mentioned', { n: String(b.mentioned) })} · {pct(b.sov)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}
