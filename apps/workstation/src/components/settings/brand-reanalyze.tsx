/**
 * WP346（决策 872）：设置页「重新分析一次」——老品牌也能把第二版那几格补上。
 *
 * 一条规矩：**重跑只出对比，不覆盖**。读完按格子列「现在 / 新的」，人勾哪格才写哪格：
 * - 现在空着的、现在还是「AI 建议」的：默认勾上（换一份更新的 AI 建议）；
 * - 人改过 / 人确认过的：默认不勾，标「你改过」（人说了算，要换得自己勾）；
 * - 和现在一样的：不列。
 *
 * 网址默认用档案里记的官网（品牌分析确认时存的），其次最近那一轮分析的链接。
 *
 * WP349：「新的」那一列挂来源（🔗 N，点开是联网搜到的网页）；联网那一步没联网 / 额度没查时照实说一句。
 */
import type { BrandCompetitor, BrandIntakeRun } from '@agentsws/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { RefreshCw } from 'lucide-react'
import { useEffect, useState } from 'react'
import {
  competitorSources,
  type SourceItem,
  SourceLinks,
} from '@/components/onboarding/brand-insight-fields'
import { webNotes, webSourcesOf } from '@/components/onboarding/brand-profile-card'
import { Button } from '@/components/ui/button'
import { Hint } from '@/components/ui/hint'
import { Input } from '@/components/ui/input'
import {
  adoptBrandIntake,
  getBrandIntake,
  startBrandIntake,
  type WorkspaceProfileView,
} from '@/lib/api'
import { useApp } from '@/lib/app-context'

/** 能采纳的那几格（与服务端 `ADOPTABLE_FIELDS` 同一组）。 */
const FIELDS = [
  'one_liner',
  'category',
  'subcategory',
  'positioning',
  'price_band',
  'audience',
  'keywords',
  'competitors',
  'support_email',
  'currency',
] as const
type Field = (typeof FIELDS)[number]

/** 一格的值画成一行字（对比表里用，不是编辑器）。 */
export function compactValue(v: unknown): string {
  if (v === undefined || v === null) return ''
  if (typeof v === 'string') return v
  if (Array.isArray(v))
    return v
      .map((x) =>
        typeof x === 'object' && x !== null ? String((x as { name?: unknown }).name) : x,
      )
      .join('、')
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>
    if (typeof o.buyers === 'string') return o.buyers
    return ['brand', 'category', 'scenario']
      .flatMap((g) => (Array.isArray(o[g]) ? (o[g] as string[]) : []))
      .join('、')
  }
  return String(v)
}

export interface CompareRow {
  field: Field
  now: unknown
  next: unknown
  /** 现在这一格是人给的（改过 / 确认过 / 不是 AI 填的）。 */
  human: boolean
  /** 默认勾不勾。 */
  pick: boolean
  /** WP349：新值是从哪几个网页看来的（联网搜到的）。 */
  sources: SourceItem[]
}

/** 档案 + 一次分析 → 对比行（一样的不列）。 */
export function compareRows(
  profile: WorkspaceProfileView | undefined,
  run: Pick<BrandIntakeRun, 'profile'>,
): CompareRow[] {
  const rows: CompareRow[] = []
  const web = webSourcesOf(run.profile, {}) as Partial<Record<string, SourceItem[]>>
  for (const field of FIELDS) {
    const next = (run.profile as Record<string, { value?: unknown } | undefined>)[field]?.value
    if (next === undefined || compactValue(next).trim() === '') continue
    const now = profile?.[field]
    if (JSON.stringify(now ?? null) === JSON.stringify(next)) continue
    const empty = now === undefined || compactValue(now).trim() === ''
    const ai = (profile?.ai_suggested ?? []).includes(field as never)
    const human = !empty && !ai
    const sources =
      field === 'competitors' ? competitorSources(next as BrandCompetitor[]) : (web[field] ?? [])
    rows.push({ field, now, next, human, pick: !human, sources })
  }
  return rows
}

