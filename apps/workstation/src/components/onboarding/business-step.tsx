/**
 * 向导第 ② 步：**你的生意**——贴一个网址，剩下我们填（70 §3，WP121b）。
 *
 * 原来的「公司设置 / 个人设置」两步并进这一步：那两步问的东西，这一轮分析
 * 八成已经替用户填好了；让他先填一遍再让分析覆盖掉，是把同一件事问了两遍。
 * 所以这一屏的顺序是**先贴网址 → 看结果 → 顺带确认公司名与你的称呼**。
 *
 * 四件事这里说清：
 *
 * 1. **开跑前先报价**（70 §3.1）：预估与封顶都摆在按钮旁边。用官方接口的人
 *    手上只有注册送的 10 积分，他有权在按之前知道这一下要花多少。
 * 2. **真的在后台跑**：起完就轮询，用**呼吸标记**表示"Agent 在干活"（36 §12）。
 *    用户可以先去第 ③ 步选岗位，回来还看得见——现场由 `/runs/latest` 恢复。
 * 3. **抓不到就说抓不到**：失败的页面如实进 `pages`，这里原样显示那一句人话。
 * 4. **用官方接口跑的时候明说一句**：网页内容会经过 Agents 工坊的云来分析
 *    （70 §4 末段）。用自己的模型接口时这句话不出现——那时它不经我们的云。
 */
import { DEFAULT_BRAND_INTAKE_CAP_CREDITS } from '@agentsws/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { BrandMark } from '@/components/design'
import { BrandProfileCard } from '@/components/onboarding/brand-profile-card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  ApiClientError,
  type BrandIntakeRun,
  confirmBrandIntake,
  getBrandIntake,
  latestBrandIntake,
  reanalyzeBrandIntake,
  startBrandIntake,
} from '@/lib/api'
import { useApp } from '@/lib/app-context'

/** 这一轮还在跑吗（跑着的时候界面挂呼吸标记、轮询继续）。 */
export function isRunning(run: BrandIntakeRun | undefined): boolean {
  return run?.status === 'queued' || run?.status === 'running'
}

export interface BusinessStepProps {
  assignment?: string
  /** 这台机器上现在用的是官方接口吗（决定要不要说那一句"内容会经过我们的云"）。 */
  official: boolean
  /** 分析确认了 / 走了「还没有网站」旁路：把结果交给向导（它据此预勾岗位）。 */
  onSettled: (run: BrandIntakeRun | undefined) => void
  /** 公司名与称呼那一小块：确认后存下去。 */
  person: { name: string; email: string }
  onRename: (name: string) => void
  onCompanyName: (name: string) => void
  companyName: string
  /**
   * WP142：用户自己动过「公司全称」那一格没有。没动过就用分析出来的全称预填
   * ——档案卡上不再另出一格，公司全称只有这一个来源。
   */
  companyEdited?: boolean
}

