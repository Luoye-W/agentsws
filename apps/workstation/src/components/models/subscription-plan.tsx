/**
 * 「用 ChatGPT / Claude 订阅登录」那个方案的卡内内容（WP90，55 §9 Q8）。
 *
 * 它不是一张独立的卡——按 Luoye 定的规矩，一家厂商只有一张卡，订阅登录是那张卡里
 * 的一个**方案**（OpenAI 卡的方案一，Anthropic 卡的方案一）。这个组件画的就是
 * 选中那个方案之后卡里的那一块。
 *
 * 四种样子：
 *
 * | 状态 | 画什么 |
 * |---|---|
 * | 这台机器不允许（公司档 / 托管档） | 灰掉 + 服务端给的那句人话，按钮不出现 |
 * | 没登录 | 一排登录按钮（这家有几种方式就有几个）+ 风险问号 |
 * | 登录中 | "去这个网址、输这串码"（设备码）或"去浏览器完成"（浏览器流）+ 取消 |
 * | 已登录 | 账号（脱敏，到期时间在 tooltip）、登出（WP426：模型下拉去掉，订阅的模型在默认模型下拉与 AI 钮里） |
 *
 * **风险那一段永远在**（WP426 起收进问号），不管登没登录，而且文案来自服务端（`risk_note`）——
 * 前端不重写一遍，改一处就够。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ExternalLink, Loader2, LogOut, UserRound } from 'lucide-react'
import { useEffect, useState } from 'react'
import { openExternal } from '@/components/connections/bridge'
import { Button } from '@/components/ui/button'
import { Hint } from '@/components/ui/hint'
import type { SubscriptionData, SubscriptionMethod, SubscriptionProviderId } from '@/lib/api'
import {
  answerModelSubscriptionLogin,
  getModelSubscription,
  signOutModelSubscription,
  startModelSubscriptionLogin,
} from '@/lib/api'
import { useApp } from '@/lib/app-context'

/** 登录途中每隔这么久问一次服务端"好了没"。 */
/**
 * WP424（Luoye 10-19）：与「DeepSeek 官方」同一级的订阅登录卡。登录走的是设置页那条订阅登录
 * （`SubscriptionPlan`，scripts/dev-subscription-login.md）。
 *
 * `enabled: false` 的是**留好的口子**：Claude 订阅登录上了还不能拿来跑活（服务端只把 ChatGPT 订阅
 * 当成模型来源），接通之前不显示——不放一个点了也用不上的入口。
 */
export const AI_SUBSCRIPTION_CARDS: readonly {
  provider: SubscriptionProviderId
  label: string
  enabled: boolean
}[] = [
  { provider: 'openai-codex', label: 'onboarding.ai.sub.chatgpt', enabled: true },
  { provider: 'anthropic', label: 'onboarding.ai.sub.claude', enabled: false },
]

/**
 * 这张订阅登录模板现在显示不显示：没登记在上表里的照旧显示；登记了但 `enabled: false`（Claude 订阅）的不显示——
 * 首次设置第 ① 步与设置页的模型面板同一个口径（int/1022：WP421 曾在设置页写「暂不可用」，按 WP424 的做法改成不显示）。
 */
export function subscriptionTemplateShown(tpl: {
  auth?: string
  subscription_provider?: string
}): boolean {
  if (tpl.auth !== 'subscription') return true
  const card = AI_SUBSCRIPTION_CARDS.find((c) => c.provider === tpl.subscription_provider)
  return card === undefined || card.enabled
}

const POLL_MS = 2000

