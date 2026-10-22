/**
 * WP380（决策 1066）：看板里「说得对不对 · 比得过谁」那一块。
 *
 * 数字 ×2（比较胜率、描述准确度，带 n 与「AI 判断」）→ 近几周两条线（genui 图表，≥ 2 周才画）→
 * 逐项（对 / 错 / 过时）→ 说错的几句（原话 + 官方说法）→ 和谁比 → 官方事实（带日期）→ 对外说法
 * （上次结果 +「现在对一次」）→ 复查（等着的 / 做完的建议）。每块都有出现条件，没数据不出、不出 0。
 *
 * 数都是服务端规则数的（`metrics.quality` + 趋势点上的 `win_rate` / `accuracy`），这里只画。
 */
import type {
  GenuiSpecLite,
  GeoMetricsView,
  GeoQualityView,
  GeoWeekPoint,
} from '@agentsws/contracts'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { type ReactNode, useState } from 'react'
import { GenuiBlockView } from '@/components/answer/genui/genui-block'
import { StatTile, WsTag } from '@/components/design'
import { Button } from '@/components/ui/button'
import { Hint } from '@/components/ui/hint'
import { useApp } from '@/lib/app-context'
import { runGeoConsistency } from '@/lib/geo-watch-api'
import { pct } from './geo-bits'

/** 两条线的 genui 描述（近几周比较胜率与描述准确度，百分数）；两条都不到 2 周回 `undefined`。 */
export function qualityChartSpec(
  points: readonly GeoWeekPoint[],
  labels: { win: string; acc: string },
): GenuiSpecLite | undefined {
  const line = (key: 'win_rate' | 'accuracy', label: string) => {
    const data = points
      .filter((p) => typeof p[key] === 'number')
      .map((p) => ({ label: p.week.slice(5), value: Math.round((p[key] as number) * 100) }))
    return data.length < 2 ? [] : [{ label, data }]
  }
  const series = [...line('win_rate', labels.win), ...line('accuracy', labels.acc)]
  if (series.length === 0) return undefined
  return { items: [{ type: 'chart', kind: 'line', series }] }
}

function Section({
  title,
  hint,
  children,
  testId,
}: {
  title: string
  hint?: string
  children: ReactNode
  testId: string
}): ReactNode {
  return (
    <div className="flex flex-col gap-1.5" data-testid={testId}>
      <h5 className="flex items-center gap-1 text-[13px] font-medium">
        {title}
        {hint === undefined ? null : <Hint text={hint} />}
      </h5>
      {children}
    </div>
  )
}

function Consistency({ q, assignment }: { q: GeoQualityView; assignment: string }): ReactNode {
  const { t } = useApp()
  const client = useQueryClient()
  const [done, setDone] = useState(false)
  const run = useMutation({
    mutationFn: () => runGeoConsistency(assignment),
    onSuccess: () => {
      setDone(true)
      void client.invalidateQueries({ queryKey: ['geo-metrics'] })
    },
  })
  const c = q.consistency
  const ok = c?.pages.filter((p) => p.status === 'ok').length ?? 0
  const line =
    c === undefined
      ? t('geo.q.consistency.none')
      : c.findings.length === 0
        ? t('geo.q.consistency.ok', { d: c.at.slice(5, 10), p: String(ok) })
        : t('geo.q.consistency.found', {
            d: c.at.slice(5, 10),
            p: String(ok),
            n: String(c.findings.length),
          })
  return (
    <Section title={t('geo.q.consistency')} testId="geo-q-consistency">
      <div className="flex flex-wrap items-center gap-2 text-[13px]">
        <span data-slot="status">{line}</span>
        {c === undefined || c.findings.length === 0
          ? null
          : (['site', 'web-ops', 'pr'] as const).map((o) => {
              const n = c.findings.filter((f) => f.owner === o).length
              return n === 0 ? null : (
                <WsTag key={o} className="h-[18px] px-1.5 text-xs">
                  {t(`geo.owner.${o}`)} {n}
                </WsTag>
              )
            })}
        <Button
          size="xs"
          variant="ghost"
          className="ml-auto"
          data-testid="geo-q-consistency-run"
          disabled={run.isPending}
          onClick={() => run.mutate()}
        >
          {done ? t('geo.q.consistency.done') : t('geo.q.consistency.run')}
        </Button>
      </div>
    </Section>
  )
}

