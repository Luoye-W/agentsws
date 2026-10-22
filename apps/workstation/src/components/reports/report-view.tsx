/**
 * WP438（WP434 设计 §3.3，决策 1335 改）：**一整份报表**——挂在第三栏里（`openRightPane({ kind: 'report', id })`）。
 *
 * 顶上那一条：关闭、岗位名、这个岗位固定的几份做成页签；最右「问 AI」、图钉、「⋯」（往回翻）。
 * 一份报表从上到下的写法固定（所有报表都一样）：
 * ① 标题 + 时间段 + 什么时候算的，右边 7 / 30 / 90 天；
 * ② 看完的结论三句（最后一句「要留意」）+ 动作钮（点了在这个岗位起一件事）；
 * ③ 一排数（每格写和前一段比）；④ 大趋势图（虚线上一段、蓝点是工坊做过的事）；
 * ⑤ 两列小块；⑥ 缺数据源的块原位占位 + 就地连接；⑦ 页底一句「想加一块？点『问 AI』」。
 */
import type { ReportData, ReportRange } from '@agentsws/deck'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { History, MoreHorizontal, Pin, PinOff, Send, Sparkles } from 'lucide-react'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { askAtPosition } from '@/components/position/quick-answer-store'
import { ReportBlock } from '@/components/reports/kit/blocks'
import { shortDay } from '@/components/reports/kit/format'
import { AiTag, ConclusionCard } from '@/components/reports/kit/parts'
import { closeRightPane, openRightPane } from '@/components/reports/right-pane'
import { usePositionInfo } from '@/components/reports/use-position-info'
import { useApp } from '@/lib/app-context'
import {
  getReport,
  getReportSnapshots,
  listReports,
  REPORTS_QUERY,
  reviseReport,
  unpinReport,
} from '@/lib/reports-api'
import { cn } from '@/lib/utils'

const RANGES: ReportRange[] = ['7d', '30d', '90d']
const DAYS: Record<ReportRange, number> = { '1d': 1, '7d': 7, '30d': 30, '90d': 90 }

const hhmm = (iso: string): string => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime())
    ? ''
    : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function RangePills({
  value,
  onChange,
}: {
  value: ReportRange
  onChange: (r: ReportRange) => void
}): ReactNode {
  const { t } = useApp()
  return (
    <div
      className="inline-flex rounded-[9px] bg-ws-secondary p-0.5"
      title={t('report.range')}
      data-testid="report-ranges"
    >
      {RANGES.map((r) => (
        <button
          key={r}
          type="button"
          aria-pressed={value === r}
          data-range={r}
          className={cn(
            'rounded-[7px] px-2.5 py-[3px] text-[12px]',
            value === r
              ? 'bg-ws-card font-semibold text-ws-ink shadow-[0_1px_2px_rgba(0,0,0,0.08)]'
              : 'text-ws-muted-fg hover:text-ws-ink',
          )}
          onClick={() => {
            onChange(r)
          }}
        >
          {t('report.range.days', { days: DAYS[r] })}
        </button>
      ))}
    </div>
  )
}

