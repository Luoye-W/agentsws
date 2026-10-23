/**
 * WP489（决策 1683–1686）：导入红人表（Excel / CSV / 在线表格链接）→ 就地预览、可改列与状态对照 → 导入；
 * 导完（或随时）「用邮件更新状态」：先估人数与花费，点了才判。
 *
 * 界面少字：说明进问号，卡上只有数字、下拉和两个按钮。
 */
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Link2, Mail, Upload } from 'lucide-react'
import { useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Hint } from '@/components/ui/hint'
import { Input } from '@/components/ui/input'
import {
  commitKolImport,
  estimateKolMailStages,
  type KolImportPreviewData,
  type KolMailStageEstimateData,
  previewKolImport,
  runKolMailStages,
} from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { errorText, KolError, KolReceipt, refreshCards } from './kol-shared'

/** 下拉里能选的列（与服务端 `SHEET_FIELDS` 同一份；`ignore` 放最后）。 */
const FIELDS = [
  'display_name',
  'url',
  'handle',
  'channel',
  'email',
  'followers',
  'engagement_rate',
  'category',
  'language',
  'region',
  'status',
  'collab_type',
  'amount',
  'currency',
  'date',
  'notes',
  'owner',
  'content_url',
  'ignore',
] as const

const STAGES = [
  'sourced',
  'contacted',
  'replied',
  'negotiating',
  'agreed',
  'sample_sent',
  'delivering',
  'delivered',
  'closed',
  'declined',
] as const

const CURRENCIES = ['USD', 'CNY', 'EUR', 'GBP', 'HKD', 'JPY'] as const

const selectCls =
  'h-7 rounded-md border border-input bg-background px-1.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring'

function toBase64(file: File): Promise<string> {
  // FileReader 而不是 `file.arrayBuffer()`：老一点的内核（与测试环境）没有后者
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const url = typeof reader.result === 'string' ? reader.result : ''
      resolve(url.slice(url.indexOf(',') + 1))
    }
    reader.onerror = () => reject(reader.error ?? new Error('读不了这个文件'))
    reader.readAsDataURL(file)
  })
}

