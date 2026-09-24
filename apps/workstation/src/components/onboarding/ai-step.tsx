/**
 * 向导第 ① 步：**接上 AI**（70 §2，WP121b）。
 *
 * 为什么它排第一：这个产品的每一个岗位都靠模型干活，接不上 AI 的向导走完
 * 也是个空壳。所以**没接上就不往下走**——但留一条「先逛逛演示数据」的旁路，
 * 因为"还没决定用哪家"与"不想用这个产品"是两件事。
 *
 * 两张大卡，二选一：
 *
 * - **用 Agents 工坊的接口**（推荐，送 10 积分）：输邮箱 → 发登录信 →
 *   用户去邮箱点链接（真正的下一步发生在他的邮箱里，不在这一页）→ 这边轮询
 *   关联状态 → 关联上了就自动启用云模型、把各能力开关切到「用 Agents 工坊的」→
 *   显示到账的积分。
 * - **用我自己的模型接口**：沿用现有 `ModelForm`（原生表单、key 不进 state、
 *   不经 AI），存完**当场验证三步**（`POST /v1/models/providers/:id/test`：连通 →
 *   文字 → 带图，WP127）。三步都过才算接上；**看不了图的不放行**（Agents 工坊
 *   只支持多模态模型）；不通说人话（70 §2.2 那几句）。
 *
 * - **用我的 DeepSeek 账号登录**（WP134，Luoye 09-24 定的第三种来源）：点了在系统浏览器里走
 *   DeepSeek 官方授权（dsh 官方模块），回来显示账号与余额，接着同样跑三步验证。
 *   与设置页那张卡是**同一个件**（`DeepSeekAccountLogin`）。数据驻留：境内。
 *
 * 减字：每张卡各一行说明，选中哪张才展开哪张的正文——几张同时铺开的话，
 * 第一次打开这个产品的人要先读几段字才知道自己该点哪儿。
 */
import { modelFailureKind, VISION_MODEL_EXAMPLES } from '@agentsws/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Cloud, KeyRound, Loader2, LogIn } from 'lucide-react'
import { useEffect, useState } from 'react'
import { DeepSeekAccountLogin } from '@/components/models/deepseek-account-login'
import { ModelCheckSteps } from '@/components/models/model-check-steps'
import { ModelForm, type ModelFormValues } from '@/components/models/model-form'
import { CLOUD_PROVIDER_ID } from '@/components/settings/model-cloud-card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  ApiClientError,
  discoverModelProviderModels,
  getCapabilitySources,
  getCloudAccount,
  getCloudCredits,
  isAccountTemplate,
  linkCloudAccount,
  listModelProviders,
  type ModelProviderKind,
  type ModelTestResult,
  saveModelProvider,
  setCapabilitySources,
  testModelProvider,
} from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { cn } from '@/lib/utils'

/** 这一步是靠哪条路接上的。 */
export type AiChoice = 'official' | 'own' | 'account'

/**
 * 试跑失败那一句（70 §2.2）。
 *
 * **分档在契约里**（`modelFailureKind`），因为不止这一处要它——模拟场景断言
 * "说的是人话不是错误码"用的是同一张表。这里只做最后一步：档 → 词条。
 */
export function modelTestKey(result: ModelTestResult): string {
  return `onboarding.ai.own.err.${modelFailureKind(result)}`
}

/**
 * WP127：那一句要填的变量。只有"看不了图"那一档要——列几个常见能看图的公开型号名
 * （契约里那一份，不是推荐），让人知道往哪个方向换。
 */
export function modelTestVars(): Record<string, string> {
  return { models: VISION_MODEL_EXAMPLES.join('、') }
}

/**
 * 一张模板卡的稳定标识。
 *
 * 模板没有 id：同一个 `kind` 可能有好几张卡（「OpenAI 兼容」与「阿里云百炼」
 * 都是 `openai_compatible`），所以按**接口地址**认——那正是它们真正不同的地方
 * （与 `models-panel.tsx` 里那个 `templateSlug` 同一条判据）。
 */
function slugOf(template: { kind: string; default_base_url: string }): string {
  return `${template.kind}:${template.default_base_url}`
}

