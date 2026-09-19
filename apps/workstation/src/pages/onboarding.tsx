/**
 * 首次设置向导（70 §1 的新四步，WP121b）。
 *
 * **① 接上 AI → ② 你的生意 → ③ 选岗位 → ④ 连接与开工。**
 *
 * 原来的四步（公司 / 个人 / 岗位 / 初始配置）问的第一件事是"你们公司叫什么"，
 * 新的第一件事是"用哪个 AI"——这个产品的每一个岗位都靠模型干活，接不上 AI 的
 * 向导走完也是个空壳。原来的「公司设置 / 个人设置」并进 ②：贴一个网址之后，
 * 那两步问的东西八成已经替用户填好了，只剩顺带确认。
 *
 * 五条纪律（前四条是 WP51 / WP79 留下来的，一条没改）：
 *
 * 1. **随时能走**。右上角"先跳过"一直在；跳过不留痕、不落任何东西。
 * 2. **一屏一件事**（36 §3）。四步在同一张卡里换内容，不弹窗、不换页。
 * 3. **一个内部 id 都不出**。
 * 4. **勾岗位 = 该岗位职责全勾**，与服务端 `expandRoles` 同一套算法（`expandPick`）。
 * 5. **第 ① 步不能跳过**（70 §2）：没接上 AI 就不往下走——但「先逛逛演示数据」
 *    那条旁路算接上了这一步（它是"我还没决定"，不是"我不用这个产品"）。
 *    走了旁路的人向导完成后才看得见顶栏那条「还没接模型」（70 §2.2 末段）。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { BrandMark } from '@/components/design'
import { AiStep } from '@/components/onboarding/ai-step'
import { BusinessStep } from '@/components/onboarding/business-step'
import { JoinPanel } from '@/components/onboarding/join-panel'
import { PlanList } from '@/components/onboarding/plan-list'
import { presetPick } from '@/components/onboarding/preset-roles'
import { expandPick, type RolePick, RolePicker } from '@/components/onboarding/role-picker'
import { StepProgress } from '@/components/onboarding/step-progress'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import {
  ApiClientError,
  applyOnboarding,
  type BrandIntakeRun,
  getOnboardingState,
  listDiscoveryPeers,
  listOnboardingPositions,
  type OnboardingPlanInput,
  planOnboarding,
  renameMe,
  requestMembership,
  setWorkspaceProfile,
} from '@/lib/api'
import { useApp } from '@/lib/app-context'

/**
 * "先跳过"只活在**这一个标签页的内存里**（46 §1：随时可退出）。
 *
 * 两条理由：
 *
 * - 不落服务端：跳过不是一个决定，只是"现在不想弄"。公司档案没填，下次开工具
 *   照样该弹——`needs_setup` 只看档案设没设过。
 * - 不落浏览器的本机存储：40 §1.2 那条边界（个人电脑上不存真源）在工作台里是拿
 *   一张白名单钉死的（`test/local-cache.test.ts`），只有偏好、会话凭据与未发送
 *   草稿能落盘。"这一次先不弄"三样都不是，所以它就是一个模块变量。
 */
let skipped = false

export function onboardingSkipped(): boolean {
  return skipped
}

function markSkipped(): void {
  skipped = true
}

/**
 * 进度条仍然是四格，内容换掉（70 §1）。
 *
 * **向导期间顶栏那条「还没接模型」不出现**：第 ① 步问的就是这件事，
 * 再顶一条黄条等于同一句话说两遍（`app-shell.tsx` 按路由判）。
 */
const STEPS = [
  'onboarding.step1',
  'onboarding.step2',
  'onboarding.step3',
  'onboarding.step4',
] as const

/**
 * 第五屏：**完成**。
 *
 * WP112 给它加了母品牌那段「一变一队」——领头那块先出现，其余五块从它的位置分出去。
 * 它不是第五个"步骤"（进度条仍然四步，到这一屏四步全打勾），所以不进 `STEPS`。
 */
const DONE_STEP = STEPS.length

/**
 * 完成屏的标记：先播一次「一变一队」，播完接「呼吸」一直动着（Luoye 09-18）。
 * 1.5s = 领头 0.5s + 五块最后一块延迟 0.7s + 0.55s 落位，留一点余量。
 */
