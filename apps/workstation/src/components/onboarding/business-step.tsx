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
import { DEFAULT_BRAND_INTAKE_CAP_CREDITS, isPlaceholderOwnerEmail } from '@agentsws/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
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

/** WP240：跑了这么久还一页没读着，就把「先跳过」摆出来（不让人干等）。 */
export const SLOW_START_MS = 30_000

/** WP240：读不到时要不要出「店铺密码」那一格（Shopify 开着访问密码 / 密码没解开）。 */
export function asksStorePassword(run: BrandIntakeRun | undefined): boolean {
  return (
    run?.status === 'failed' &&
    (run.failure_kind === 'password' || run.failure_kind === 'password_wrong')
  )
}

/**
 * WP233：第 ② 步「你的账号」那一行显示哪个邮箱；`undefined` = 整格不显示。
 *
 * 有云账号 → 就是第 ① 步那一个（与本机负责人的邮箱已经对齐，见服务端 `alignOwnerEmail`）；
 * 没有云账号、本机身份还是占位 `owner@localhost` → 不显示（本机一个人用不需要它）；
 * 没有云账号但本机身份是一个真邮箱（自己配过的、公司档登录的）→ 显示它。
 */
export function shownAccountEmail(
  cloudEmail: string | undefined,
  personEmail: string,
): string | undefined {
  const cloud = cloudEmail?.trim()
  if (cloud !== undefined && cloud !== '') return cloud
  if (personEmail.trim() === '' || isPlaceholderOwnerEmail(personEmail)) return undefined
  return personEmail
}