/**
 * WP142（docs/78 第 3 步）：**同一家厂商的几个方案收成一个钮**。
 *
 * 百炼有三个方案（按量 / Token Plan / Coding Plan），以前摆成三个都叫「阿里云百炼」的钮，
 * 第一眼看不出差别。现在按 `vendor` 归成一组：第一排是厂商，选中之后有几个方案才出
 * 第二排（与设置页那张合并卡同一条思路，WP90）。没写 `vendor` 的模板自己一组。
 */
export interface VendorGroup<T extends { kind: string; default_base_url: string }> {
  key: string
  label: string
  plans: T[]
}

export function vendorGroups<
  T extends {
    kind: string
    default_base_url: string
    label: string
    vendor?: string
    vendor_label?: string
    plan_order?: number
  },
>(templates: readonly T[]): VendorGroup<T>[] {
  const out: VendorGroup<T>[] = []
  for (const tpl of templates) {
    const key = tpl.vendor ?? slugOf(tpl)
    const found = out.find((g) => g.key === key)
    if (found === undefined) out.push({ key, label: tpl.vendor_label ?? tpl.label, plans: [tpl] })
    else found.plans.push(tpl)
  }
  for (const g of out) g.plans.sort((a, b) => (a.plan_order ?? 0) - (b.plan_order ?? 0))
  return out
}

export interface AiStepProps {
  assignment?: string
  /** 接上了：向导据此亮「下一步」。 */
  onConnected: (how: AiChoice) => void
  /** 「先逛逛演示数据」：不接模型直接往下走（向导完成后顶栏那条黄条才出现）。 */
  onDemo: () => void
}

