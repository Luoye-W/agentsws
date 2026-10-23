/**
 * WP488（决策 1680 / 1681 / 1686）：知识库页上「学一遍」那一块——两行：
 *
 * - **从过往邮件学**：回看月数（默认 12，能改）→ 点一下先出预估（问模型几次、约多少、上限装不装得下），再点「开始」；
 * - **从网站学**：官网 / 售后网站（不填 = 建品牌时的官网）→ 同样先预估再开始。
 *
 * 跑起来是一件事项（进度在事项里，也在这里一行）；学到的出一张汇总卡在「要你处理」里确认。界面少字：
 * 说明进问号；没接邮箱时「开始」照样能点——服务端在那件事里出连接卡（决策 690）。
 */
import type { KnowledgeLearnEstimate, KnowledgeLearnJob } from '@agentsws/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Globe, Mail } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { WsTag } from '@/components/design'
import { Button } from '@/components/ui/button'
import { Hint } from '@/components/ui/hint'
import {
  estimateKnowledgeLearn,
  type KnowledgeLearnInput,
  listKnowledgeLearnJobs,
  startKnowledgeLearn,
} from '@/lib/api'
import { useApp } from '@/lib/app-context'

export const LEARN_JOBS_KEY = ['knowledge-learn-jobs'] as const

/** 一次的进度那一句。 */
export function jobLine(job: KnowledgeLearnJob, t: ReturnType<typeof useApp>['t']): string {
  switch (job.state) {
    case 'running':
      return t('kl.job.running', { done: job.progress.done, total: job.progress.total })
    case 'done':
      return job.learned > 0 ? t('kl.job.done', { n: job.learned }) : t('kl.job.none')
    case 'needs_connection':
      return t('kl.job.needs_connection')
    case 'over_budget':
      return t('kl.job.over_budget')
    case 'no_model':
      return t('kl.job.no_model')
    default:
      return t('kl.job.failed', { note: job.note ?? '' })
  }
}

function EstimateLine({ e }: { e: KnowledgeLearnEstimate }): ReactNode {
  const { t } = useApp()
  const parts: string[] = []
  if (e.source === 'email' && e.connected === false) parts.push(t('kl.estimate.no_mail'))
  else {
    if (e.pairs !== undefined) parts.push(t('kl.estimate.pairs', { pairs: e.pairs }))
    parts.push(t('kl.estimate', { calls: e.calls }))
    if (e.cost !== undefined) parts.push(t('kl.estimate.cost', { cost: e.cost.toFixed(2) }))
  }
  if (!e.model) parts.push(t('kl.estimate.no_model'))
  if (!e.fits) parts.push(t('kl.estimate.over'))
  return (
    <span className="text-xs text-ws-muted-fg" data-testid="kl-estimate">
      {parts.join(' · ')}
    </span>
  )
}