export function KolSheetImport({ assignment }: { assignment: string }): React.ReactNode {
  const { t } = useApp()
  const client = useQueryClient()
  const fileRef = useRef<HTMLInputElement>(null)
  const [link, setLink] = useState('')
  const [preview, setPreview] = useState<KolImportPreviewData | undefined>(undefined)
  const [columns, setColumns] = useState<(string | null)[]>([])
  const [statuses, setStatuses] = useState<Record<string, string | null>>({})
  const [currency, setCurrency] = useState('USD')
  const [error, setError] = useState<string | undefined>(undefined)
  const [receipt, setReceipt] = useState<string | undefined>(undefined)
  const [months, setMonths] = useState('12')
  const [estimate, setEstimate] = useState<KolMailStageEstimateData | undefined>(undefined)

  const onPreview = (out: KolImportPreviewData): void => {
    setReceipt(undefined)
    if (!out.ok) {
      setPreview(undefined)
      setError(out.message ?? t('kol.sheet.unreadable'))
      return
    }
    setError(undefined)
    setPreview(out)
    setColumns((out.columns ?? []).map((c) => c.field))
    setStatuses(Object.fromEntries((out.statuses ?? []).map((s) => [s.source, s.stage])))
    setCurrency(out.currency)
  }

  const doPreview = useMutation({
    mutationFn: (input: {
      filename?: string
      content?: string
      content_base64?: string
      url?: string
    }) => previewKolImport(input, assignment),
    onSuccess: onPreview,
    onError: (e: unknown) => {
      setPreview(undefined)
      setError(errorText(e, t('kol.sheet.unreadable')))
    },
  })

  const doCommit = useMutation({
    mutationFn: () =>
      commitKolImport(
        {
          job_id: preview?.job_id ?? '',
          columns,
          statuses: Object.entries(statuses).map(([source, stage]) => ({ source, stage })),
          currency,
        },
        assignment,
      ),
    onSuccess: (out) => {
      setError(undefined)
      setPreview(undefined)
      setReceipt(out.summary)
      for (const key of ['kol-creators', 'kol-collaborations'])
        void client.invalidateQueries({ queryKey: [key] })
    },
    onError: (e: unknown) => setError(errorText(e, t('kol.sheet.failed'))),
  })

  const doEstimate = useMutation({
    mutationFn: () => estimateKolMailStages(Number(months) || 12, assignment),
    onSuccess: (out) => {
      setError(undefined)
      setEstimate(out)
    },
    onError: (e: unknown) => setError(errorText(e, t('kol.mailstage.failed'))),
  })

  const doRun = useMutation({
    mutationFn: () => runKolMailStages(Number(months) || 12, assignment),
    onSuccess: (out) => {
      setError(undefined)
      setEstimate(undefined)
      setReceipt(out.summary)
      void client.invalidateQueries({ queryKey: ['kol-collaborations'] })
      refreshCards(client)
    },
    onError: (e: unknown) => setError(errorText(e, t('kol.mailstage.failed'))),
  })

  const busy = doPreview.isPending || doCommit.isPending
  const hasAmount = columns.includes('amount')

  return (
    <section className="flex flex-col gap-2" data-testid="kol-sheet-import">
      <div className="flex flex-wrap items-center gap-1.5">
        <input
          ref={fileRef}
          type="file"
          accept=".xlsx,.xls,.csv,.tsv,text/csv,text/tab-separated-values"
          className="hidden"
          data-testid="kol-import-file"
          onChange={(e) => {
            const file = e.target.files?.[0]
            e.target.value = ''
            if (file === undefined) return
            void toBase64(file).then((content_base64) =>
              doPreview.mutate({ filename: file.name, content_base64 }),
            )
          }}
        />
        <Button
          size="sm"
          variant="outline"
          data-testid="kol-import"
          disabled={busy}
          onClick={() => fileRef.current?.click()}
        >
          <Upload className="size-4" aria-hidden />
          {t('kol.import')}
        </Button>
        <Input
          value={link}
          onChange={(e) => setLink(e.target.value)}
          placeholder={t('kol.sheet.link')}
          className="h-8 w-48 text-xs"
          data-testid="kol-import-link"
        />
        <Button
          size="sm"
          variant="ghost"
          data-testid="kol-import-link-go"
          disabled={busy || !/^https?:\/\//i.test(link.trim())}
          onClick={() => doPreview.mutate({ url: link.trim() })}
        >
          <Link2 className="size-4" aria-hidden />
          {t('kol.sheet.read')}
        </Button>
        <Hint text={t('kol.import.hint')} className="align-middle" testId="kol-import-hint" />
        <Button
          size="sm"
          variant="ghost"
          data-testid="kol-mailstage"
          disabled={doEstimate.isPending || doRun.isPending}
          onClick={() => doEstimate.mutate()}
        >
          <Mail className="size-4" aria-hidden />
          {t('kol.mailstage.go')}
        </Button>
      </div>

      {preview === undefined ? null : (
        <div
          className="flex flex-col gap-2 rounded-md border p-2 text-xs"
          data-testid="kol-import-preview"
        >
          <p className="font-medium" data-testid="kol-import-summary">
            {preview.summary}
          </p>
          <div className="flex flex-wrap gap-x-3 gap-y-1.5">
            {(preview.columns ?? []).map((c, i) => (
              <label
                // biome-ignore lint/suspicious/noArrayIndexKey: 列就是按位置认的（表头可能重名）
                key={`${c.header}-${i}`}
                className="flex items-center gap-1"
                title={c.samples.join(' · ')}
              >
                <span className="max-w-24 truncate text-muted-foreground">{c.header}</span>
                <select
                  className={selectCls}
                  value={columns[i] ?? ''}
                  data-testid="kol-import-col"
                  onChange={(e) =>
                    setColumns((prev) =>
                      prev.map((v, j) =>
                        j === i ? (e.target.value === '' ? null : e.target.value) : v,
                      ),
                    )
                  }
                >
                  <option value="">{t('kol.sheet.unmapped')}</option>
                  {FIELDS.map((f) => (
                    <option key={f} value={f}>
                      {t(`kol.field.${f}`)}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
          {(preview.statuses ?? []).length === 0 ? null : (
            <div className="flex flex-wrap gap-x-3 gap-y-1.5" data-testid="kol-import-statuses">
              {(preview.statuses ?? []).map((s) => (
                <label key={s.source} className="flex items-center gap-1">
                  <span className="max-w-28 truncate">
                    {s.source}
                    <span className="text-muted-foreground"> ×{s.count}</span>
                  </span>
                  <select
                    className={selectCls}
                    value={statuses[s.source] ?? ''}
                    data-testid="kol-import-status"
                    onChange={(e) =>
                      setStatuses((prev) => ({
                        ...prev,
                        [s.source]: e.target.value === '' ? null : e.target.value,
                      }))
                    }
                  >
                    <option value="">{t('kol.sheet.no_collab')}</option>
                    {STAGES.map((st) => (
                      <option key={st} value={st}>
                        {t(`kol.stage.${st}`)}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
          )}
          {hasAmount ? (
            <label className="flex items-center gap-1 text-muted-foreground">
              {t('kol.sheet.currency')}
              <select
                className={selectCls}
                value={currency}
                onChange={(e) => setCurrency(e.target.value)}
                data-testid="kol-import-currency"
              >
                {CURRENCIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <ul className="text-muted-foreground" data-testid="kol-import-rows">
            {(preview.rows ?? []).slice(0, 5).map((r) => (
              <li key={r.source_row} className="truncate">
                {r.source_row} · {r.name} ·{' '}
                {r.action === 'merge'
                  ? t('kol.sheet.merge_into', { name: r.merge_into ?? '' })
                  : r.action === 'skip'
                    ? (r.skip ?? t('kol.sheet.skip'))
                    : t('kol.sheet.create')}
                {r.stage === undefined ? '' : ` · ${t(`kol.stage.${r.stage}`)}`}
                {r.historical ? ` · ${t('kol.sheet.historical')}` : ''}
              </li>
            ))}
          </ul>
          <div className="flex gap-1.5">
            <Button
              size="sm"
              data-testid="kol-import-commit"
              disabled={doCommit.isPending}
              onClick={() => doCommit.mutate()}
            >
              {t('kol.sheet.commit')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setPreview(undefined)}>
              {t('kol.sheet.cancel')}
            </Button>
          </div>
        </div>
      )}

      {estimate === undefined ? null : (
        <div
          className="flex flex-wrap items-center gap-1.5 rounded-md border p-2 text-xs"
          data-testid="kol-mailstage-estimate"
        >
          <span>{estimate.summary}</span>
          {estimate.backfill_from === undefined ? null : (
            <span className="text-muted-foreground">{t('kol.mailstage.backfill')}</span>
          )}
          {estimate.mail_connected ? (
            <>
              <span className="flex items-center gap-1 text-muted-foreground">
                {t('kol.mailstage.months')}
                <Input
                  value={months}
                  onChange={(e) => setMonths(e.target.value.replace(/\D/g, '').slice(0, 2))}
                  onBlur={() => doEstimate.mutate()}
                  className="h-7 w-12 text-xs"
                  data-testid="kol-mailstage-months"
                  aria-label={t('kol.mailstage.months')}
                />
              </span>
              <Button
                size="sm"
                data-testid="kol-mailstage-run"
                disabled={doRun.isPending || estimate.creators === 0}
                onClick={() => doRun.mutate()}
              >
                {t('kol.mailstage.run')}
              </Button>
            </>
          ) : null}
        </div>
      )}

      <KolError error={error} testid="kol-import-error" />
      <KolReceipt text={receipt} testid="kol-import-result" />
    </section>
  )
}