export function AiStep({ assignment, onConnected, onDemo }: AiStepProps): React.ReactNode {
  const { t } = useApp()
  const client = useQueryClient()
  const [choice, setChoice] = useState<AiChoice | undefined>(undefined)
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const [test, setTest] = useState<ModelTestResult | undefined>(undefined)
  const [picked, setPicked] = useState<string | undefined>(undefined)

  const providers = useQuery({
    queryKey: ['model-providers', assignment],
    queryFn: () => listModelProviders(assignment),
  })

  const account = useQuery({
    queryKey: ['cloud-account', assignment],
    queryFn: () => getCloudAccount(assignment),
    retry: false,
    // 登录信点没点，这边只能问。点开之前每隔几秒问一次，点开了就停
    refetchInterval: sent ? 3000 : false,
  })

  const linked = account.data?.linked === true

  const credits = useQuery({
    queryKey: ['cloud-credits', assignment],
    queryFn: () => getCloudCredits(assignment),
    enabled: linked,
    retry: false,
  })

  /**
   * WP142（docs/78 #6）：发登录信那一跳**连不上云时单独说**——等的时候有一句
   * 「正在连 Agents 工坊云…」，失败了给「再试一次」与「先逛逛演示数据」两个按钮，
   * 不只报一个网址。朋友里没有自己模型 key 的人全靠这一跳。
   */
  const [sendError, setSendError] = useState<string | undefined>(undefined)
  const send = useMutation({
    mutationFn: (value: string) => linkCloudAccount(value, assignment),
    onSuccess: () => {
      setFailure(undefined)
      setSendError(undefined)
      setSent(true)
    },
    onError: (err: unknown) => {
      setSendError(
        err instanceof ApiClientError && err.code !== 'provider_unavailable'
          ? err.message
          : t('onboarding.ai.official.offline'),
      )
    },
  })

  /**
   * 关联上之后那一串动作：启用云模型 + 把各能力开关切到「用 Agents 工坊的」。
   *
   * 用户按的是「发登录信」，不是"启用云模型"——他选的是**这条路**，
   * 中间这几下该我们替他做完。
   */
  const enable = useMutation({
    mutationFn: async () => {
      const template = providers.data?.templates.find((tpl) => tpl.kind === 'agentsws_cloud')
      await saveModelProvider(
        CLOUD_PROVIDER_ID,
        { kind: 'agentsws_cloud', model: template?.default_model ?? 'deepseek-flash' },
        assignment,
      )
      const current = await getCapabilitySources(assignment)
      const next = Object.fromEntries(
        Object.keys(current.capability_sources).map((key) => [key, 'agentsws' as const]),
      )
      if (Object.keys(next).length > 0) await setCapabilitySources(next, assignment)
      /*
       * WP126（派工单定论 2）：第一步选了官方 AI 接口的用户，数据接口默认也走官方
       * ——五条红人渠道的顺序把「工坊官方数据接口」提到最前。选了自有模型的
       * 不用动：默认顺序本来就是「我的 key → 我的数据接口 → 工坊的」，
       * 缺什么回退什么。
       */
      const kolChannels = ['youtube', 'instagram', 'tiktok', 'facebook', 'x'] as const
      await setCapabilitySources(
        { ...current.capability_sources, ...next },
        assignment,
        Object.fromEntries(
          kolChannels.map((channel) => [
            `kol.${channel}`,
            {
              order: ['workshop', 'official_key', 'byo_source'] as const,
              disabled: [] as const,
            },
          ]),
        ),
      )
    },
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['model-providers'] })
      await client.invalidateQueries({ queryKey: ['cloud-credits'] })
      onConnected('official')
    },
    onError: (err: unknown) => {
      setFailure(err instanceof ApiClientError ? err.message : t('error.generic'))
    },
  })

  const cloudReady = providers.data?.providers.some((p) => p.kind === 'agentsws_cloud') === true

  // 关联上了就自己往下走一步（只走一次：`cloudReady` 变 true 之后这个条件就不成立了）
  useEffect(() => {
    if (!linked || cloudReady || enable.isPending || enable.isError) return
    enable.mutate()
  }, [linked, cloudReady, enable])

  useEffect(() => {
    if (linked && cloudReady) onConnected('official')
  }, [linked, cloudReady, onConnected])

  /** 自有模型：存一把 → 当场试跑一次。通了才算接上。 */
  const saveAndTest = useMutation({
    mutationFn: async (values: ModelFormValues & { kind: ModelProviderKind }) => {
      const { id, kind, ...rest } = values
      await saveModelProvider(id, { kind, ...rest }, assignment)
      return testModelProvider(id, assignment)
    },
    onSuccess: async (result) => {
      setTest(result)
      setFailure(undefined)
      await client.invalidateQueries({ queryKey: ['model-providers'] })
      if (result.ok) onConnected('own')
    },
    onError: (err: unknown) => {
      setFailure(err instanceof ApiClientError ? err.message : t('error.generic'))
    },
  })

  /**
   * 能在这一步填完的模板：**云那张不算**（它是另一张大卡），
   * 订阅登录那几张也不算（它们没有表单，走的是另一条登录流程，不该在向导里半途插一脚）。
   */
  const templates = (providers.data?.templates ?? []).filter(
    (tpl) =>
      tpl.kind !== 'agentsws_cloud' &&
      (tpl.auth ?? 'api_key') === 'api_key' &&
      // WP134：账号登录那张是第三张大卡，不在"自己的接口"里重复出现
      !isAccountTemplate(tpl),
  )
  const template = templates.find((tpl) => slugOf(tpl) === picked) ?? templates[0]
  const groups = vendorGroups(templates)
  const group = groups.find((g) =>
    g.plans.some((p) => template !== undefined && slugOf(p) === slugOf(template)),
  )
  const granted = credits.data?.balance?.granted

  return (
    <div className="flex flex-col gap-3" data-testid="onboarding-ai">
      {/* ── 大卡一：用 Agents 工坊的接口 ───────────────────────────── */}
      <section
        data-testid="ai-card-official"
        data-open={choice === 'official'}
        className={cn(
          'rounded-lg border p-3 text-sm',
          choice === 'official' ? 'border-primary' : 'border-border',
        )}
      >
        <button
          type="button"
          data-testid="ai-pick-official"
          className="flex w-full items-center gap-2 text-left"
          onClick={() => {
            setChoice('official')
          }}
        >
          <Cloud aria-hidden className="size-4 shrink-0" />
          <span className="font-medium">{t('onboarding.ai.official')}</span>
          <span className="rounded-sm bg-ws-subtle px-1.5 py-0.5 text-[11px]">
            {t('onboarding.ai.official.bonus')}
          </span>
        </button>

        {choice === 'official' ? (
          linked ? (
            <div className="mt-2 flex flex-col gap-1" data-testid="ai-official-linked">
              <p className="flex items-center gap-1.5">
                <Check aria-hidden className="size-4 text-primary" />
                {account.data?.email}
              </p>
              {granted === undefined ? null : (
                <p className="text-ws-muted-fg" data-testid="ai-official-credits">
                  {t('onboarding.ai.official.credits', { credits: granted })}
                </p>
              )}
            </div>
          ) : (
            <div className="mt-2 flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <Input
                  type="email"
                  data-testid="ai-official-email"
                  aria-label={t('onboarding.ai.official.email')}
                  placeholder={t('cloud.account.email.placeholder')}
                  value={email}
                  onChange={(e) => {
                    setEmail(e.target.value)
                    setSent(false)
                  }}
                />
                <Button
                  size="sm"
                  disabled={send.isPending || email.trim() === ''}
                  data-testid="ai-official-send"
                  onClick={() => {
                    setSendError(undefined)
                    send.mutate(email.trim())
                  }}
                >
                  {send.isPending ? <Loader2 aria-hidden className="animate-spin" /> : null}
                  {t('onboarding.ai.official.send')}
                </Button>
              </div>
              {send.isPending ? (
                <p
                  className="flex items-center gap-1.5 text-ws-muted-fg"
                  data-testid="ai-official-pending"
                >
                  <Loader2 aria-hidden className="size-3.5 animate-spin" />
                  {t('onboarding.ai.official.pending')}
                </p>
              ) : null}
              {sendError === undefined || send.isPending ? null : (
                <div className="flex flex-col gap-2" data-testid="ai-official-failed">
                  <p role="alert" className="text-destructive" data-testid="ai-error">
                    {sendError}
                  </p>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      data-testid="ai-official-retry"
                      disabled={email.trim() === ''}
                      onClick={() => {
                        setSendError(undefined)
                        send.mutate(email.trim())
                      }}
                    >
                      {t('onboarding.ai.official.retry')}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      data-testid="ai-official-demo"
                      onClick={onDemo}
                    >
                      {t('onboarding.ai.demo')}
                    </Button>
                  </div>
                </div>
              )}
              {sent ? (
                <p
                  className="flex items-center gap-1.5 text-ws-muted-fg"
                  data-testid="ai-official-sent"
                >
                  <Loader2 aria-hidden className="size-3.5 animate-spin" />
                  {t('onboarding.ai.official.sent')}
                </p>
              ) : null}
            </div>
          )
        ) : null}
      </section>

      {/* ── 大卡二：用我自己的模型接口 ─────────────────────────────── */}
      <section
        data-testid="ai-card-own"
        data-open={choice === 'own'}
        className={cn(
          'rounded-lg border p-3 text-sm',
          choice === 'own' ? 'border-primary' : 'border-border',
        )}
      >
        <button
          type="button"
          data-testid="ai-pick-own"
          className="flex w-full items-center gap-2 text-left"
          onClick={() => {
            setChoice('own')
          }}
        >
          <KeyRound aria-hidden className="size-4 shrink-0" />
          <span className="font-medium">{t('onboarding.ai.own')}</span>
        </button>

        {choice === 'own' && template !== undefined ? (
          <div className="mt-2 flex flex-col gap-2">
            {groups.length < 2 ? null : (
              <div className="flex flex-wrap gap-1.5" data-testid="ai-own-templates">
                {groups.map((g) => {
                  const first = g.plans[0] as (typeof templates)[number]
                  const on = g.key === group?.key
                  return (
                    <button
                      key={g.key}
                      type="button"
                      data-testid={`ai-own-template-${slugOf(first)}`}
                      data-picked={on}
                      className={cn(
                        'rounded-sm border px-2 py-0.5 text-xs',
                        on ? 'border-primary text-foreground' : 'text-ws-muted-fg',
                      )}
                      onClick={() => {
                        if (on) return
                        setPicked(slugOf(first))
                        setTest(undefined)
                      }}
                    >
                      {g.label}
                    </button>
                  )
                })}
              </div>
            )}
            {/* 同一家有几个方案才出这一排（百炼：按量 / Token Plan / Coding Plan） */}
            {group === undefined || group.plans.length < 2 ? null : (
              <div className="flex flex-wrap gap-1.5" data-testid="ai-own-plans">
                {group.plans.map((tpl) => (
                  <button
                    key={slugOf(tpl)}
                    type="button"
                    data-testid={`ai-own-plan-${slugOf(tpl)}`}
                    data-picked={slugOf(tpl) === slugOf(template)}
                    className={cn(
                      'rounded-full border px-2 py-0.5 text-[11px]',
                      slugOf(tpl) === slugOf(template)
                        ? 'border-primary text-foreground'
                        : 'text-ws-muted-fg',
                    )}
                    onClick={() => {
                      setPicked(slugOf(tpl))
                      setTest(undefined)
                    }}
                  >
                    {tpl.plan_label ?? tpl.label}
                  </button>
                ))}
              </div>
            )}
            <ModelForm
              template={template}
              busy={saveAndTest.isPending}
              onCancel={() => {
                setChoice(undefined)
              }}
              onSubmit={(values) => {
                setTest(undefined)
                saveAndTest.mutate({ ...values, kind: template.kind })
              }}
              onDiscover={(probe) => {
                const { id, ...rest } = probe
                return discoverModelProviderModels(id, rest, assignment)
              }}
              takenIds={(providers.data?.providers ?? []).map((p) => p.id)}
            />
            {saveAndTest.isPending ? (
              <p
                className="flex items-center gap-1.5 text-ws-muted-fg"
                data-testid="ai-own-testing"
              >
                <Loader2 aria-hidden className="size-3.5 animate-spin" />
                {t('onboarding.ai.own.testing')}
              </p>
            ) : null}
            {/* WP127：三步小清单（与设置页那一行同一个件） */}
            {test === undefined ? null : <ModelCheckSteps steps={test.steps} />}
            {test === undefined ? null : test.ok ? (
              <p className="flex items-center gap-1.5 text-primary" data-testid="ai-own-ok">
                <Check aria-hidden className="size-4" />
                {t('onboarding.ai.own.ok')}
              </p>
            ) : (
              <p
                role="alert"
                className="text-destructive"
                data-testid="ai-own-failed"
                data-kind={modelFailureKind(test)}
              >
                {t(modelTestKey(test), modelTestVars())}
              </p>
            )}
          </div>
        ) : null}
      </section>

      {/* ── 大卡三：用我的 DeepSeek 账号登录（WP134）─────────────────── */}
      <section
        data-testid="ai-card-account"
        data-open={choice === 'account'}
        className={cn(
          'rounded-lg border p-3 text-sm',
          choice === 'account' ? 'border-primary' : 'border-border',
        )}
      >
        <button
          type="button"
          data-testid="ai-pick-account"
          className="flex w-full items-center gap-2 text-left"
          onClick={() => {
            setChoice('account')
          }}
        >
          <LogIn aria-hidden className="size-4 shrink-0" />
          <span className="font-medium">{t('onboarding.ai.account')}</span>
          <span className="rounded-sm bg-ws-subtle px-1.5 py-0.5 text-[11px]">
            {t('dsa.region')}
          </span>
        </button>
        {choice === 'account' ? (
          <div className="mt-2 flex flex-col gap-2">
            <p className="text-xs text-ws-muted-fg">{t('dsa.summary')}</p>
            <DeepSeekAccountLogin
              {...(assignment === undefined ? {} : { assignment })}
              onConnected={() => {
                onConnected('account')
              }}
            />
          </div>
        ) : null}
      </section>

      {failure === undefined ? null : (
        <p role="alert" className="text-sm text-destructive" data-testid="ai-error">
          {failure}
        </p>
      )}

      {/* 旁路：压成一行小字。它是退路，不是第三个选项 */}
      <button
        type="button"
        data-testid="ai-demo"
        className="self-start text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        onClick={onDemo}
      >
        {t('onboarding.ai.demo')}
      </button>
    </div>
  )
}