export function SubscriptionPlan({
  provider,
  assignment,
  onReady,
}: {
  provider: SubscriptionProviderId
  assignment?: string
  /** WP424：首次设置第 ① 步——登上了就算接上 AI（向导据此亮「下一步」）。 */
  onReady?: () => void
}): React.ReactNode {
  const { t } = useApp()
  const client = useQueryClient()
  const [error, setError] = useState<string | null>(null)
  /** 贴回来的授权码。只在提交那一下用；提交完就清空，不进任何缓存。 */
  const [answer, setAnswer] = useState('')

  const state = useQuery({
    queryKey: ['model-subscription', provider, assignment],
    queryFn: () => getModelSubscription(provider, assignment),
    // 登录途中才轮询：人没在登录的时候不该每两秒发一次请求
    refetchInterval: (q) => (q.state.data?.in_flight === true ? POLL_MS : false),
  })

  const refresh = (data?: SubscriptionData): void => {
    if (data !== undefined) client.setQueryData(['model-subscription', provider, assignment], data)
    void client.invalidateQueries({ queryKey: ['model-subscription', provider] })
    // 登上之后首页那条"还没接模型"的黄条要跟着变
    void client.invalidateQueries({ queryKey: ['home'] })
    // WP362：订阅进了「默认模型」下拉与输入框的 AI 钮——两份清单跟着刷新
    void client.invalidateQueries({ queryKey: ['free-chat', 'models'] })
    void client.invalidateQueries({ queryKey: ['model-defaults'] })
  }

  const login = useMutation({
    mutationFn: (method: SubscriptionMethod) =>
      startModelSubscriptionLogin({ provider, method }, assignment),
    onSuccess: (data) => {
      setError(null)
      refresh(data)
      // 浏览器流：服务端把授权页地址回过来，这里交给系统浏览器打开（与连接页 OAuth 同一套）
      if (data.notice?.url !== undefined && data.notice.code === undefined) {
        openExternal(data.notice.url)
      }
    },
    onError: (e: Error) => setError(e.message),
  })

  const submitAnswer = useMutation({
    mutationFn: (value: string) => answerModelSubscriptionLogin(provider, value, assignment),
    onSuccess: (data) => {
      setAnswer('')
      setError(null)
      refresh(data)
    },
    onError: (e: Error) => setError(e.message),
  })

  const signOut = useMutation({
    mutationFn: () => signOutModelSubscription(provider, assignment),
    onSuccess: () => refresh(),
    onError: (e: Error) => setError(e.message),
  })

  const data = state.data
  const ready = data?.available === true && data.signed_in
  useEffect(() => {
    if (ready) onReady?.()
  }, [ready, onReady])
  if (data === undefined) {
    return (
      <p className="text-xs text-muted-foreground" data-testid="subscription-loading">
        {t('models.subscription.loading')}
      </p>
    )
  }

  const methodLabel = (m: SubscriptionMethod): string =>
    m === 'device' ? t('models.subscription.login.device') : t('models.subscription.login.browser')

  /*
   * WP426：风险那段（服务端原话）不再是一条黄底提示——收进问号，跟在动作那一行后面；登没登录都在。
   */
  const risk = <Hint text={data.risk_note} testId="subscription-risk-full" />

  return (
    <div className="flex flex-col gap-2" data-testid="subscription-plan" data-provider={provider}>
      {error === null ? null : (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-xs text-destructive">
          {error}
        </p>
      )}

      {data.available ? null : (
        <p
          className="flex items-center gap-1 text-xs text-muted-foreground"
          data-testid="subscription-unavailable"
        >
          {data.unavailable_reason ?? t('models.subscription.unavailable')}
          {risk}
        </p>
      )}

      {!data.available ? null : data.signed_in ? (
        /*
          WP426：登上了就是一行——账号（到期时间在 tooltip）+ 登出。「用哪个模型」下拉去掉了：
          订阅里的几个模型直接出现在「默认模型」下拉与输入框的 AI 钮里（WP362 早就进去了）。
        */
        <div
          className="flex flex-wrap items-center gap-x-3 gap-y-1.5"
          data-testid="subscription-signed-in"
        >
          <span
            className="inline-flex min-w-0 items-center gap-1.5 text-xs text-ws-body"
            data-testid="subscription-account"
            {...(data.expires_at === undefined
              ? {}
              : {
                  title: t('models.subscription.expires', {
                    at: new Date(data.expires_at).toLocaleString(),
                  }).replace(/^·\s*/, ''),
                })}
          >
            <UserRound aria-hidden className="size-3.5 shrink-0 text-ws-muted-fg" />
            <span className="truncate font-mono">{data.account ?? '—'}</span>
          </span>
          <span className="flex items-center gap-1">
            <Button
              size="xs"
              variant="ghost"
              data-testid="subscription-signout"
              disabled={signOut.isPending}
              onClick={() => {
                if (!globalThis.confirm(t('models.subscription.signout.confirm'))) return
                signOut.mutate()
              }}
            >
              <LogOut aria-hidden />
              {t('models.subscription.signout')}
            </Button>
            {risk}
          </span>
        </div>
      ) : data.in_flight ? (
        <div className="flex flex-col gap-2" data-testid="subscription-in-flight">
          <p className="flex items-center gap-1.5 text-xs">
            <Loader2 className="size-3.5 animate-spin" aria-hidden />
            {data.notice?.message ?? t('models.subscription.working')}
          </p>
          {data.notice?.code === undefined ? null : (
            <p className="text-xs">
              {t('models.subscription.code')}
              <code
                className="ml-1 rounded-sm bg-muted px-1.5 py-0.5 font-mono text-sm tracking-widest"
                data-testid="subscription-code"
              >
                {data.notice.code}
              </code>
            </p>
          )}
          {data.notice?.url === undefined ? null : (
            <button
              type="button"
              className="inline-flex w-fit items-center gap-1 text-xs text-primary underline-offset-4 hover:underline"
              data-testid="subscription-open"
              onClick={() => {
                if (data.notice?.url !== undefined) openExternal(data.notice.url)
              }}
            >
              {data.notice.url}
              <ExternalLink className="size-3" aria-hidden />
            </button>
          )}
          {data.question === undefined ? null : (
            <form
              className="flex items-end gap-2"
              data-testid="subscription-question"
              onSubmit={(e) => {
                e.preventDefault()
                if (answer.trim() !== '') submitAnswer.mutate(answer.trim())
              }}
            >
              <label className="flex grow flex-col gap-1 text-xs">
                <span className="text-muted-foreground">{data.question.message}</span>
                <input
                  className="h-8 rounded-md border bg-background px-2 text-xs"
                  type={data.question.kind === 'secret' ? 'password' : 'text'}
                  autoComplete="off"
                  placeholder={data.question.placeholder ?? ''}
                  value={answer}
                  onChange={(e) => setAnswer(e.target.value)}
                />
              </label>
              <Button size="sm" type="submit" disabled={submitAnswer.isPending}>
                {t('models.subscription.answer')}
              </Button>
            </form>
          )}
          <div>
            <Button
              size="sm"
              variant="ghost"
              data-testid="subscription-cancel"
              disabled={signOut.isPending}
              onClick={() => signOut.mutate()}
            >
              {t('models.subscription.cancel')}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-1.5" data-testid="subscription-signed-out">
          {data.last_error === undefined ? null : (
            <p className="text-xs text-destructive" data-testid="subscription-error">
              {data.last_error}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            {data.methods.map((m) => (
              <Button
                key={m}
                size="sm"
                variant={m === data.methods[0] ? 'default' : 'outline'}
                data-testid="subscription-login"
                data-method={m}
                disabled={login.isPending}
                onClick={() => login.mutate(m)}
              >
                {methodLabel(m)}
              </Button>
            ))}
            {risk}
          </div>
        </div>
      )}
    </div>
  )
}