export interface BusinessStepProps {
  assignment?: string
  /** 这台机器上现在用的是官方接口吗（决定要不要说那一句"内容会经过我们的云"）。 */
  official: boolean
  /** 分析确认了 / 走了「还没有网站」旁路：把结果交给向导（它据此预勾岗位）。 */
  onSettled: (run: BrandIntakeRun | undefined) => void
  /** 公司名与称呼那一小块：确认后存下去。 */
  person: { name: string; email: string }
  /** WP233：第 ① 步关联上的云账号邮箱（没关联就不给）。见 {@link shownAccountEmail}。 */
  cloudEmail?: string
  /**
   * WP240：公司加的品牌——公司全称与你的称呼是公司那一层的，已经有了，这一步不再问。
   */
  addedBrand?: boolean
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
  cloudEmail,
  addedBrand = false,
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
  /**
   * WP240：店铺访问密码。**只活在这一格里**：发出去那一下就清空，不进 query 缓存、
   * 不进本机存储、不进 URL，也不经 AI（它只随这一次请求交给本机服务）。
   */
  const [storePassword, setStorePassword] = useState('')
  /** WP240：跑了 30 秒还一页没读着。 */
  const [slow, setSlow] = useState(false)

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
    mutationFn: (password?: string) =>
      reanalyzeBrandIntake(
        currentId ?? '',
        urls().length === 0 ? undefined : urls(),
        assignment,
        password,
      ),
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
  const running = isRunning(current)
  const readPages = current?.pages.length ?? 0
  // WP240：跑着、一页没读着——30 秒后把「先跳过」摆出来；读着了 / 停了就收起
  useEffect(() => {
    setSlow(false)
    if (!running || readPages > 0) return
    const timer = setTimeout(() => {
      setSlow(true)
    }, SLOW_START_MS)
    return () => {
      clearTimeout(timer)
    }
  }, [running, readPages])
  const skip = (): void => {
    setSkipped(true)
    onSettled(undefined)
  }
  const analyzedLegal = current?.profile.legal_name?.value
  const shownCompany =
    !companyEdited && typeof analyzedLegal === 'string' && analyzedLegal.trim() !== ''
      ? analyzedLegal
      : companyName
  const failedPages = (current?.pages ?? []).filter((p) => !p.ok)
  const account = shownAccountEmail(cloudEmail, person.email)

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
            <p
              role="alert"
              className="text-destructive"
              data-testid="intake-failed"
              data-kind={current.failure_kind ?? ''}
            >
              {current.failure ?? t('error.generic')}
            </p>
          ) : null}
          {/*
            WP240：Shopify 店开着访问密码——在这里填一次（原生表单，type=password）。
            只随这一次「再读一次」交给本机服务、只用于这一次抓取，不保存、不进日志、不经 AI。
          */}
          {asksStorePassword(current) ? (
            <form
              className="flex flex-col gap-1"
              data-testid="intake-password-form"
              onSubmit={(e) => {
                e.preventDefault()
                const password = storePassword
                setStorePassword('')
                if (password !== '') again.mutate(password)
              }}
            >
              <Label htmlFor="intake-store-password">
                {t('onboarding.business.password.label')}
              </Label>
              <div className="flex items-center gap-2">
                <Input
                  id="intake-store-password"
                  data-testid="intake-store-password"
                  type="password"
                  autoComplete="off"
                  value={storePassword}
                  onChange={(e) => {
                    setStorePassword(e.target.value)
                  }}
                />
                <Button
                  type="submit"
                  size="sm"
                  disabled={busy || storePassword === ''}
                  data-testid="intake-password-submit"
                >
                  {t('onboarding.business.password.submit')}
                </Button>
              </div>
              <p className="text-xs text-ws-muted-fg">{t('onboarding.business.password.note')}</p>
            </form>
          ) : null}
          {current?.status === 'failed' &&
          (current.failure_kind === 'blocked' || current.failure_kind === 'timeout') ? (
            <Button
              size="sm"
              variant="outline"
              className="self-start"
              disabled={busy}
              data-testid="intake-retry"
              onClick={() => {
                again.mutate(undefined)
              }}
            >
              {t('onboarding.business.retry')}
            </Button>
          ) : null}
          {current?.status === 'failed' ? (
            <Button
              size="sm"
              variant="ghost"
              className="self-start"
              data-testid="intake-skip"
              onClick={skip}
            >
              {t('onboarding.business.skip')}
            </Button>
          ) : null}
          <button
            type="button"
            data-testid="intake-no-site"
            className="self-start text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            onClick={skip}
          >
            {t('onboarding.business.no_site')}
          </button>
        </div>
      ) : null}

      {/* ── 在干活 ─────────────────────────────────────────────── */}
      {running && !skipped ? (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2 text-ws-muted-fg" data-testid="intake-working">
            <BrandMark size={20} motion="breathe" />
            {t('onboarding.business.working', { done: readPages })}
          </div>
          {/* WP240：30 秒还一页没读着——别让人干等，给一条「先跳过」 */}
          {slow ? (
            <div className="flex flex-wrap items-center gap-2" data-testid="intake-slow">
              <span className="text-xs text-ws-muted-fg">{t('onboarding.business.slow')}</span>
              <Button size="sm" variant="ghost" data-testid="intake-slow-skip" onClick={skip}>
                {t('onboarding.business.skip')}
              </Button>
            </div>
          ) : null}
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
              again.mutate(undefined)
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
      {/* WP240：加的品牌不出——公司全称与称呼是公司那一层的，已经有了 */}
      {addedBrand ? (
        skipped ? (
          <p className="text-xs text-ws-muted-fg" data-testid="intake-skipped-later">
            {t('onboarding.business.later')}
          </p>
        ) : null
      ) : current === undefined && !skipped ? null : (
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
          {/*
            WP233（Luoye 10-05 真机）：原来这里是一格只读的「登录邮箱：owner@localhost」——
            那是本机的内部占位，看着像第 ① 步填的没生效。现在只剩一行「你的账号」，
            就是第 ① 步那一个；没有云账号、本机还是占位时整行不出。
          */}
          {account === undefined ? null : (
            <p className="text-xs text-ws-muted-fg" data-testid="person-account">
              {t('onboarding.person.account', { email: account })}
            </p>
          )}
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
