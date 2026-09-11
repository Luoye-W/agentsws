/**
 * 首次设置向导（46 §1 的四步表）。
 *
 * 第一次打开工具只问三件事——**你们公司叫什么、你是谁、你做什么**——第四步不问，
 * 只把前三步的答案翻译成一张"要配的东西"清单。
 *
 * 四条：
 *
 * 1. **随时能走**。右上角"先跳过"一直在；跳过不留痕、不落任何东西，下次登录
 *    照样弹（`needs_setup` 只看公司档案设没设过）。
 * 2. **一屏一件事**（36 §3）。四步在同一张卡里换内容，不弹窗、不换页。
 * 3. **一个内部 id 都不出**。岗位与职责说的是名字，同伴报的是"王岚的工作区 · 3 人"，
 *    公司档案里没有那串哈希。
 * 4. **勾岗位 = 该岗位职责全勾**，与服务端 `expandRoles` 同一套算法（`expandPick`）。
 *    第 ④ 步那张清单是服务端按同一份勾选算的，两边不会两张皮。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { JoinPanel } from '@/components/onboarding/join-panel'
import { PlanList } from '@/components/onboarding/plan-list'
import { type ProfileDraft, ProfileForm } from '@/components/onboarding/profile-form'
import { expandPick, type RolePick, RolePicker } from '@/components/onboarding/role-picker'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Hint } from '@/components/ui/hint'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import {
  ApiClientError,
  applyOnboarding,
  getOnboardingState,
  listDiscoveryPeers,
  listOnboardingPositions,
  type OnboardingPlanInput,
  planOnboarding,
  requestMembership,
  setWorkspaceProfile,
} from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { cn } from '@/lib/utils'

/**
 * "先跳过"只活在**这一个标签页的内存里**（46 §1：随时可退出）。
 *
 * 两条理由：
 *
 * - 不落服务端：跳过不是一个决定，只是"现在不想弄"。公司档案没填，下次开工具
 *   照样该弹——`needs_setup` 只看档案设没设过。
 * - 不落浏览器的本机存储：40 §1.2 那条边界（个人电脑上不存真源）在工作台里是拿
 *   一张白名单钉死的（`test/local-cache.test.ts`），只有偏好、会话凭据与未发送
 *   草稿能落盘。"这一次先不弄"三样都不是，所以它就是一个模块变量：刷新页面就忘，
 *   代价是再看一眼向导，比在那张白名单上开一个口子便宜得多。
 */
let skipped = false

export function onboardingSkipped(): boolean {
  return skipped
}

function markSkipped(): void {
  skipped = true
}

const STEPS = [
  'onboarding.step1',
  'onboarding.step2',
  'onboarding.step3',
  'onboarding.step4',
] as const

