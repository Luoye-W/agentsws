/**
 * WP335（docs/99 §5.6）：第三栏「依据」里的 **一条回答** 组件——点看板方格的一格开这里。
 *
 * - 顶上一行：AI 名 · 市场 · 哪一周 · 情感小标（AI 判断，原话进问号）；
 * - 正文默认折叠成前 3 行，**品牌名高亮**（我们绿、竞品橙），点开看全文；
 * - 下面是编号引用列表（编号 = 回答里的顺序；我们的站排前面、加粗；类型小标）；
 * - 底部切换「和上周比」：正文改用增删标色，引用标「新」、另列「不见了」；
 * - 时间线：这一格近 12 周，每周一个点（提到 / 没提到 / 没查成）+ 名次。
 *
 * 只画：全文、引用、判定、上一期、时间线都由 `GET /v1/seo/watch/answers/:id` 给。
 */
import type { GeoAnswerDetail, GeoCitationRecord } from '@agentsws/contracts'
import { type ReactNode, useMemo, useState } from 'react'
import { WsTag } from '@/components/design'
import { Hint } from '@/components/ui/hint'
import { useApp } from '@/lib/app-context'
import { cn } from '@/lib/utils'
import { diffText, highlight, plainOf } from './geo-answer-text'
import { KindTag } from './geo-bits'

/** 我们的站排前面，其余按回答里的顺序；只在搜索结果里出现过的不算引用。 */
function orderedSources(list: readonly GeoCitationRecord[]): GeoCitationRecord[] {
  return list
    .filter((c) => c.where !== 'searched')
    .sort(
      (a, b) =>
        Number(b.site_kind === 'ours') - Number(a.site_kind === 'ours') || a.position - b.position,
    )
}

function Highlighted({
  text,
  names,
}: {
  text: string
  names: GeoAnswerDetail['names']
}): ReactNode {
  // 段落按位置切：位置就是身份（先算好键，不在渲染里用下标）
  const parts = useMemo(
    () => highlight(text, names).map((p, i) => ({ ...p, key: `s${i}` })),
    [text, names],
  )
  return parts.map((p) =>
    p.entity === undefined ? (
      <span key={p.key}>{p.text}</span>
    ) : (
      <mark
        key={p.key}
        data-entity={p.entity}
        data-testid={p.entity === 'ours' ? 'geo-mark-ours' : 'geo-mark-rival'}
        className={cn(
          'rounded px-0.5',
          p.entity === 'ours' ? 'bg-ws-good-bg text-ws-good' : 'bg-ws-warn-bg text-ws-warn',
        )}
      >
        {p.text}
      </mark>
    ),
  )
}

function Timeline({ history }: { history: GeoAnswerDetail['history'] }): ReactNode {
  const { t } = useApp()
  if (history.length < 2) return null
  return (
    <div className="flex flex-col gap-1" data-testid="geo-answer-timeline">
      <span className="text-xs text-ws-muted-fg">
        {t('geo.answer.timeline', { n: String(history.length) })}
      </span>
      <ol className="flex items-end gap-1.5" data-slot="data">
        {history.map((h) => {
          const label =
            h.state === 'mentioned'
              ? h.rank === undefined
                ? t('geo.cell.mentioned_norank')
                : t('geo.cell.mentioned', { n: String(h.rank) })
              : t(h.state === 'absent' ? 'geo.cell.absent' : 'geo.cell.failed')
          return (
            <li
              key={h.week}
              title={`${h.week} · ${label}`}
              className="flex flex-col items-center gap-0.5"
              data-state={h.state}
            >
              <span className="ws-num h-3 text-[10px] text-ws-good">{h.rank ?? ''}</span>
              <span
                className={cn(
                  'inline-block size-2.5 rounded-full',
                  h.state === 'mentioned' && 'bg-ws-good',
                  h.state === 'absent' && 'bg-ws-muted-fg/40',
                  h.state === 'failed' && 'border border-ws-muted-fg/50',
                )}
              />
            </li>
          )
        })}
      </ol>
    </div>
  )
}

