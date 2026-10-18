/**
 * WP394（docs/104 一期 B，docs/106 §13）：Amazon 运营面板的「竞品动向」块——WP395 留的空块，用
 * `registerAmazonBlockBody('competitors', …)` 填进去（不动面板的结构）。
 *
 * - 一行：盯几家 · 几款 · 下次读的时刻；有没读到的亮红点、照实写是哪家（不出 0）；
 * - 最近几条 Amazon 对标款的变化（服务端拼好的一句人话，带「比你的 X 便宜 $N」）+ 价格走势；
 * - 「现在读一次」（只读公开页面，不出审批卡）；还没盯就是 WP395 那一行灰字。
 * - WP402：被 Amazon 拦了（品牌级，和联想词共用）那一句；「读不到时用你的浏览器」同意 / 撤回（字进问号）。
 *
 * 数和那句话都由服务端给（`/v1/competitor-watch*`，WP392），这里不算任何数；用户看到的字不提数据供应商名。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { AmazonEmpty, registerAmazonBlockBody } from '@/components/amazon/amazon-ops-board'
import { whenLabel } from '@/components/rail/card-status'
import { priceTrend } from '@/components/reports/competitor-watch'
import { shortDate } from '@/components/reports/report-data'
import { Sparkline } from '@/components/stat-tile'
import { useApp } from '@/lib/app-context'
import {
  competitorChangesKey,
  competitorWatchKey,
  getCompetitorChanges,
  getCompetitorWatch,
  runCompetitorWatch,
  setOwnBrowserConsent,
} from '@/lib/competitor-watch-api'
import { cn } from '@/lib/utils'

/** 块里最多列几条变化（多的去「报表」卡里的竞品变化表看）。 */
const SHOWN = 5

