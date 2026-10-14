/**
 * WP317（docs/101 §5.1④，决策 559）：投放职责页上的**素材流水线**。
 *
 * 一行一步：传导出表 → 出新文案（标题、描述两个子 Agent）→ 下载上传表 / 交设计岗出图；
 * 下面是实验记录（假设 / 改了什么 / 结果）。
 *
 * 界面纪律（36 §7「界面少字」）：字数写成「18/30」，挡下来的理由进问号；
 * 没接真模型时那一句照实摆出来。这一块**不碰广告后台**：上传表是人自己下载去传的。
 */
import type {
  AdCreativePlatform,
  AdCreativeRound,
  AdExperimentEntry,
  AdUploadSheet,
  AdUploadSheetFile,
} from '@agentsws/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Download, FlaskConical, ImagePlus, Sparkles, Upload } from 'lucide-react'
import { useRef, useState } from 'react'
import { StatusPill } from '@/components/design/primitives'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Hint } from '@/components/ui/hint'
import { Input } from '@/components/ui/input'
import {
  type AdCreativeDesignData,
  type AdCreativeImportData,
  addAdExperiment,
  getAdCreativeSheet,
  importAdCreativeExport,
  listAdExperiments,
  requestAdCreativeDesign,
  rewriteAdCreative,
  updateAdExperiment,
} from '@/lib/api'
import { useApp } from '@/lib/app-context'

/** 投放职责 → 平台（这一块只有 Google / Meta 两家有导出表与上传表）。 */
export function adCreativePlatformOf(role_id: string): AdCreativePlatform | undefined {
  return role_id === 'ads.google' ? 'google' : role_id === 'ads.meta' ? 'meta' : undefined
}

/**
 * 读用户选的那张表，原样转成 base64 交给服务端（服务端用 WP314 的 `decodeExportBytes` 按 BOM 解，
 * Google「Excel CSV」那种 UTF-16 也认）。FileReader：老一点的内核也有。
 */
function readBase64(f: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const url = typeof reader.result === 'string' ? reader.result : ''
      resolve(url.slice(url.indexOf(',') + 1))
    }
    reader.onerror = () => reject(reader.error ?? new Error('读不了这个文件'))
    reader.readAsDataURL(f)
  })
}

/** 浏览器里存成文件（不经任何第三方）。 */
function saveFile(file: AdUploadSheetFile): void {
  const data =
    file.base64 === undefined
      ? (file.text ?? '')
      : Uint8Array.from(atob(file.base64), (c) => c.charCodeAt(0))
  const blob = new Blob([data], { type: file.content_type })
  const filename = file.name
  const href = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = href
  a.download = filename
  a.click()
  URL.revokeObjectURL(href)
}

function RoundView({ round }: { round: AdCreativeRound }): React.ReactNode {
  const { t } = useApp()
  return (
    <div className="flex flex-col gap-3" data-testid="ad-creative-round">
      {round.notes.map((n) => (
        <p key={n} className="text-muted-foreground text-xs">
          {n}
        </p>
      ))}
      {round.rewrites.map((r) => (
        <div key={r.ad_id} className="rounded-md border p-2" data-ad={r.ad_id}>
          <div className="mb-1 flex items-center gap-2 text-sm">
            <span className="truncate font-medium">
              {r.campaign} · {r.ad_group}
            </span>
            {r.rejected.length > 0 ? (
              <span className="flex items-center gap-1">
                <StatusPill tone="warn">
                  {t('ads.creative.rejected', { n: r.rejected.length })}
                </StatusPill>
                <Hint text={r.rejected.map((x) => `「${x.text}」${x.reason}`).join('\n')} />
              </span>
            ) : null}
          </div>
          {[...r.headlines, ...r.descriptions].map((line) => (
            <div
              key={`${line.field}:${line.text}`}
              className="flex items-baseline justify-between gap-2 text-sm"
              data-field={line.field}
            >
              <span>{line.text}</span>
              <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
                {line.chars}/{line.limit}
              </span>
            </div>
          ))}
          {r.notes.map((n) => (
            <p key={n} className="text-muted-foreground mt-1 text-xs">
              {n}
            </p>
          ))}
        </div>
      ))}
    </div>
  )
}