export function BrandReanalyze({
  profile,
  lastUrl,
  assignment,
}: {
  profile?: WorkspaceProfileView
  lastUrl?: string
  assignment?: string
}): React.ReactNode {
  const { t } = useApp()
  const client = useQueryClient()
  const [open, setOpen] = useState(false)
  const [url, setUrl] = useState(profile?.website ?? lastUrl ?? '')
  const [runId, setRunId] = useState<string>()
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [adopted, setAdopted] = useState<number>()

  const start = useMutation({
    mutationFn: () => startBrandIntake({ urls: [url.trim()] }, assignment),
    onSuccess: (run) => {
      setAdopted(undefined)
      setRunId(run.id)
    },
  })
  const run = useQuery({
    queryKey: ['brand-intake', 'reanalyze', runId],
    queryFn: () => getBrandIntake(runId ?? '', assignment),
    enabled: runId !== undefined,
    refetchInterval: (q) => (q.state.data?.status === 'running' ? 800 : false),
  })
  const done =
    run.data !== undefined && run.data.status !== 'running' && run.data.status !== 'queued'
  const rows = done && run.data !== undefined ? compareRows(profile, run.data) : []
  // 读完的那一刻按默认勾选（空的 / 还是 AI 建议的勾上，人改过的不勾）
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只在换了一轮时重置勾选
  useEffect(() => {
    if (!done) return
    setPicked(new Set(rows.filter((r) => r.pick).map((r) => r.field)))
  }, [done, runId])

  const adopt = useMutation({
    mutationFn: () => adoptBrandIntake(runId ?? '', [...picked], undefined, assignment),
    onSuccess: async () => {
      setAdopted(picked.size)
      setRunId(undefined)
      await client.invalidateQueries({ queryKey: ['onboarding'] })
    },
  })

  if (!open)
    return (
      <div className="mt-3 flex items-center gap-1 border-t pt-3">
        <Button
          size="sm"
          variant="outline"
          data-testid="reanalyze-open"
          onClick={() => {
            setOpen(true)
          }}
        >
          <RefreshCw size={14} />
          {t('reanalyze.open')}
        </Button>
        <Hint text={t('reanalyze.hint')} />
        {adopted === undefined ? null : (
          <span className="text-xs text-muted-foreground" data-testid="reanalyze-done">
            {t('reanalyze.done', { n: adopted })}
          </span>
        )}
      </div>
    )

  return (
    <div className="mt-3 flex flex-col gap-3 border-t pt-3 text-sm" data-testid="reanalyze">
      <div className="flex items-center gap-2">
        <Input
          aria-label={t('reanalyze.url')}
          placeholder={t('reanalyze.url')}
          data-testid="reanalyze-url"
          value={url}
          onChange={(e) => {
            setUrl(e.target.value)
          }}
        />
        <Button
          size="sm"
          data-testid="reanalyze-start"
          disabled={url.trim() === '' || start.isPending || run.data?.status === 'running'}
          onClick={() => {
            start.mutate()
          }}
        >
          {t('reanalyze.start')}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setOpen(false)
          }}
        >
          {t('reanalyze.close')}
        </Button>
      </div>
      {run.data?.status === 'running' ? (
        <p className="text-xs text-muted-foreground" data-testid="reanalyze-running">
          {t('reanalyze.running')}
        </p>
      ) : null}
      {done && run.data?.status === 'failed' ? (
        <p role="alert" className="text-xs text-destructive">
          {run.data.failure}
        </p>
      ) : null}
      {/* WP349：联网那一步照实说（没联网 / 没搜成 / 额度没查的几部分） */}
      {done && run.data?.insights === 'done'
        ? webNotes(
            run.data.web,
            ((run.data.profile.competitors?.value ?? []) as BrandCompetitor[]).length,
          ).map((n) => (
            <p
              key={n.key}
              role="status"
              className="flex items-center gap-1 text-xs text-muted-foreground"
              data-testid="reanalyze-web-note"
            >
              {t(n.key)}
              {n.hint === undefined ? null : <Hint text={n.hint} />}
            </p>
          ))
        : null}
      {done && run.data?.status !== 'failed' && rows.length === 0 ? (
        <p className="text-xs text-muted-foreground" data-testid="reanalyze-nothing">
          {t('reanalyze.nothing')}
        </p>
      ) : null}
      {rows.length === 0 ? null : (
        <div className="flex flex-col gap-1" data-testid="reanalyze-compare">
          <div className="grid grid-cols-[6rem_1fr_1fr_4.5rem] gap-2 text-xs text-muted-foreground">
            <span />
            <span>{t('reanalyze.now')}</span>
            <span>{t('reanalyze.new')}</span>
            <span>{t('reanalyze.use')}</span>
          </div>
          {rows.map((r) => (
            <label
              key={r.field}
              className="grid grid-cols-[6rem_1fr_1fr_4.5rem] items-start gap-2 rounded-md px-1 py-1 hover:bg-ws-subtle"
              data-testid={`reanalyze-row-${r.field}`}
            >
              <span className="text-muted-foreground">{t(`intake.field.${r.field}`)}</span>
              <span className="min-w-0 break-words">
                {compactValue(r.now) || (
                  <span className="text-muted-foreground">{t('intake.empty')}</span>
                )}
                {r.human ? (
                  <span className="ml-1 text-xs text-muted-foreground">{t('reanalyze.human')}</span>
                ) : null}
              </span>
              <span className="flex min-w-0 flex-col items-start gap-0.5 break-words">
                {compactValue(r.next)}
                <SourceLinks field={`reanalyze-${r.field}`} items={r.sources} />
              </span>
              <input
                type="checkbox"
                className="mt-1"
                data-testid={`reanalyze-pick-${r.field}`}
                checked={picked.has(r.field)}
                onChange={(e) => {
                  const next = new Set(picked)
                  if (e.target.checked) next.add(r.field)
                  else next.delete(r.field)
                  setPicked(next)
                }}
              />
            </label>
          ))}
          <div className="flex justify-end">
            <Button
              size="sm"
              data-testid="reanalyze-adopt"
              disabled={picked.size === 0 || adopt.isPending}
              onClick={() => {
                adopt.mutate()
              }}
            >
              {t('reanalyze.adopt', { n: picked.size })}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
