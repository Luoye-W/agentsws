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
 *   不经 AI），存完**当场打一次最小请求**（`POST /v1/models/providers/:id/test`）。
 *   通了才算接上；不通说人话（70 §2.2 那四句）。
 *
 * 减字：两张卡各一行说明，选中哪张才展开哪张的正文——两张同时铺开的话，
 * 第一次打开这个产品的人要先读两段字才知道自己该点哪儿。
 */
import { modelFailureKind } from '@agentsws/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Cloud, KeyRound, Loader2 } from 'lucide-react'
import { useEffect, useState } from 'react'
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
export type AiChoice = 'official' | 'own'

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
 * 一张模板卡的稳定标识。
 *
 * 模板没有 id：同一个 `kind` 可能有好几张卡（「OpenAI 兼容」与「阿里云百炼」
 * 都是 `openai_compatible`），所以按**接口地址**认——那正是它们真正不同的地方
 * （与 `models-panel.tsx` 里那个 `templateSlug` 同一条判据）。
 */
function slugOf(template: { kind: string; default_base_url: string }): string {
  return `${template.kind}:${template.default_base_url}`
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

  const send = useMutation({
    mutationFn: (value: string) => linkCloudAccount(value, assignment),
    onSuccess: () => {
      setFailure(undefined)
      setSent(true)
    },
    onError: (err: unknown) => {
      setFailure(err instanceof ApiClientError ? err.message : t('error.generic'))
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
    (tpl) => tpl.kind !== 'agentsws_cloud' && (tpl.auth ?? 'api_key') === 'api_key',
  )
  const template = templates.find((tpl) => slugOf(tpl) === picked) ?? templates[0]
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
                    send.mutate(email.trim())
                  }}
                >
                  {t('onboarding.ai.official.send')}
                </Button>
              </div>
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
            {templates.length < 2 ? null : (
              <div className="flex flex-wrap gap-1.5" data-testid="ai-own-templates">
                {templates.map((tpl) => (
                  <button
                    key={slugOf(tpl)}
                    type="button"
                    data-testid={`ai-own-template-${slugOf(tpl)}`}
                    data-picked={slugOf(tpl) === slugOf(template)}
                    className={cn(
                      'rounded-sm border px-2 py-0.5 text-xs',
                      slugOf(tpl) === slugOf(template)
                        ? 'border-primary text-foreground'
                        : 'text-ws-muted-fg',
                    )}
                    onClick={() => {
                      setPicked(slugOf(tpl))
                      setTest(undefined)
                    }}
                  >
                    {tpl.vendor_label ?? tpl.label}
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
            {test === undefined ? null : test.ok ? (
              <p className="flex items-center gap-1.5 text-primary" data-testid="ai-own-ok">
                <Check aria-hidden className="size-4" />
                {t('onboarding.ai.own.ok')}
              </p>
            ) : (
              <p role="alert" className="text-destructive" data-testid="ai-own-failed">
                {t(modelTestKey(test))}
              </p>
            )}
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