function Experiments({
  assignment,
  round_id,
}: {
  assignment: string
  round_id?: string | undefined
}): React.ReactNode {
  const { t } = useApp()
  const qc = useQueryClient()
  const key = ['ad-experiments', assignment]
  const q = useQuery({ queryKey: key, queryFn: () => listAdExperiments(assignment) })
  const [hypothesis, setHypothesis] = useState('')
  const [change, setChange] = useState('')
  const [results, setResults] = useState<Record<string, string>>({})
  const add = useMutation({
    mutationFn: () =>
      addAdExperiment(
        {
          hypothesis: hypothesis.trim(),
          change: change.trim(),
          ...(round_id === undefined ? {} : { round_id }),
        },
        assignment,
      ),
    onSuccess: async () => {
      setHypothesis('')
      setChange('')
      await qc.invalidateQueries({ queryKey: key })
    },
  })
  const fill = useMutation({
    mutationFn: (e: AdExperimentEntry) =>
      updateAdExperiment(e.id, { result: (results[e.id] ?? '').trim() }, assignment),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: key })
    },
  })
  const rows = q.data?.rows ?? []
  return (
    <div className="flex flex-col gap-2 border-t pt-3" data-testid="ad-experiments">
      <div className="flex items-center gap-2 text-sm font-medium">
        <FlaskConical className="size-4" aria-hidden />
        {t('ads.creative.exp.title')}
        <Hint text={t('ads.creative.exp.hint')} />
      </div>
      {rows.map((e) => (
        <div key={e.id} className="text-sm" data-round={e.round}>
          <span className="text-muted-foreground mr-1 tabular-nums">#{e.round}</span>
          {e.hypothesis} → {e.change}
          {e.result === undefined || e.result === '' ? (
            <span className="mt-1 flex gap-2">
              <Input
                className="h-7"
                placeholder={t('ads.creative.exp.result')}
                value={results[e.id] ?? ''}
                onChange={(ev) => setResults({ ...results, [e.id]: ev.target.value })}
              />
              <Button
                size="sm"
                variant="outline"
                disabled={(results[e.id] ?? '').trim() === '' || fill.isPending}
                onClick={() => fill.mutate(e)}
              >
                {t('ads.creative.exp.save')}
              </Button>
            </span>
          ) : (
            <span className="text-muted-foreground"> · {e.result}</span>
          )}
        </div>
      ))}
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input
          className="h-8"
          placeholder={t('ads.creative.exp.hypothesis')}
          value={hypothesis}
          onChange={(ev) => setHypothesis(ev.target.value)}
        />
        <Input
          className="h-8"
          placeholder={t('ads.creative.exp.change')}
          value={change}
          onChange={(ev) => setChange(ev.target.value)}
        />
        <Button
          size="sm"
          variant="outline"
          disabled={hypothesis.trim() === '' || change.trim() === '' || add.isPending}
          onClick={() => add.mutate()}
          data-testid="ad-exp-add"
        >
          {t('ads.creative.exp.add')}
        </Button>
      </div>
    </div>
  )
}