export function GeoAnswerView({ detail }: { detail: GeoAnswerDetail }): ReactNode {
  const { t } = useApp()
  const [open, setOpen] = useState(false)
  const [compare, setCompare] = useState(false)
  const a = detail.answer
  const prev = detail.previous
  const text = useMemo(() => plainOf(a.answer_md), [a.answer_md])
  const before = useMemo(() => (prev === undefined ? '' : plainOf(prev.answer.answer_md)), [prev])
  const ours = detail.mentions.find((m) => m.entity === 'ours')
  const sources = orderedSources(detail.citations)
  const prevDomains = new Set(
    (prev?.citations ?? []).filter((c) => c.where !== 'searched').map((c) => c.domain),
  )
  const nowDomains = new Set(sources.map((c) => c.domain))
  const gone = [...prevDomains].filter((d) => !nowDomains.has(d))
  const failed = a.status !== 'ok'
  return (
    <article className="flex flex-col gap-3" data-testid="geo-answer" data-answer={a.id}>
      <header className="flex flex-wrap items-center gap-1.5 text-xs text-ws-muted-fg">
        <span className="font-medium text-ws-ink">{t(`geo.platform.${a.platform}`)}</span>
        {a.platform === 'claude' ? <Hint text={t('geo.claude.hint')} /> : null}
        <span>· {a.market}</span>
        <span>· {detail.week}</span>
        {ours?.sentiment === undefined ? null : (
          <span className="inline-flex items-center gap-0.5" data-testid="geo-answer-sentiment">
            <WsTag data-slot="badge" className="h-[18px] px-1.5 text-xs">
              {t(`geo.sentiment.${ours.sentiment}`)}
            </WsTag>
            <Hint text={t('geo.sentiment.hint', { quote: ours.sentiment_quote ?? '' })} />
          </span>
        )}
      </header>
      <h4 className="text-sm font-medium" data-slot="title">
        {a.asked_text}
      </h4>
      {failed ? (
        <p className="text-sm text-ws-muted-fg" data-slot="status">
          {t('geo.answer.failed')}
        </p>
      ) : compare && prev !== undefined ? (
        <div
          className="whitespace-pre-wrap text-[13px] leading-6 text-ws-body"
          data-testid="geo-answer-diff"
          data-slot="data"
        >
          {diffText(before, text)
            .map((p, i) => ({ ...p, key: `d${i}` }))
            .map((p) =>
              p.kind === 'same' ? (
                <span key={p.key}>{p.text}</span>
              ) : p.kind === 'add' ? (
                <ins
                  key={p.key}
                  className="bg-ws-good-bg text-ws-good no-underline"
                  data-testid="geo-diff-add"
                >
                  {p.text}
                </ins>
              ) : (
                <del key={p.key} className="bg-ws-bad-bg text-ws-bad" data-testid="geo-diff-del">
                  {p.text}
                </del>
              ),
            )}
        </div>
      ) : (
        <div className="flex flex-col items-start gap-1">
          <div
            className={cn(
              'whitespace-pre-wrap text-[13px] leading-6 text-ws-body',
              !open && 'line-clamp-3',
            )}
            data-testid="geo-answer-text"
            data-open={open ? 'true' : 'false'}
            data-slot="data"
          >
            <Highlighted text={text} names={detail.names} />
          </div>
          <button
            type="button"
            className="text-xs text-ws-muted-fg underline-offset-2 hover:underline"
            data-testid="geo-answer-toggle"
            onClick={() => setOpen(!open)}
          >
            {open ? t('geo.answer.less') : t('geo.answer.more')}
          </button>
        </div>
      )}
      {failed ? null : (
        <section className="flex flex-col gap-1.5">
          <span className="text-xs text-ws-muted-fg">{t('geo.answer.sources')}</span>
          {sources.length === 0 ? (
            <p className="text-xs text-ws-muted-fg" data-slot="status">
              {t('geo.answer.no_sources')}
            </p>
          ) : (
            <ol
              className="flex flex-col gap-1 text-[13px]"
              data-testid="geo-answer-sources"
              data-slot="data"
            >
              {sources.map((c) => (
                <li
                  key={`${c.position}|${c.url}`}
                  className="flex min-w-0 items-center gap-1.5"
                  data-testid="geo-answer-source"
                  data-kind={c.site_kind}
                >
                  <span className="ws-num shrink-0 text-ws-muted-fg">{c.position}.</span>
                  <a
                    href={c.url}
                    target="_blank"
                    rel="noreferrer noopener"
                    className={cn(
                      'truncate underline-offset-2 hover:underline',
                      c.site_kind === 'ours' && 'font-semibold',
                    )}
                  >
                    {c.domain}
                    {c.title === undefined || c.title === c.domain ? '' : ` · ${c.title}`}
                  </a>
                  <KindTag kind={c.site_kind} />
                  {compare && prev !== undefined && !prevDomains.has(c.domain) ? (
                    <span
                      className="shrink-0 text-xs font-medium text-ws-info"
                      data-testid="geo-source-new"
                    >
                      {t('geo.sites.new')}
                    </span>
                  ) : null}
                </li>
              ))}
            </ol>
          )}
          {compare && gone.length > 0 ? (
            <p className="text-xs text-ws-muted-fg" data-testid="geo-source-gone">
              {t('geo.answer.gone')}：{gone.join('、')}
            </p>
          ) : null}
        </section>
      )}
      {prev === undefined || failed ? null : (
        <label className="flex items-center gap-1.5 text-xs" data-testid="geo-answer-compare">
          <input type="checkbox" checked={compare} onChange={(e) => setCompare(e.target.checked)} />
          {Date.parse(detail.week) - Date.parse(prev.week) === 7 * 86_400_000
            ? t('geo.answer.compare')
            : t('geo.answer.compare.at', { week: prev.week })}
        </label>
      )}
      <Timeline history={detail.history} />
    </article>
  )
}