export function LearnPanel(): ReactNode {
  const { t } = useApp()
  const client = useQueryClient()
  const navigate = useNavigate()
  const [months, setMonths] = useState(12)
  const [sites, setSites] = useState('')
  const [estimate, setEstimate] = useState<KnowledgeLearnEstimate | undefined>(undefined)
  const jobs = useQuery({
    queryKey: LEARN_JOBS_KEY,
    queryFn: () => listKnowledgeLearnJobs(),
    retry: false,
    // 有一次在跑就每 3 秒看一眼进度
    refetchInterval: (q) =>
      (q.state.data ?? []).some((j) => j.state === 'running') ? 3000 : false,
  })
  const inputOf = (source: 'email' | 'website'): KnowledgeLearnInput =>
    source === 'email'
      ? { source, months }
      : {
          source,
          urls: sites
            .split(/[\s,，]+/)
            .map((u) => u.trim())
            .filter((u) => u !== ''),
        }
  const preview = useMutation({
    mutationFn: (source: 'email' | 'website') => estimateKnowledgeLearn(inputOf(source)),
    onSuccess: setEstimate,
  })
  const start = useMutation({
    mutationFn: (source: 'email' | 'website') => startKnowledgeLearn(inputOf(source)),
    onSuccess: () => {
      setEstimate(undefined)
      void client.invalidateQueries({ queryKey: LEARN_JOBS_KEY })
    },
  })
  const latest = (jobs.data ?? []).slice(0, 3)
  const blocked = (e: KnowledgeLearnEstimate): boolean => !e.fits || !e.model

  const row = (source: 'email' | 'website'): ReactNode => (
    <div className="flex flex-wrap items-center gap-2" data-testid={`kl-row-${source}`}>
      {source === 'email' ? (
        <>
          <Mail aria-hidden className="size-4 text-ws-muted-fg" />
          <span className="text-sm text-ws-ink">{t('kl.email')}</span>
          <label className="inline-flex items-center gap-1 text-xs text-ws-muted-fg">
            {t('kl.email.months')}
            <input
              type="number"
              min={1}
              max={36}
              value={months}
              data-testid="kl-months"
              className="h-7 w-14 rounded-md border bg-ws-card px-1.5 text-sm text-ws-ink"
              onChange={(e) => {
                setMonths(Math.max(1, Math.min(36, Number(e.target.value) || 12)))
                setEstimate(undefined)
              }}
            />
            {t('kl.email.months.unit')}
          </label>
        </>
      ) : (
        <>
          <Globe aria-hidden className="size-4 text-ws-muted-fg" />
          <span className="text-sm text-ws-ink">{t('kl.site')}</span>
          <input
            value={sites}
            placeholder={t('kl.site.placeholder')}
            title={t('kl.site.default')}
            data-testid="kl-sites"
            className="h-7 min-w-0 flex-1 rounded-md border bg-ws-card px-2 text-sm text-ws-ink sm:max-w-80"
            onChange={(e) => {
              setSites(e.target.value)
              setEstimate(undefined)
            }}
          />
        </>
      )}
      {estimate?.source === source ? (
        <>
          <EstimateLine e={estimate} />
          <Button
            size="sm"
            data-testid={`kl-start-${source}`}
            disabled={start.isPending || blocked(estimate)}
            onClick={() => start.mutate(source)}
          >
            {t('kl.start')}
          </Button>
        </>
      ) : (
        <Button
          size="sm"
          variant="outline"
          data-testid={`kl-estimate-${source}`}
          disabled={preview.isPending}
          onClick={() => preview.mutate(source)}
        >
          {source === 'email' ? t('kl.email') : t('kl.site')}
        </Button>
      )}
      {source === 'email' ? <Hint text={t('kl.learn.hint')} /> : null}
    </div>
  )

  return (
    <div className="flex flex-col gap-2" data-testid="kl-panel">
      {row('email')}
      {row('website')}
      {preview.error === null && start.error === null ? null : (
        <p className="text-xs text-destructive">{(preview.error ?? start.error)?.message}</p>
      )}
      {latest.length === 0 ? null : (
        <ul className="flex flex-col gap-1 text-xs" data-testid="kl-jobs">
          {latest.map((j) => (
            <li key={j.id} className="flex items-center gap-2" data-state={j.state}>
              <WsTag>{j.source === 'email' ? t('kl.email') : t('kl.site')}</WsTag>
              <span className="text-ws-body" data-testid="kl-job-line">
                {jobLine(j, t)}
              </span>
              {j.approval_id !== undefined ? (
                <button
                  type="button"
                  className="text-ws-brand-ink hover:underline"
                  data-testid="kl-job-card"
                  onClick={() => navigate(`/cards/${j.approval_id ?? ''}`)}
                >
                  {t('kl.job.open')}
                </button>
              ) : j.matter_id !== undefined ? (
                <button
                  type="button"
                  className="text-ws-brand-ink hover:underline"
                  data-testid="kl-job-matter"
                  onClick={() => navigate(`/matters/${j.matter_id ?? ''}`)}
                >
                  {t('kl.job.open')}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