export function GeoQuality({
  view,
  assignment,
}: {
  view: GeoMetricsView
  assignment: string
}): ReactNode {
  const { t } = useApp()
  const q = view.quality
  if (q === undefined) return null
  const all = view.trends.find((l) => l.kind === 'all')?.points ?? []
  const now = all.find((p) => p.week === view.week)
  const judged = now?.win_rate !== undefined || now?.accuracy !== undefined || q.fields.length > 0
  const spec = qualityChartSpec(all, { win: t('geo.q.win'), acc: t('geo.q.acc') })
  return (
    <section className="flex flex-col gap-3" data-testid="geo-quality">
      <h4 className="flex items-center gap-1 text-sm font-medium">
        {t('geo.q.title')}
        <Hint text={t('geo.q.title.hint')} />
      </h4>
      {!judged ? (
        <p className="text-[13px] text-ws-muted-fg" data-testid="geo-q-empty">
          {t('geo.q.empty')}
        </p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3" data-slot="data">
            <div data-testid="geo-tile-win">
              <StatTile
                value={pct(now?.win_rate)}
                label={t('geo.q.win')}
                {...(now?.compared === undefined
                  ? {}
                  : { note: t('geo.q.n', { n: String(now.compared) }) })}
              />
            </div>
            <div data-testid="geo-tile-acc">
              <StatTile
                value={pct(now?.accuracy)}
                label={t('geo.q.acc')}
                {...(now?.claims === undefined
                  ? {}
                  : { note: t('geo.q.n', { n: String(now.claims) }) })}
              />
            </div>
          </div>
          {spec === undefined ? null : (
            <figure data-testid="geo-q-chart" aria-label={t('geo.q.chart')}>
              <GenuiBlockView spec={spec} fallback={null} />
            </figure>
          )}
          <div className="flex flex-col gap-3">
            {q.fields.length === 0 ? null : (
              <Section title={t('geo.q.fields')} testId="geo-q-fields">
                <ul className="flex flex-col gap-1 text-[13px]">
                  {q.fields.map((f) => (
                    <li
                      key={f.field}
                      className="grid grid-cols-[4.5rem_minmax(0,1fr)] items-center gap-2"
                      data-testid="geo-q-field"
                      data-field={f.field}
                    >
                      <span>{t(`geo.field.${f.field}`)}</span>
                      <span className="ws-num whitespace-nowrap text-xs text-ws-muted-fg">
                        <span className="text-ws-good">
                          {t('geo.q.correct')} {f.correct}
                        </span>
                        {' · '}
                        <span className={f.wrong > 0 ? 'text-ws-bad' : ''}>
                          {t('geo.q.wrong')} {f.wrong}
                        </span>
                        {' · '}
                        <span className={f.outdated > 0 ? 'text-ws-warn' : ''}>
                          {t('geo.q.outdated')} {f.outdated}
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
              </Section>
            )}
            {q.rivals.length === 0 ? null : (
              <Section title={t('geo.q.rivals')} testId="geo-q-rivals">
                <ul className="flex flex-col gap-1 text-[13px]">
                  {q.rivals.map((r) => (
                    <li key={r.name} className="flex items-center gap-2">
                      <span className="truncate">{r.name}</span>
                      <span className="ws-num ml-auto whitespace-nowrap text-xs text-ws-muted-fg">
                        {t('geo.q.rival.line', {
                          w: String(r.wins),
                          l: String(r.losses),
                          t: String(r.ties),
                        })}
                      </span>
                    </li>
                  ))}
                </ul>
              </Section>
            )}
          </div>
          {q.bad_claims.length === 0 ? null : (
            <Section title={t('geo.q.bad')} testId="geo-q-bad">
              <ul className="flex flex-col gap-1.5 text-[13px]">
                {q.bad_claims.map((b) => (
                  <li key={`${b.answer_id}_${b.field}`} className="flex flex-col gap-0.5">
                    <span className="flex items-center gap-1.5">
                      <WsTag
                        className={`h-[18px] px-1.5 text-xs ${b.verdict === 'outdated' ? 'bg-ws-warn-bg text-ws-warn' : 'bg-ws-bad-bg text-ws-bad'}`}
                      >
                        {t(`geo.field.${b.field}`)} · {t(`geo.q.${b.verdict}`)}
                      </WsTag>
                      <span className="text-xs text-ws-muted-fg">
                        {t(`geo.platform.${b.platform}`)}
                      </span>
                    </span>
                    <q className="text-ws-ink">{b.quote}</q>
                    {b.official === undefined ? null : (
                      <span className="text-xs text-ws-muted-fg">
                        {t('geo.q.official', { v: b.official })}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </Section>
          )}
        </>
      )}
      {q.facts.length === 0 ? null : (
        <Section title={t('geo.q.facts')} hint={t('geo.q.facts.hint')} testId="geo-q-facts">
          <ul className="flex flex-col gap-1 text-[13px]">
            {q.facts.map((f) => (
              <li key={f.key} className="grid grid-cols-[5rem_minmax(0,1fr)_auto] gap-2">
                <span className="text-ws-muted-fg">{t(`geo.field.${f.key}`)}</span>
                <span className="truncate" title={f.value}>
                  {f.value}
                </span>
                <span className="ws-num text-xs text-ws-muted-fg">
                  {t('geo.q.since', { d: f.as_of.slice(5) })}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}
      <Consistency q={q} assignment={assignment} />
      {q.rechecks.length === 0 ? null : (
        <Section title={t('geo.q.rechecks')} testId="geo-q-rechecks">
          <ul className="flex flex-col gap-1 text-[13px]">
            {q.rechecks.map((r) => (
              <li key={r.id} className="flex items-center gap-2" data-testid="geo-q-recheck">
                <span className="truncate" title={r.change}>
                  {r.change}
                </span>
                <span className="ws-num ml-auto shrink-0 text-xs text-ws-muted-fg">
                  {r.status === 'done' && r.advice !== undefined ? (
                    <WsTag className="h-[18px] px-1.5 text-xs">{t(`geo.advice.${r.advice}`)}</WsTag>
                  ) : (
                    t('geo.q.recheck.wait', {
                      d: r.due.slice(5),
                      m: t(`geo.metric.${r.metric}`),
                    })
                  )}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </section>
  )
}