export function AmazonCompetitorsBlock({ assignment }: { assignment: string }): ReactNode {
  const { t, lang } = useApp()
  const client = useQueryClient()
  const view = useQuery({
    queryKey: competitorWatchKey(assignment),
    queryFn: () => getCompetitorWatch(assignment),
    retry: false,
    staleTime: 60_000,
  }).data
  const sources = (view?.sources ?? []).filter((s) => s.kind === 'amazon_asin' && s.paused !== true)
  const changes = useQuery({
    queryKey: competitorChangesKey(assignment),
    queryFn: () => getCompetitorChanges(assignment),
    enabled: sources.length > 0,
    retry: false,
    staleTime: 60_000,
  })
  const run = useMutation({
    mutationFn: () => runCompetitorWatch(assignment),
    onSettled: async () => {
      await client.invalidateQueries({ queryKey: ['competitor-watch', assignment] })
    },
  })
  // WP402（决策 1140 / 1146）：读不到时用你自己的浏览器读——同意 / 撤回（撤回 = 不用、不再问）
  const consent = useMutation({
    mutationFn: (next: 'granted' | 'revoked') => setOwnBrowserConsent(assignment, next),
    onSettled: async () => {
      await client.invalidateQueries({ queryKey: competitorWatchKey(assignment) })
    },
  })
  if (sources.length === 0)
    return <AmazonEmpty text={t('amzops.competitors.empty')} testId="amzops-empty-competitors" />
  const rivals = sources.filter((s) => s.group !== 'own')
  const asins = rivals.reduce((n, s) => n + (s.asins?.length ?? 0), 0)
  const failed = [...new Set(sources.filter((s) => s.status === 'failed').map((s) => s.label))]
  const all = (changes.data ?? []).filter((c) => c.source_kind === 'amazon_asin')
  const rows = all.filter((c) => c.competitor_id !== '_own').slice(0, SHOWN)
  const next = view?.next_read_at
  const own = view?.own_browser
  const granted = own?.state === 'granted'
  const pausedUntil = view?.amazon_block?.paused_until
  const paused = pausedUntil !== undefined && Date.parse(pausedUntil) > Date.now()
  return (
    <div className="flex flex-col gap-1.5" data-testid="amzcw-block">
      <div className="flex items-center gap-2 text-[12px]" data-testid="amzcw-summary">
        <i
          aria-hidden
          className={cn(
            'size-1.5 shrink-0 rounded-full',
            failed.length > 0 ? 'bg-ws-bad' : 'bg-ws-good',
          )}
        />
        <span className="ws-num text-ws-body">
          {t('amzcw.summary', { n: new Set(rivals.map((s) => s.competitor_id)).size, asins })}
        </span>
        {next === undefined ? null : (
          <span className="text-ws-muted-fg">{t('amzcw.next', { when: whenLabel(next, t) })}</span>
        )}
        <button
          type="button"
          className="ml-auto rounded-md px-1.5 py-0.5 text-[11px] text-ws-muted-fg hover:bg-sidebar-accent/60"
          data-testid="amzcw-run"
          disabled={run.isPending}
          onClick={() => {
            run.mutate()
          }}
        >
          {run.isPending ? t('cwatch.running') : t('cwatch.run')}
        </button>
      </div>
      {failed.length === 0 ? null : (
        <p className="text-[12px] text-ws-bad" data-testid="amzcw-failed">
          {t('cwatch.failed_who', { who: failed.join('、') })}
        </p>
      )}
      {paused ? (
        <p className="text-[12px] text-ws-muted-fg" data-testid="amzcw-paused">
          {t('amzcw.paused', { when: whenLabel(pausedUntil, t) })}
        </p>
      ) : null}
      {own?.available === true ? (
        <div
          className="flex items-center gap-2 text-[12px]"
          data-testid="amzcw-own-browser"
          data-state={own.state}
        >
          <span className="min-w-0 truncate text-ws-muted-fg" title={t('amzcw.own.tip')}>
            {t('amzcw.own.label')}
          </span>
          <span className={granted ? 'text-ws-body' : 'text-ws-muted-fg'}>
            {granted ? t('amzcw.own.on') : t('amzcw.own.off')}
          </span>
          <button
            type="button"
            className="ml-auto rounded-md px-1.5 py-0.5 text-[11px] text-ws-muted-fg hover:bg-sidebar-accent/60"
            data-testid="amzcw-own-toggle"
            disabled={consent.isPending}
            onClick={() => {
              consent.mutate(granted ? 'revoked' : 'granted')
            }}
          >
            {granted ? t('amzcw.own.revoke') : t('amzcw.own.grant')}
          </button>
        </div>
      ) : null}
      {rows.length === 0 ? (
        changes.isPending ? null : (
          <p className="text-[12px] text-ws-muted-fg" data-testid="amzcw-none">
            {t('cwatch.empty')}
          </p>
        )
      ) : (
        <ul className="flex flex-col gap-1.5" data-testid="amzcw-changes">
          {rows.map((c) => {
            const trend = priceTrend(all, c)
            const text = lang === 'en' ? c.text.en : c.text.zh
            return (
              <li
                key={c.id}
                className="flex flex-col gap-0.5 text-[12px]"
                data-testid="amzcw-change"
                data-kind={c.kind}
                data-cheaper={c.vs_own !== undefined && c.vs_own.diff < 0 ? 'true' : undefined}
              >
                <div className="flex items-baseline gap-2 text-[11px] text-ws-muted-fg">
                  <span className="min-w-0 truncate">{c.competitor}</span>
                  <span className="shrink-0">{t(`cwatch.kind.${c.kind}`)}</span>
                  <span className="ml-auto shrink-0 ws-num">{shortDate(c.detected_at)}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 text-ws-body">
                    {c.url === undefined || c.url === '' ? (
                      text
                    ) : (
                      <a href={c.url} target="_blank" rel="noreferrer" className="hover:underline">
                        {text}
                      </a>
                    )}
                  </span>
                  {trend.length >= 2 ? (
                    <span className="shrink-0" title={t('cwatch.trend')}>
                      <Sparkline points={trend} className="h-4 w-12 text-ws-brand" />
                    </span>
                  ) : null}
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

registerAmazonBlockBody('competitors', AmazonCompetitorsBlock)
