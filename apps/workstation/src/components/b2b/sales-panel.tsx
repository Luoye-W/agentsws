/**
 * WP182（docs/84 §3）：「业务」职责页上那一块**能动手的**——事实卡、报价单、样品。
 *
 * 面板那四块（待回询盘 · 报价待审 · 样品在途 · 该唤醒的老客户）是只读表格；这里补"动手"那一半：
 * 六类事实卡齐没齐（按官网预填）、每张报价看报价单 PDF / 发给客户、样品往前走一步。
 *
 * 界面纪律（36 §7「界面少字」）：一行一件事；原因进问号；超期的红字写「超 N 天」。
 * 所有写动作都是出卡（发报价单、样品往前走），按钮按下去只说「出了一张卡」。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Briefcase, FileText, Send, Truck } from 'lucide-react'
import { useState } from 'react'
import { StatusPill } from '@/components/design/primitives'
import type { Tone } from '@/components/design/tone'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Hint } from '@/components/ui/hint'
import { Input } from '@/components/ui/input'
import {
  advanceB2bSample,
  type B2bSalesData,
  fetchB2bQuotePdf,
  getB2bSales,
  sendB2bQuote,
  setupB2bFacts,
} from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { useMode } from '@/lib/mode'

const FACT_TONE: Readonly<Record<string, Tone>> = { active: 'good', proposed: 'warn' }

type Sample = B2bSalesData['samples'][number]

/** 样品那一行的「下一步」：已寄要填单号，已反馈要写一句。 */
function SampleStep({
  sample,
  onAdvance,
  busy,
}: {
  sample: Sample
  onAdvance: (input: Parameters<typeof advanceB2bSample>[1]) => void
  busy: boolean
}): React.ReactNode {
  const { t } = useApp()
  const [open, setOpen] = useState(false)
  const [tracking, setTracking] = useState('')
  const [carrier, setCarrier] = useState('DHL')
  const [feedback, setFeedback] = useState('')
  if (sample.pending === true)
    return <StatusPill tone="neutral">{t('b2b.sales.sample.pending')}</StatusPill>
  if (sample.status === 'shipped')
    return (
      <Button
        size="xs"
        variant="ghost"
        disabled={busy}
        onClick={() => onAdvance({ status: 'delivered' })}
      >
        {t('b2b.sales.sample.delivered')}
      </Button>
    )
  if (!open)
    return (
      <Button
        size="xs"
        variant="ghost"
        disabled={busy}
        onClick={() => setOpen(true)}
        data-testid="b2b-sample-open"
      >
        {sample.status === 'to_ship' ? t('b2b.sales.sample.ship') : t('b2b.sales.sample.feedback')}
      </Button>
    )
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      {sample.status === 'to_ship' ? (
        <>
          <Input
            className="h-7 w-20"
            value={carrier}
            aria-label={t('b2b.sales.sample.carrier')}
            onChange={(e) => setCarrier(e.target.value)}
          />
          <Input
            className="h-7 w-36"
            value={tracking}
            placeholder={t('b2b.sales.sample.tracking')}
            data-testid="b2b-sample-tracking"
            onChange={(e) => setTracking(e.target.value)}
          />
        </>
      ) : (
        <Input
          className="h-7 w-48"
          value={feedback}
          placeholder={t('b2b.sales.sample.feedback_text')}
          onChange={(e) => setFeedback(e.target.value)}
        />
      )}
      <Button
        size="xs"
        disabled={busy}
        data-testid="b2b-sample-submit"
        onClick={() =>
          onAdvance(
            sample.status === 'to_ship'
              ? {
                  status: 'shipped',
                  ...(tracking.trim() === '' ? {} : { tracking_no: tracking.trim() }),
                  ...(carrier.trim() === '' ? {} : { carrier: carrier.trim() }),
                }
              : {
                  status: 'feedback',
                  ...(feedback.trim() === '' ? {} : { feedback: feedback.trim() }),
                },
          )
        }
      >
        <Send className="size-3.5" aria-hidden />
      </Button>
    </span>
  )
}