function DoneMark() {
  const [settled, setSettled] = useState(false)
  useEffect(() => {
    const timer = setTimeout(() => {
      setSettled(true)
    }, 1900)
    return () => {
      clearTimeout(timer)
    }
  }, [])
  return (
    <span data-testid="onboarding-done-mark" data-phase={settled ? 'breathe' : 'split'}>
      <BrandMark size={96} motion={settled ? 'breathe' : 'split'} />
    </span>
  )
}

/** 第 ① 步是怎么过去的：接上了官方接口 / 自己的模型 / 走了演示旁路。 */
type AiState = 'official' | 'own' | 'demo' | undefined

export function OnboardingPage(): React.ReactNode {
  const { t } = useApp()
  const client = useQueryClient()
  const navigate = useNavigate()
  const [step, setStep] = useState(0)
  const [ai, setAi] = useState<AiState>(undefined)
  const [pick, setPick] = useState<RolePick>({
    position_ids: [],
    role_ids: [],
    custom_position_name: '',
  })
  /** 用户在第 ③ 步动过手没有。动过就不再让预勾覆盖他的勾选。 */
  const [touched, setTouched] = useState(false)
  const [intake, setIntake] = useState<BrandIntakeRun | undefined>(undefined)
  const [settled, setSettled] = useState(false)
  const [sent, setSent] = useState(false)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const [nameDraft, setNameDraft] = useState<string | undefined>(undefined)
  const [companyDraft, setCompanyDraft] = useState<string | undefined>(undefined)

  const state = useQuery({ queryKey: ['onboarding', 'state'], queryFn: () => getOnboardingState() })
  const positions = useQuery({
    queryKey: ['onboarding', 'positions'],
    queryFn: () => listOnboardingPositions(),
  })
  const peers = useQuery({
    queryKey: ['onboarding', 'peers'],
    queryFn: () => listDiscoveryPeers(),
    // 同伴是会来会走的：停在第 ② 步（现在「加入一家公司」挂在这里）时隔一会儿再看一眼
    refetchInterval: step === 1 ? 5000 : false,
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

  /**
   * 第 ② 步结束（确认了档案，或走了「还没有网站」旁路）：
   * 按结果预勾第 ③ 步（70 §5）。**用户自己动过手就不再覆盖**。
   */
  useEffect(() => {
    if (!settled || touched || positions.data === undefined) return
    setPick(
      presetPick({ ...(intake === undefined ? {} : { run: intake }), positions: positions.data }),
    )
  }, [settled, touched, intake, positions.data])

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

  /**
   * 第 ② 步往下走时把那两格存了：公司名进工作区档案、称呼进本人。
   *
   * 没改过的一个都不发——向导里"没动过"与"改成一样的值"是两件事，
   * 后者会在事件日志里留一条什么都没变的更名记录。
   */
  const saveSecond = useMutation({
    mutationFn: async () => {
      const wantedName = (nameDraft ?? state.data?.person.name ?? '').trim()
      if (wantedName !== '' && wantedName !== state.data?.person.name) await renameMe(wantedName)
      const wantedCompany = (companyDraft ?? '').trim()
      if (wantedCompany !== '' && wantedCompany !== state.data?.profile?.legal_name)
        await setWorkspaceProfile({ legal_name: wantedCompany })
    },
    onSuccess: async () => {
      setFailure(undefined)
      await client.invalidateQueries({ queryKey: ['onboarding'] })
      await client.invalidateQueries({ queryKey: ['me'] })
      setStep(2)
    },
    onError: say,
  })

  const apply = useMutation({
    mutationFn: () => applyOnboarding(planInput()),
    onSuccess: async () => {
      setFailure(undefined)
      await client.invalidateQueries({ queryKey: ['onboarding'] })
      await client.invalidateQueries({ queryKey: ['positions'] })
      // WP112：不再直接跳首页——先给一屏回执（"一队上岗了"），人自己按按钮进去
      setStep(DONE_STEP)
    },
    onError: say,
  })

  if (state.data === undefined) return <Skeleton className="h-64 w-full" />

  const companyName =
    companyDraft ?? state.data.profile?.legal_name ?? state.data.workspace_name ?? ''

  /** 这一步往下走得了吗。①：接上 AI 才行；③：至少勾一条职责。 */
  const canNext = step === 0 ? ai !== undefined : step === 2 ? expanded.length > 0 : true

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        {/*
          WP112：**第一屏**的页头带一段「集结」——六块依次落位。
          它说的是"这套东西正在起来"，所以只在第 ① 步出、只播一次、播完停住。
        */}
        <h1 className="flex items-center gap-2 text-sm font-semibold">
          {step === 0 ? <BrandMark size={28} motion="assemble" /> : null}
          {t('onboarding.title')}
        </h1>
        {step === DONE_STEP ? null : (
          <button
            type="button"
            data-testid="onboarding-skip"
            className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            onClick={() => {
              markSkipped()
              navigate('/')
            }}
          >
            {t('onboarding.skip')}
          </button>
        )}
      </div>

      <StepProgress steps={STEPS} step={step} />

      <Card>
        <CardContent className="flex flex-col gap-4 pt-6">
          {step === 0 ? (
            <AiStep
              onConnected={(how) => {
                setAi(how)
              }}
              onDemo={() => {
                setAi('demo')
                setStep(1)
              }}
            />
          ) : null}

          {step === 1 ? (
            <div className="flex flex-col gap-4">
              <BusinessStep
                official={ai === 'official'}
                person={{
                  name: nameDraft ?? state.data.person.name,
                  email: state.data.person.email,
                }}
                companyName={companyName}
                onRename={setNameDraft}
                onCompanyName={setCompanyDraft}
                onSettled={(run) => {
                  setIntake(run)
                  setSettled(true)
                }}
              />
              {/* 46 §2 I2 I3：已经有同事在用的话，这一步就是"加入他们"而不是"再开一家" */}
              <JoinPanel
                {...(peers.data === undefined ? {} : { discovery: peers.data })}
                configured={state.data.profile !== undefined}
                collapsed
                busy={join.isPending}
                sent={sent}
                onJoin={(input) => {
                  join.mutate(input)
                }}
              />
            </div>
          ) : null}

          {step === 2 ? (
            positions.data === undefined ? (
              <Skeleton className="h-40 w-full" />
            ) : (
              <RolePicker
                positions={positions.data}
                value={pick}
                onChange={(next) => {
                  setTouched(true)
                  setPick(next)
                }}
              />
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

          {step === DONE_STEP ? (
            <div
              className="flex flex-col items-center gap-3 py-6 text-center"
              data-testid="onboarding-done"
            >
              <DoneMark />
              <p className="ws-display text-[17px]">{t('onboarding.done.title')}</p>
              <p className="max-w-sm text-sm text-ws-muted-fg">
                {t('onboarding.done.line', { count: expanded.length })}
              </p>
              <Button
                size="sm"
                data-testid="onboarding-enter"
                onClick={() => {
                  navigate('/')
                }}
              >
                {t('onboarding.done.enter')}
              </Button>
            </div>
          ) : null}

          {failure === undefined ? null : (
            <p role="alert" className="text-sm text-destructive" data-testid="onboarding-error">
              {failure}
            </p>
          )}

          {/*
            往前走的那一条。**完成屏不出**；第 ① 步没有「上一步」（它是第一步），
            但「下一步」要在——接上 AI 之前它是灰的，那正是"不能跳过"这件事的样子。
          */}
          {step === DONE_STEP ? null : (
            <div className="flex items-center justify-end gap-2">
              {step === 0 ? null : (
                <Button
                  size="sm"
                  variant="ghost"
                  data-testid="onboarding-back"
                  onClick={() => {
                    setStep((s) => Math.max(0, s - 1))
                  }}
                >
                  {t('onboarding.back')}
                </Button>
              )}
              {step < 3 ? (
                <Button
                  size="sm"
                  disabled={!canNext || saveSecond.isPending}
                  data-testid="onboarding-next"
                  onClick={() => {
                    if (step === 1) {
                      saveSecond.mutate()
                      return
                    }
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
          )}
        </CardContent>
      </Card>
    </div>
  )
}
