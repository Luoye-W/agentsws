/**
 * 首次设置向导（46 §1 的四步表：公司设置 / 个人设置 / 岗位设置 / 初始配置）。
 *
 * 第一次打开工具只问三件事——**你们公司叫什么、你是谁、你做什么**——第四步不问，
 * 只把前三步的答案翻译成一张"要配的东西"清单。
 *
 * WP79（09-17 Luoye 看真机截图）：这一页的规矩是**每个字段最多一行说明，
 * 能不写就不写**。导语整段去掉、步骤条换成进度条、灰色分组小标题不出、
 * 「加入一家公司」默认折叠成一行——第一次打开的人要的是开始填，不是先读一页字。
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
import { BrandMark } from '@/components/design'
import { JoinPanel } from '@/components/onboarding/join-panel'
import { PlanList } from '@/components/onboarding/plan-list'
import { type ProfileDraft, ProfileForm } from '@/components/onboarding/profile-form'
import { expandPick, type RolePick, RolePicker } from '@/components/onboarding/role-picker'
import { StepProgress } from '@/components/onboarding/step-progress'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
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

/**
 * 第五屏：**完成**。
 *
 * WP112 给它加了母品牌那段「一变一队」——领头那块先出现，其余五块从它的位置分出去。
 * 这段动效演的就是这一刻的意思：**一个活做通了，复制成一队**。它只播一次，
 * 播完停住；下面那个按钮才是出口。
 *
 * 它不是第五个"步骤"（进度条仍然是四步，到这一屏四步全打勾），所以不进 `STEPS`。
 */
const DONE_STEP = STEPS.length

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
  // 09-18 Luoye 真机：第 ② 步的名字原来是只读的，删不掉默认值、打的字也不出现。
  // 名字是本人的展示名，可以改；登录邮箱是身份，仍只读。
  const [nameDraft, setNameDraft] = useState<string | undefined>(undefined)

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
        // 48 v2 L2：你卖的是（客服 AI 按它取人设、词表与业务边界）
        vertical: draft.vertical,
        // WP62（51 §1 N0）：网站是用什么搭的（店铺连接、面板取数、职责连接器按它解析）
        storefront_platform: draft.storefront_platform,
        // WP65（52 O4）：第 ① 步下半块——品牌名进的是工作区，不是组织
        ...(draft.brand_name.trim() === '' ? {} : { brand_name: draft.brand_name.trim() }),
      }),
    onSuccess: async () => {
      setFailure(undefined)
      setSaved(true)
      await client.invalidateQueries({ queryKey: ['onboarding'] })
      // WP79 ⑥：存完就进下一步——按钮上写的是「保存并继续」，它就该真的继续
      setStep(1)
    },
    onError: say,
  })

  const rename = useMutation({
    mutationFn: (name: string) => renameMe(name),
    onSuccess: async () => {
      setFailure(undefined)
      await client.invalidateQueries({ queryKey: ['onboarding'] })
      await client.invalidateQueries({ queryKey: ['me'] })
      setStep(2)
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
      // WP112：不再直接跳首页——先给一屏回执（"一队上岗了"），人自己按按钮进去
      setStep(DONE_STEP)
    },
    onError: say,
  })

  if (state.data === undefined) return <Skeleton className="h-64 w-full" />

  const canNext = step !== 2 || expanded.length > 0

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4">
      {/*
        WP79 ①：顶上只留一个标题。原来那一段"先把这三件事说清楚 / 你们公司叫什么、
        你是谁……"整段去掉——第一次打开的人要的是开始填，不是先读一段导语。
        「先跳过」留在右上，但压成一行弱化的小字：它是退路，不是主动作。
      */}
      <div className="flex items-center justify-between gap-3">
        {/*
          WP112：**第一屏**的页头带一段「集结」——六块依次落位。
          它说的是"这套东西正在起来"，所以只在第 ① 步出、只播一次、播完停住；
          往后几步再播一遍就成了装饰。
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
            <div className="flex flex-col gap-4">
              <ProfileForm
                {...(state.data.profile === undefined ? {} : { profile: state.data.profile })}
                emailHint={state.data.person.email}
                verticals={state.data.verticals}
                storefrontPlatforms={state.data.storefront_platforms}
                // 52 O4：向导里下半块说的是"**第一个**品牌"（之后在公司页还能加）
                firstBrand
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
                configured={state.data.profile !== undefined}
                // WP79 ⑤：第 ① 步这一整块默认折叠成一行「已有邀请码？」
                collapsed
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
                  maxLength={64}
                  value={nameDraft ?? state.data.person.name}
                  onChange={(e) => {
                    setNameDraft(e.target.value)
                  }}
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

          {step === DONE_STEP ? (
            <div
              className="flex flex-col items-center gap-3 py-6 text-center"
              data-testid="onboarding-done"
            >
              <BrandMark size={72} motion="split" />
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

          {failure === undefined || step === 0 ? null : (
            <p role="alert" className="text-sm text-destructive" data-testid="onboarding-error">
              {failure}
            </p>
          )}

          {/*
            WP79 ①⑥：底下原来还有一行"第 N 步 / 共 4 步"——进度条已经把它画出来了，
            去掉。往前走的那个按钮四步统一说「保存并继续」，最后一步说「完成」。
            **第 ① 步整条不出**：那一步的「保存并继续」在表单里（存完自己进下一步），
            这里再放一个等于同一句话摆两遍；而「上一步」在第 ① 步本来就是灰的，
            单摆一个点不动的按钮比没有它更糟。
          */}
          {step === 0 || step === DONE_STEP ? null : (
            <div className="flex items-center justify-end gap-2">
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
              {step < 3 ? (
                <Button
                  size="sm"
                  disabled={!canNext || rename.isPending}
                  data-testid="onboarding-next"
                  onClick={() => {
                    // 第 ② 步：名字改过就先存（存完自己进下一步），没改就直接走
                    const current = state.data?.person.name ?? ''
                    const wanted = (nameDraft ?? current).trim()
                    if (step === 1 && wanted !== '' && wanted !== current) {
                      rename.mutate(wanted)
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