export function OnboardingPage(): React.ReactNode {
  const { t } = useApp()
  const client = useQueryClient()
  const navigate = useNavigate()
  const [step, setStep] = useState(0)
  const [pick, setPick] = useState<RolePick>({
    position_ids: [],
    role_ids: [],
    custom_position_name: '',
  })
  const [saved, setSaved] = useState(false)
  const [sent, setSent] = useState(false)
  const [failure, setFailure] = useState<string | undefined>(undefined)

  const state = useQuery({ queryKey: ['onboarding', 'state'], queryFn: () => getOnboardingState() })
  const positions = useQuery({
    queryKey: ['onboarding', 'positions'],
    queryFn: () => listOnboardingPositions(),
  })
  const peers = useQuery({
    queryKey: ['onboarding', 'peers'],
    queryFn: () => listDiscoveryPeers(),
    // 同伴是会来会走的：停在第 ① 步的时候隔一会儿再看一眼
    refetchInterval: step === 0 ? 5000 : false,
  })

  const planInput = (): OnboardingPlanInput => ({
    position_ids: pick.position_ids,
    role_ids: pick.role_ids,
    ...(pick.custom_position_name.trim() === ''
      ? {}
      : { custom_position_name: pick.custom_position_name.trim() }),
  })

  const say = (err: unknown): void => {
    setFailure(err instanceof ApiClientError ? err.message : t('error.generic'))
  }

  const expanded = expandPick(pick, positions.data ?? [])

  // 第 ④ 步那张清单：服务端按同一份勾选算，所以它与界面上勾的永远对得上
  const plan = useQuery({
    queryKey: ['onboarding', 'plan', expanded.join(','), pick.position_ids.join(',')],
    enabled: step === 3 && expanded.length > 0,
    queryFn: () => planOnboarding(planInput()),
  })

  const saveProfile = useMutation({
    mutationFn: (draft: ProfileDraft) =>
      setWorkspaceProfile({
        legal_name: draft.legal_name.trim(),
        ...(draft.domain.trim() === '' ? {} : { domain: draft.domain.trim() }),
        discoverable: draft.discoverable,
      }),
    onSuccess: async () => {
      setFailure(undefined)
      setSaved(true)
      await client.invalidateQueries({ queryKey: ['onboarding'] })
    },
    onError: say,
  })

  const join = useMutation({
    mutationFn: (input: { code?: string; peer_id?: string }) =>
      requestMembership({
        ...input,
        name: state.data?.person.name ?? '',
        email: state.data?.person.email ?? '',
      }),
    onSuccess: () => {
      setFailure(undefined)
      setSent(true)
    },
    onError: say,
  })

  const apply = useMutation({
    mutationFn: () => applyOnboarding(planInput()),
    onSuccess: async () => {
      setFailure(undefined)
      await client.invalidateQueries({ queryKey: ['onboarding'] })
      await client.invalidateQueries({ queryKey: ['positions'] })
      navigate('/')
    },
    onError: say,
  })

  if (state.data === undefined) return <Skeleton className="h-64 w-full" />

  const canNext = step !== 2 || expanded.length > 0

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-sm font-semibold">{t('onboarding.title')}</h1>
          <p className="text-xs text-muted-foreground">{t('onboarding.subtitle')}</p>
        </div>
        <Button
          size="sm"
          variant="ghost"
          data-testid="onboarding-skip"
          onClick={() => {
            markSkipped()
            navigate('/')
          }}
        >
          {t('onboarding.skip')}
        </Button>
      </div>

      <ol className="flex flex-wrap gap-1 text-xs" data-testid="onboarding-steps">
        {STEPS.map((key, i) => (
          <li
            key={key}
            aria-current={i === step ? 'step' : undefined}
            className={cn(
              'rounded-md border px-2 py-1',
              i === step && 'border-primary bg-primary/10',
              i > step && 'text-muted-foreground',
            )}
          >
            {t(key)}
          </li>
        ))}
      </ol>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">{t(STEPS[step] ?? STEPS[0])}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {step === 0 ? (
            <div className="flex flex-col gap-4">
              <ProfileForm
                {...(state.data.profile === undefined ? {} : { profile: state.data.profile })}
                emailHint={state.data.person.email}
                busy={saveProfile.isPending}
                saved={saved}
                {...(failure === undefined ? {} : { error: failure })}
                onSave={(draft) => {
                  saveProfile.mutate(draft)
                }}
              />
              {/* 46 §2 I2 I3：已经有同事在用的话，这一步就是"加入他们"而不是"再开一家" */}
              <JoinPanel
                {...(peers.data === undefined ? {} : { discovery: peers.data })}
                me={state.data.person}
                busy={join.isPending}
                sent={sent}
                onJoin={(input) => {
                  join.mutate(input)
                }}
              />
            </div>
          ) : null}

          {step === 1 ? (
            <div className="flex flex-col gap-3 text-sm" data-testid="onboarding-person">
              <div className="flex flex-col gap-1">
                <Label htmlFor="person-name" className="flex items-center gap-1">
                  {t('onboarding.person.name')}
                  <Hint text={t('onboarding.person.hint')} />
                </Label>
                <Input
                  id="person-name"
                  data-testid="person-name"
                  readOnly
                  value={state.data.person.name}
                />
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="person-email">{t('onboarding.person.email')}</Label>
                <Input
                  id="person-email"
                  data-testid="person-email"
                  readOnly
                  value={state.data.person.email}
                />
              </div>
            </div>
          ) : null}

          {step === 2 ? (
            positions.data === undefined ? (
              <Skeleton className="h-40 w-full" />
            ) : (
              <RolePicker positions={positions.data} value={pick} onChange={setPick} />
            )
          ) : null}

          {step === 3 ? (
            plan.data === undefined ? (
              expanded.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t('onboarding.roles.none')}</p>
              ) : (
                <Skeleton className="h-40 w-full" />
              )
            ) : (
              <PlanList plan={plan.data} />
            )
          ) : null}

          {failure === undefined || step === 0 ? null : (
            <p role="alert" className="text-sm text-destructive" data-testid="onboarding-error">
              {failure}
            </p>
          )}

          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">
              {t('onboarding.step', { n: String(step + 1) })}
            </span>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="ghost"
                disabled={step === 0}
                data-testid="onboarding-back"
                onClick={() => {
                  setStep((s) => Math.max(0, s - 1))
                }}
              >
                {t('onboarding.back')}
              </Button>
              {step < 3 ? (
                <Button
                  size="sm"
                  disabled={!canNext}
                  data-testid="onboarding-next"
                  onClick={() => {
                    setStep((s) => Math.min(3, s + 1))
                  }}
                >
                  {t('onboarding.next')}
                </Button>
              ) : (
                <Button
                  size="sm"
                  disabled={apply.isPending || expanded.length === 0}
                  data-testid="onboarding-finish"
                  onClick={() => {
                    apply.mutate()
                  }}
                >
                  {t('onboarding.done')}
                </Button>
              )}
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