export function B2bSalesPanel({ assignment }: { assignment: string }): React.ReactNode {
  // WP275：① ② 报价「等你确认」，不写「上级批 / 老板批」
  const { t } = useMode()
  const qc = useQueryClient()
  const key = ['b2b-sales', assignment]
  const q = useQuery({ queryKey: key, queryFn: () => getB2bSales(assignment) })
  const [note, setNote] = useState<string | undefined>(undefined)
  const after = async (message?: string): Promise<void> => {
    setNote(message)
    await qc.invalidateQueries({ queryKey: key })
    await qc.invalidateQueries({ queryKey: ['view'] })
  }
  const setup = useMutation({
    mutationFn: () => setupB2bFacts(assignment),
    onSuccess: (d) => after(t('b2b.sales.facts.setup.done', { count: d.proposed })),
  })
  const send = useMutation({
    mutationFn: (id: string) => sendB2bQuote(id, {}, assignment),
    onSuccess: (d) => after(d.staged ? t('b2b.sales.quote.staged') : d.message),
    onError: (e) => setNote(e instanceof Error ? e.message : String(e)),
  })
  const advance = useMutation({
    mutationFn: (x: { id: string; input: Parameters<typeof advanceB2bSample>[1] }) =>
      advanceB2bSample(x.id, x.input, assignment),
    onSuccess: (d) => after(d.staged ? t('b2b.sales.quote.staged') : d.message),
  })
  const openPdf = async (id: string, version?: number): Promise<void> => {
    const blob = await fetchB2bQuotePdf(id, version, assignment)
    window.open(URL.createObjectURL(blob), '_blank', 'noopener')
  }
  const v = q.data
  if (v === undefined) return null
  const missing = v.facts.categories.filter((c) => c.card === undefined).length

  return (
    <Card data-testid="b2b-sales-panel">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Briefcase className="size-4" aria-hidden />
          {t('b2b.sales.title')}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 text-sm">
        {/* ① 六类事实卡 */}
        <section data-testid="b2b-facts" className="flex flex-wrap items-center gap-1.5">
          <span className="flex items-center gap-1 font-medium">
            {t('b2b.sales.facts')}
            <Hint text={t('b2b.sales.facts.hint')} />
          </span>
          {v.facts.categories.map((c) => (
            <StatusPill
              key={c.category}
              tone={FACT_TONE[c.card?.status ?? ''] ?? 'neutral'}
              data-fact={c.category}
              title={c.card?.statement ?? c.description}
            >
              {c.name}{' '}
              {c.card === undefined
                ? t('b2b.sales.fact.none')
                : c.card.status === 'active'
                  ? t('b2b.sales.fact.active')
                  : t('b2b.sales.fact.proposed')}
            </StatusPill>
          ))}
          {missing === 0 ? null : (
            <Button
              size="xs"
              variant="ghost"
              disabled={setup.isPending}
              onClick={() => setup.mutate()}
              data-testid="b2b-facts-setup"
            >
              {t('b2b.sales.facts.setup')}
            </Button>
          )}
        </section>

        {/* ② 报价：看报价单、发给客户（也出卡） */}
        <section data-testid="b2b-quotes" className="flex flex-col gap-1.5">
          <div className="font-medium">{t('b2b.sales.quotes')}</div>
          {v.quotes.length === 0 ? (
            <p className="text-ws-muted-fg">{t('b2b.sales.quotes.empty')}</p>
          ) : (
            v.quotes.map((row) => (
              <div
                key={row.id}
                className="flex flex-wrap items-center gap-2"
                data-testid="b2b-quote-row"
              >
                <span className="font-medium">{row.account}</span>
                <span className="text-ws-muted-fg">
                  {row.number} · V{row.version}
                </span>
                <span className="ws-num">${row.amount_usd.toLocaleString('en-US')}</span>
                {row.pending === undefined ? null : (
                  <StatusPill tone={row.pending.breaches.length > 0 ? 'warn' : 'neutral'}>
                    {t('b2b.sales.quote.pending', {
                      version: row.pending.version,
                      who: t(`b2b.sales.approver.${row.pending.approver ?? 'role_holder'}`),
                    })}
                  </StatusPill>
                )}
                {row.status === 'sent' ? (
                  <StatusPill tone="good">{t('b2b.sales.quote.sent')}</StatusPill>
                ) : null}
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => void openPdf(row.id)}
                  data-testid="b2b-quote-pdf"
                >
                  <FileText className="size-3.5" aria-hidden />
                  {t('b2b.sales.quote.pdf')}
                </Button>
                {row.pending === undefined && row.status !== 'sent' ? (
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={send.isPending}
                    onClick={() => send.mutate(row.id)}
                    data-testid="b2b-quote-send"
                  >
                    <Send className="size-3.5" aria-hidden />
                    {t('b2b.sales.quote.send')}
                  </Button>
                ) : null}
              </div>
            ))
          )}
        </section>

        {/* ③ 样品：往前走一步（出卡）；超期的红字 */}
        <section data-testid="b2b-samples" className="flex flex-col gap-1.5">
          <div className="flex items-center gap-1.5 font-medium">
            <Truck className="size-4" aria-hidden />
            {t('b2b.sales.samples')}
            <Hint text={t('b2b.sales.sample.hint')} />
          </div>
          {v.samples.length === 0 ? (
            <p className="text-ws-muted-fg">{t('b2b.sales.samples.empty')}</p>
          ) : (
            v.samples.map((s) => (
              <div
                key={s.id}
                className="flex flex-wrap items-center gap-2"
                data-testid="b2b-sample-row"
              >
                <span className="font-medium">{s.account}</span>
                <span className="text-ws-muted-fg">{s.items}</span>
                <StatusPill tone="neutral">{t(`b2b.sales.sample.status.${s.status}`)}</StatusPill>
                {s.tracking_no === undefined ? null : (
                  <span className="ws-num text-xs">{s.tracking_no}</span>
                )}
                {s.overdue_days === undefined ? (
                  s.due === undefined ? null : (
                    <span className="text-xs text-ws-muted-fg">{s.due}</span>
                  )
                ) : (
                  <span className="text-xs text-ws-bad" data-testid="b2b-sample-overdue">
                    {t('b2b.sales.sample.overdue', { days: s.overdue_days })}
                  </span>
                )}
                <SampleStep
                  sample={s}
                  busy={advance.isPending}
                  onAdvance={(input) => advance.mutate({ id: s.id, input })}
                />
              </div>
            ))
          )}
        </section>

        {/* ④ 等老板批的离职交接（卡在待办里，这里一句提示） */}
        {v.handovers.map((h) => (
          <p key={h.id} className="text-ws-muted-fg" data-testid="b2b-handover">
            {t('b2b.sales.handover', { who: h.departing, count: h.items + h.unassigned })}
          </p>
        ))}
        {note === undefined ? null : (
          <p className="text-ws-muted-fg" data-testid="b2b-sales-note">
            {note}
          </p>
        )}
      </CardContent>
    </Card>
  )
}