/** 「⋯」：往回翻（这份留过的快照）。 */
function MoreMenu({
  id,
  onPick,
  current,
}: {
  id: string
  onPick: (at: string | undefined) => void
  current: string | undefined
}): ReactNode {
  const { t } = useApp()
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement | null>(null)
  const snaps = useQuery({
    queryKey: [...REPORTS_QUERY, 'snapshots', id],
    queryFn: () => getReportSnapshots(id),
    enabled: open,
    retry: false,
  })
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (box.current !== null && !box.current.contains(e.target as Node)) setOpen(false)
    }
    globalThis.addEventListener?.('mousedown', onDown)
    return () => {
      globalThis.removeEventListener?.('mousedown', onDown)
    }
  }, [open])
  return (
    <div ref={box} className="relative">
      <button
        type="button"
        aria-label={t('report.menu')}
        title={t('report.menu')}
        aria-expanded={open}
        data-testid="report-more"
        className="grid size-7 place-items-center rounded-[7px] text-ws-muted-fg hover:bg-ws-secondary hover:text-ws-ink"
        onClick={() => {
          setOpen(!open)
        }}
      >
        <MoreHorizontal aria-hidden className="size-4" />
      </button>
      {open ? (
        <div
          role="menu"
          className="absolute top-full right-0 z-50 mt-1 w-60 rounded-[12px] bg-ws-card p-1.5 shadow-[0_16px_34px_rgba(20,40,30,0.14),0_0_0_1px_var(--ws-line)]"
          data-testid="report-history"
        >
          <p className="flex items-center gap-1.5 px-2 pt-1 pb-1.5 text-xs text-ws-muted-fg">
            <History aria-hidden className="size-3.5" />
            {t('report.history')}
          </p>
          <button
            type="button"
            role="menuitem"
            className={cn(
              'block w-full rounded-[8px] px-2 py-1.5 text-left text-[13px] hover:bg-ws-surface',
              current === undefined && 'font-semibold',
            )}
            onClick={() => {
              onPick(undefined)
              setOpen(false)
            }}
          >
            {t('report.history.now')}
          </button>
          {(snaps.data?.snapshots ?? []).slice(0, 12).map((s) => (
            <button
              key={`${s.at}-${s.range}`}
              type="button"
              role="menuitem"
              data-testid="report-snapshot"
              className={cn(
                'flex w-full justify-between rounded-[8px] px-2 py-1.5 text-left text-[13px] hover:bg-ws-surface',
                current === s.at && 'font-semibold',
              )}
              onClick={() => {
                onPick(s.at)
                setOpen(false)
              }}
            >
              <span>
                {shortDay(s.at.slice(0, 10))} {hhmm(s.at)}
              </span>
              <span className="text-ws-muted-fg">
                {t('report.range.days', { days: DAYS[s.range as ReportRange] ?? 30 })}
              </span>
            </button>
          ))}
          {snaps.data !== undefined && snaps.data.snapshots.length === 0 ? (
            <p className="px-2 py-1.5 text-[12px] text-ws-muted-fg">{t('report.history.none')}</p>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

/** 「问 AI」：AI 做的那份接着改（加一块）；默认报表就照这句做一份新的。 */
function AskBox({
  data,
  position,
  onDone,
}: {
  data: ReportData
  position: string | undefined
  onDone: () => void
}): ReactNode {
  const { t } = useApp()
  const client = useQueryClient()
  const [text, setText] = useState('')
  const [answer, setAnswer] = useState<string | undefined>(undefined)
  const revise = useMutation({
    mutationFn: (prompt: string) => reviseReport({ id: data.id, prompt }),
    onSuccess: (out) => {
      setAnswer(out.answer)
      if (out.changed) {
        setText('')
        void client.invalidateQueries({ queryKey: REPORTS_QUERY })
        onDone()
      }
    },
  })
  const send = (): void => {
    const prompt = text.trim()
    if (prompt === '') return
    if (data.origin === 'ai') revise.mutate(prompt)
    else
      openRightPane({
        kind: 'report-compose',
        ...(position === undefined ? {} : { position }),
        prompt: `做一份报表：${prompt}`,
      })
  }
  return (
    <div className="ws-card px-4 py-3" data-testid="report-ask">
      <div className="flex items-center gap-2">
        <Sparkles aria-hidden className="size-4 shrink-0 text-ws-brand" />
        <input
          // biome-ignore lint/a11y/noAutofocus: 点了「问 AI」就是要打字
          autoFocus
          value={text}
          placeholder={t(data.origin === 'ai' ? 'report.ask.revise' : 'report.ask.new')}
          aria-label={t('report.ask')}
          data-testid="report-ask-input"
          className="min-w-0 flex-1 bg-transparent text-[13.5px] outline-none placeholder:text-ws-faint"
          onChange={(e) => {
            setText(e.target.value)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) send()
          }}
        />
        <button
          type="button"
          aria-label={t('report.ask.send')}
          disabled={text.trim() === '' || revise.isPending}
          className="grid size-7 place-items-center rounded-full bg-ws-brand text-ws-brand-fg disabled:bg-ws-secondary disabled:text-ws-muted-fg"
          onClick={send}
        >
          <Send aria-hidden className="size-3.5" />
        </button>
      </div>
      {answer === undefined ? null : (
        <p className="mt-2 text-[12.5px] text-ws-muted-fg" role="status">
          {answer}
        </p>
      )}
    </div>
  )
}

export function ReportView({
  id,
  position: positionProp,
  duty,
}: {
  id: string
  position?: string
  duty?: string
}): ReactNode {
  const { t } = useApp()
  const navigate = useNavigate()
  const client = useQueryClient()
  const [range, setRange] = useState<ReportRange | undefined>(undefined)
  const [at, setAt] = useState<string | undefined>(undefined)
  const [asking, setAsking] = useState(false)
  const report = useQuery({
    queryKey: [...REPORTS_QUERY, 'one', id, range ?? 'default', at ?? 'now'],
    queryFn: () =>
      getReport({
        id,
        ...(range === undefined ? {} : { range }),
        ...(at === undefined ? {} : { at }),
      }),
    retry: false,
  })
  const data = report.data
  const position = positionProp ?? data?.position
  const info = usePositionInfo(position)
  const tabs = useQuery({
    queryKey: [...REPORTS_QUERY, 'list', position ?? '', duty ?? ''],
    queryFn: () =>
      listReports({
        position: position ?? '',
        ...(duty === undefined ? {} : { duty }),
      }),
    enabled: position !== undefined,
    retry: false,
    staleTime: 60_000,
  })
  const unpin = useMutation({
    mutationFn: () => unpinReport(id),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: REPORTS_QUERY })
      closeRightPane()
    },
  })
  const act = useMutation({
    mutationFn: async (prompt: string) => {
      const assignment = info.assignment
      if (assignment === undefined) return
      void askAtPosition({ position: assignment, text: prompt })
      void navigate(`/positions/${assignment}`)
    },
  })
  const effective = data?.range ?? range ?? '30d'
  const days = DAYS[effective]
  const list = tabs.data?.reports ?? []
  const shown = list

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="report-page" data-id={id}>
      {/* 顶上那一条：岗位名、同岗位报表页签；右边问 AI / 图钉 / ⋯ */}
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-ws-line px-3">
        {/* int/1024：收起用第三栏宿主头上那颗 ×（WP437），这里不再另放一颗 */}
        {info.name === undefined ? null : (
          <span className="shrink-0 px-1 text-[12.5px] text-ws-muted-fg">{info.name}</span>
        )}
        <div
          className="flex min-w-0 items-center gap-0.5 overflow-x-auto rounded-[9px] bg-ws-secondary/60 p-0.5"
          role="tablist"
          data-testid="report-tabs"
        >
          {shown.map((r) => (
            <button
              key={r.id}
              type="button"
              role="tab"
              aria-selected={r.id === id}
              data-testid="report-tab"
              data-id={r.id}
              className={cn(
                'flex shrink-0 items-center gap-1 rounded-[7px] px-2.5 py-1 text-[12.5px] whitespace-nowrap',
                r.id === id
                  ? 'bg-ws-card font-semibold text-ws-ink shadow-[0_1px_2px_rgba(0,0,0,0.08)]'
                  : 'text-ws-muted-fg hover:text-ws-ink',
              )}
              onClick={() => {
                openRightPane({
                  kind: 'report',
                  id: r.id,
                  ...(position === undefined ? {} : { position }),
                  ...(duty === undefined ? {} : { duty }),
                })
              }}
            >
              {r.title}
              {r.origin === 'ai' ? <AiTag /> : null}
            </button>
          ))}
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <button
            type="button"
            data-testid="report-ask-open"
            aria-pressed={asking}
            className="inline-flex h-7 items-center gap-1 rounded-[7px] px-2 text-[12.5px] text-ws-body hover:bg-ws-secondary"
            onClick={() => {
              setAsking(!asking)
            }}
          >
            <Sparkles aria-hidden className="size-3.5" />
            {t('report.ask')}
          </button>
          {data?.origin === 'ai' && data.id.startsWith('rpt_') ? (
            <button
              type="button"
              aria-label={t('report.unpin')}
              title={t('report.unpin')}
              data-testid="report-unpin"
              disabled={unpin.isPending}
              className="grid size-7 place-items-center rounded-[7px] text-ws-brand hover:bg-ws-secondary"
              onClick={() => {
                unpin.mutate()
              }}
            >
              <PinOff aria-hidden className="size-4" />
            </button>
          ) : (
            <span
              title={t(data?.id.startsWith('draft_') === true ? 'report.draft' : 'report.pinned')}
              className="grid size-7 place-items-center text-ws-brand"
              data-testid="report-pinned"
            >
              <Pin aria-hidden className="size-4" />
            </span>
          )}
          <MoreMenu id={id} current={at} onPick={setAt} />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="@container mx-auto flex max-w-[1080px] flex-col gap-3.5 px-6 pt-5 pb-14">
          {report.isPending ? (
            <p className="py-10 text-center text-[13px] text-ws-muted-fg">{t('report.loading')}</p>
          ) : data === undefined ? (
            <p className="py-10 text-center text-[13px] text-ws-muted-fg" role="alert">
              {t('report.missing')}
            </p>
          ) : (
            <>
              <header className="flex flex-wrap items-end gap-4 pb-1">
                <div className="min-w-0">
                  <h1 className="ws-display text-[24px] text-ws-ink" data-testid="report-title">
                    {data.title}
                  </h1>
                  <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12.5px] text-ws-muted-fg">
                    {data.origin === 'ai' && data.created !== undefined ? (
                      <>
                        <AiTag />
                        <span>
                          {t('report.created', {
                            date: shortDay(data.created.at.slice(0, 10)),
                            prompt: data.created.prompt,
                          })}
                        </span>
                        <span aria-hidden>·</span>
                      </>
                    ) : null}
                    <span data-slot="data">
                      {t('report.period', {
                        from: shortDay(data.period.from),
                        to: shortDay(data.period.to),
                        days,
                      })}
                    </span>
                    <span aria-hidden>·</span>
                    <span>
                      {'snapshot' in data
                        ? t('report.snapshot', {
                            date: shortDay(data.computed_at.slice(0, 10)),
                            time: hhmm(data.computed_at),
                          })
                        : t(`report.refresh.${data.refresh}`, { time: hhmm(data.computed_at) })}
                    </span>
                  </p>
                </div>
                <div className="ml-auto">
                  <RangePills
                    value={effective}
                    onChange={(r) => {
                      setAt(undefined)
                      setRange(r)
                    }}
                  />
                </div>
              </header>
              {asking ? (
                <AskBox
                  data={data}
                  position={position}
                  onDone={() => {
                    void report.refetch()
                  }}
                />
              ) : null}
              {data.conclusion === undefined ? null : (
                <ConclusionCard
                  conclusion={data.conclusion}
                  busy={act.isPending}
                  {...(info.assignment === undefined
                    ? {}
                    : {
                        onAction: (prompt: string) => {
                          act.mutate(prompt)
                        },
                      })}
                />
              )}
              <div className="grid grid-cols-1 gap-3.5 @3xl:grid-cols-2">
                {data.blocks.map((b) => (
                  <div
                    key={b.id}
                    className={cn(
                      'min-w-0',
                      (b.kind === 'kpis' || b.wide === true) && '@3xl:col-span-2',
                    )}
                  >
                    <ReportBlock block={b} days={days} />
                  </div>
                ))}
              </div>
              <p className="mt-2 flex items-center justify-center gap-2 text-[12px] text-ws-faint">
                <Sparkles aria-hidden className="size-3.5" />
                {t(data.origin === 'ai' ? 'report.foot.ai' : 'report.foot')}
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