export function BusinessStep({
  assignment,
  official,
  onSettled,
  person,
  onRename,
  onCompanyName,
  companyName,
  companyEdited = false,
}: BusinessStepProps): React.ReactNode {
  const { t } = useApp()
  const client = useQueryClient()
  const [url, setUrl] = useState('')
  const [second, setSecond] = useState('')
  const [runId, setRunId] = useState<string | undefined>(undefined)
  const [edits, setEdits] = useState<Record<string, unknown>>({})
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const [skipped, setSkipped] = useState(false)

  /** 回到这一步时先问一次"最近那一次是什么"——现场就是这么恢复的。 */
  const latest = useQuery({
    queryKey: ['brand-intake', 'latest', assignment],
    queryFn: () => latestBrandIntake(assignment),
    retry: false,
  })

  const currentId = runId ?? latest.data?.id

  const run = useQuery({
    queryKey: ['brand-intake', 'run', currentId, assignment],
    enabled: currentId !== undefined,
    queryFn: () => getBrandIntake(currentId ?? '', assignment),
    // 几十秒的事，两秒问一次够了；跑完就停
    refetchInterval: (query) => (isRunning(query.state.data) ? 2000 : false),
    initialData: runId === undefined ? (latest.data ?? undefined) : undefined,
  })

  const current = run.data

  const say = (err: unknown): void => {
    setFailure(err instanceof ApiClientError ? err.message : t('error.generic'))
  }

  const urls = (): string[] => [url.trim(), second.trim()].filter((u) => u !== '')

  const start = useMutation({
    mutationFn: () => startBrandIntake({ urls: urls() }, assignment),
    onSuccess: (fresh) => {
      setFailure(undefined)
      setRunId(fresh.id)
    },
    onError: say,
  })

  const again = useMutation({
    mutationFn: () => reanalyzeBrandIntake(currentId ?? '', urls(), assignment),
    onSuccess: (fresh) => {
      setFailure(undefined)
      setRunId(fresh.id)
    },
    onError: say,
  })

  const confirm = useMutation({
    mutationFn: () =>
      confirmBrandIntake(
        currentId ?? '',
        Object.keys(edits).length === 0 ? undefined : edits,
        assignment,
      ),
    onSuccess: (done) => {
      setFailure(undefined)
      // WP142：卡上当场显示「已确认」与那一句回执（不等下一次轮询）
      client.setQueryData(['brand-intake', 'run', done.id, assignment], done)
      setRunId(done.id)
      onSettled(done)
    },
    onError: say,
  })

  const busy = start.isPending || again.isPending || confirm.isPending || isRunning(current)
  const analyzedLegal = current?.profile.legal_name?.value
  const shownCompany =
    !companyEdited && typeof analyzedLegal === 'string' && analyzedLegal.trim() !== ''
      ? analyzedLegal
      : companyName
  const failedPages = (current?.pages ?? []).filter((p) => !p.ok)

  return (
    <div className="flex flex-col gap-4 text-sm" data-testid="onboarding-business">
      {/* ── 贴网址 ─────────────────────────────────────────────── */}
      {current === undefined || current.status === 'failed' ? (
        <div className="flex flex-col gap-2">
          <Label htmlFor="intake-url">{t('onboarding.business.url')}</Label>
          <div className="flex items-center gap-2">
            <Input
              id="intake-url"
              data-testid="intake-url"
              placeholder={t('onboarding.business.url.placeholder')}
              value={url}
              onChange={(e) => {
                setUrl(e.target.value)
              }}
            />
            <Button
              size="sm"
              disabled={busy || urls().length === 0}
              data-testid="intake-start"
              onClick={() => {
                start.mutate()
              }}
            >
              {t('onboarding.business.start')}
            </Button>
          </div>
          <Input
            data-testid="intake-url-2"
            aria-label={t('onboarding.business.url2')}
            placeholder={t('onboarding.business.url2.placeholder')}
            value={second}
            onChange={(e) => {
              setSecond(e.target.value)
            }}
          />
          {/* 开跑前报价：封顶摆在按钮旁边（70 §3.1）。超了就停，不问、不续 */}
          <p className="text-xs text-ws-muted-fg" data-testid="intake-estimate">
            {t('onboarding.business.estimate', { cap: DEFAULT_BRAND_INTAKE_CAP_CREDITS })}
          </p>
          {official ? (
            <p className="text-xs text-ws-muted-fg" data-testid="intake-cloud-note">
              {t('onboarding.business.cloud_note')}
            </p>
          ) : null}
          {current?.status === 'failed' ? (
            <p role="alert" className="text-destructive" data-testid="intake-failed">
              {current.failure ?? t('error.generic')}
            </p>
          ) : null}
          <button
            type="button"
            data-testid="intake-no-site"
            className="self-start text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            onClick={() => {
              setSkipped(true)
              onSettled(undefined)
            }}
          >
            {t('onboarding.business.no_site')}
          </button>
        </div>
      ) : null}

      {/* ── 在干活 ─────────────────────────────────────────────── */}
      {isRunning(current) ? (
        <div className="flex items-center gap-2 text-ws-muted-fg" data-testid="intake-working">
          <BrandMark size={20} motion="breathe" />
          {t('onboarding.business.working', {
            done: current?.pages.length ?? 0,
          })}
        </div>
      ) : null}

      {/* ── 档案卡 ─────────────────────────────────────────────── */}
      {current !== undefined &&
      (current.status === 'awaiting_confirm' ||
        current.status === 'budget_exceeded' ||
        current.status === 'confirmed') ? (
        <div className="flex flex-col gap-3">
          {current.status === 'budget_exceeded' ? (
            <p className="text-xs text-ws-muted-fg" data-testid="intake-capped">
              {t('onboarding.business.capped', { cap: current.budget.cap_credits })}
            </p>
          ) : null}
          <BrandProfileCard
            profile={current.profile}
            edits={edits}
            busy={busy}
            confirmed={current.status === 'confirmed'}
            onEdit={(field, value) => {
              setEdits((prev) => ({ ...prev, [field]: value }))
            }}
            onConfirm={() => {
              confirm.mutate()
            }}
            onReanalyze={() => {
              again.mutate()
            }}
          />
          {failedPages.length === 0 ? null : (
            <p className="text-xs text-ws-muted-fg" data-testid="intake-missed">
              {t('onboarding.business.missed', {
                count: failedPages.length,
                // WP142：句号由模板给，原因自己带的那个去掉（免得「。。」）
                reason: (failedPages[0]?.reason ?? '').replace(/[。.]+$/, ''),
              })}
            </p>
          )}
        </div>
      ) : null}

      {/* ── 顺带确认：公司名与你的称呼 ───────────────────────────── */}
      {current === undefined && !skipped ? null : (
        <div className="flex flex-col gap-2 border-t pt-3" data-testid="onboarding-person">
          <div className="flex flex-col gap-1">
            <Label htmlFor="company-name">{t('onboarding.company.legal_name')}</Label>
            <Input
              id="company-name"
              data-testid="company-legal-name"
              maxLength={128}
              value={shownCompany}
              onChange={(e) => {
                onCompanyName(e.target.value)
              }}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="person-name">{t('onboarding.person.name')}</Label>
            <Input
              id="person-name"
              data-testid="person-name"
              maxLength={64}
              value={person.name}
              onChange={(e) => {
                onRename(e.target.value)
              }}
            />
          </div>
          {/* 登录邮箱是身份，只读（09-18 Luoye 真机那一条） */}
          <div className="flex flex-col gap-1">
            <Label htmlFor="person-email">{t('onboarding.person.email')}</Label>
            <Input id="person-email" data-testid="person-email" readOnly value={person.email} />
          </div>
        </div>
      )}

      {failure === undefined ? null : (
        <p role="alert" className="text-destructive" data-testid="intake-error">
          {failure}
        </p>
      )}
    </div>
  )
}