export function AdCreativePanel({
  assignment,
  platform,
}: {
  assignment: string
  platform: AdCreativePlatform
}): React.ReactNode {
  const { t } = useApp()
  const file = useRef<HTMLInputElement>(null)
  const [imp, setImp] = useState<AdCreativeImportData | undefined>(undefined)
  const [round, setRound] = useState<AdCreativeRound | undefined>(undefined)
  const [design, setDesign] = useState<AdCreativeDesignData | undefined>(undefined)
  const upload = useMutation({
    mutationFn: async (f: File) =>
      importAdCreativeExport({ platform, base64: await readBase64(f) }, assignment),
    onSuccess: (data) => {
      setImp(data)
      setRound(undefined)
      setDesign(undefined)
    },
  })
  const rewrite = useMutation({
    mutationFn: () => rewriteAdCreative({ import_id: imp?.id ?? '' }, assignment),
    onSuccess: (data) => {
      setRound(data)
      setDesign(undefined)
    },
  })
  const [pageId, setPageId] = useState('')
  const [imageHash, setImageHash] = useState('')
  const [sheetView, setSheetView] = useState<AdUploadSheet | undefined>(undefined)
  const sheet = useMutation({
    mutationFn: () =>
      getAdCreativeSheet(
        round?.id ?? '',
        platform === 'meta' ? { page_id: pageId.trim(), image_hash: imageHash.trim() } : {},
        assignment,
      ),
    onSuccess: (s) => {
      setSheetView(s)
      if (s.ok) for (const f of s.files) saveFile(f)
    },
  })
  const toDesign = useMutation({
    mutationFn: () => requestAdCreativeDesign(round?.id ?? '', {}, assignment),
    onSuccess: setDesign,
  })
  const weak = imp?.weak.filter((w) => w.verdict === 'weak') ?? []
  const thin = imp?.weak.filter((w) => w.verdict === 'thin') ?? []
  const accepted =
    round?.rewrites.reduce((n, r) => n + r.headlines.length + r.descriptions.length, 0) ?? 0
  const error = upload.error ?? rewrite.error ?? sheet.error ?? toDesign.error

  return (
    <Card data-testid="ad-creative-panel">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Sparkles className="size-4" aria-hidden />
          {t('ads.creative.title')}
          <Hint text={t('ads.creative.hint')} />
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={file}
            type="file"
            accept=".csv,.tsv,.txt"
            className="hidden"
            data-testid="ad-creative-file"
            onChange={(ev) => {
              const f = ev.target.files?.[0]
              if (f !== undefined) upload.mutate(f)
              ev.target.value = ''
            }}
          />
          <Button
            size="sm"
            variant="outline"
            onClick={() => file.current?.click()}
            disabled={upload.isPending}
          >
            <Upload className="size-4" aria-hidden />
            {t('ads.creative.upload')}
          </Button>
          {imp === undefined ? null : (
            <span className="text-muted-foreground text-sm" data-testid="ad-creative-summary">
              {t('ads.creative.summary', { rows: imp.rows, weak: weak.length })}
              {thin.length > 0 ? ` · ${t('ads.creative.thin', { n: thin.length })}` : ''}
            </span>
          )}
          {imp !== undefined && imp.notes.length > 0 ? <Hint text={imp.notes.join('\n')} /> : null}
        </div>
        {weak.length > 0 ? (
          <ul className="flex flex-col gap-1 text-sm" data-testid="ad-creative-weak">
            {weak.slice(0, 8).map((w) => (
              <li key={w.ad_id} className="flex items-center gap-2">
                <span className="truncate">
                  {w.campaign} · {w.ad_group}
                </span>
                <Hint text={w.reason} />
              </li>
            ))}
          </ul>
        ) : null}
        {weak.length > 0 ? (
          <div>
            <Button
              size="sm"
              onClick={() => rewrite.mutate()}
              disabled={rewrite.isPending}
              data-testid="ad-creative-rewrite"
            >
              <Sparkles className="size-4" aria-hidden />
              {rewrite.isPending ? t('ads.creative.writing') : t('ads.creative.rewrite')}
            </Button>
          </div>
        ) : null}
        {round === undefined ? null : <RoundView round={round} />}
        {round !== undefined && accepted > 0 ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => sheet.mutate()}
              disabled={sheet.isPending}
            >
              <Download className="size-4" aria-hidden />
              {t('ads.creative.sheet')}
            </Button>
            <Hint text={t('ads.creative.sheet.hint')} />
            {platform === 'meta' ? (
              <>
                <Input
                  className="h-8 w-32"
                  placeholder={t('ads.creative.meta.page')}
                  value={pageId}
                  onChange={(ev) => setPageId(ev.target.value)}
                />
                <Input
                  className="h-8 w-32"
                  placeholder={t('ads.creative.meta.image')}
                  value={imageHash}
                  onChange={(ev) => setImageHash(ev.target.value)}
                />
              </>
            ) : null}
            <Button
              size="sm"
              variant="outline"
              onClick={() => toDesign.mutate()}
              disabled={toDesign.isPending || design?.requested === true}
            >
              <ImagePlus className="size-4" aria-hidden />
              {t('ads.creative.design')}
            </Button>
            {design === undefined ? null : (
              <span className="text-muted-foreground text-sm" data-testid="ad-creative-design">
                {design.requested
                  ? t('ads.creative.design.done', { n: design.variants })
                  : design.notes.join(' ')}
              </span>
            )}
          </div>
        ) : null}
        {sheetView === undefined ? null : (
          <div className="text-sm" data-testid="ad-creative-sheet">
            <span className={sheetView.ok ? 'text-muted-foreground' : 'text-destructive'}>
              {sheetView.ok ? sheetView.sentence : t('ads.creative.sheet.blocked')}
            </span>
            {sheetView.problems.length > 0 ? <Hint text={sheetView.problems.join('\n')} /> : null}
          </div>
        )}
        {error === null || error === undefined ? null : (
          <p className="text-destructive text-sm">
            {error instanceof Error ? error.message : String(error)}
          </p>
        )}
        <Experiments assignment={assignment} round_id={round?.id} />
      </CardContent>
    </Card>
  )
}
