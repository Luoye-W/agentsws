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
 * | 没登录 | 风险提示 + 一排登录按钮（这家有几种方式就有几个） |
 * | 登录中 | "去这个网址、输这串码"（设备码）或"去浏览器完成"（浏览器流）+ 取消 |
 * | 已登录 | 账号（脱敏）、到期时间、模型下拉（价目一律"订阅"）、登出 |
 *
 * **风险那一段永远显示**，不管登没登录，而且文案来自服务端（`risk_note`）——
 * 前端不重写一遍，改一处就够。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CheckCircle2, ExternalLink, Loader2, LogOut, TriangleAlert } from 'lucide-react'
import { useState } from 'react'
import { openExternal } from '@/components/connections/bridge'
import { Button } from '@/components/ui/button'
import type { SubscriptionData, SubscriptionMethod, SubscriptionProviderId } from '@/lib/api'
import {
  answerModelSubscriptionLogin,
  getModelSubscription,
  selectModelSubscriptionModel,
  signOutModelSubscription,
  startModelSubscriptionLogin,
} from '@/lib/api'
import { useApp } from '@/lib/app-context'

/** 登录途中每隔这么久问一次服务端"好了没"。 */
const POLL_MS = 2000

export function SubscriptionPlan({
  provider,
  assignment,
}: {
  provider: SubscriptionProviderId
  assignment?: string
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

  const chooseModel = useMutation({
    mutationFn: (model: string) => selectModelSubscriptionModel(provider, model, assignment),
    onSuccess: (data) => refresh(data),
    onError: (e: Error) => setError(e.message),
  })

  const signOut = useMutation({
    mutationFn: () => signOutModelSubscription(provider, assignment),
    onSuccess: () => refresh(),
    onError: (e: Error) => setError(e.message),
  })

  const data = state.data
  if (data === undefined) {
    return (
      <p className="mt-2 text-xs text-muted-foreground" data-testid="subscription-loading">
        {t('models.subscription.loading')}
      </p>
    )
  }

  const methodLabel = (m: SubscriptionMethod): string =>
    m === 'device' ? t('models.subscription.login.device') : t('models.subscription.login.browser')

  return (
    <div
      className="mt-2 flex flex-col gap-2"
      data-testid="subscription-plan"
      data-provider={provider}
    >
      {/* 风险提示：登没登录都在，文案来自服务端 */}
      <p
        className="flex items-start gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-[11px] leading-relaxed"
        data-testid="subscription-risk"
      >
        <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-amber-600" aria-hidden />
        <span>{data.risk_note}</span>
      </p>

      {error === null ? null : (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-xs text-destructive">
          {error}
        </p>
      )}

      {data.available ? null : (
        <p className="text-xs text-muted-foreground" data-testid="subscription-unavailable">
          {data.unavailable_reason ?? t('models.subscription.unavailable')}
        </p>
      )}

      {!data.available ? null : data.signed_in ? (
        <div className="flex flex-col gap-2" data-testid="subscription-signed-in">
          <p className="flex items-center gap-1.5 text-xs">
            <CheckCircle2 className="size-3.5 text-emerald-600" aria-hidden />
            <span data-testid="subscription-account">
              {t('models.subscription.signed_in', { account: data.account ?? '—' })}
            </span>
            {data.expires_at === undefined ? null : (
              <span className="text-muted-foreground">
                {t('models.subscription.expires', {
                  at: new Date(data.expires_at).toLocaleString(),
                })}
              </span>
            )}
          </p>
          {data.models.length === 0 ? null : (
            <label className="flex flex-col gap-1 text-xs">
              <span className="text-muted-foreground">
                {t('models.subscription.model')}
                <span className="ml-1 rounded bg-muted px-1 py-0.5 text-[10px]">
                  {t('models.subscription.price')}
                </span>
              </span>
              <select
                className="h-8 rounded-md border bg-background px-2 text-xs"
                data-testid="subscription-model"
                value={data.selected_model ?? ''}
                disabled={chooseModel.isPending}
                onChange={(e) => {
                  if (e.target.value !== '') chooseModel.mutate(e.target.value)
                }}
              >
                <option value="">{t('models.subscription.model.pick')}</option>
                {data.models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <div>
            <Button
              size="sm"
              variant="outline"
              data-testid="subscription-signout"
              disabled={signOut.isPending}
              onClick={() => {
                if (!globalThis.confirm(t('models.subscription.signout.confirm'))) return
                signOut.mutate()
              }}
            >
              <LogOut className="size-3.5" aria-hidden />
              {t('models.subscription.signout')}
            </Button>
          </div>
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
                className="ml-1 rounded bg-muted px-1.5 py-0.5 font-mono text-sm tracking-widest"
                data-testid="subscription-code"
              >
                {data.notice.code}
              </code>
            </p>
          )}
          {data.notice?.url === undefined ? null : (
            <button
              type="button"
              className="inline-flex w-fit items-center gap-1 text-[11px] text-primary underline-offset-4 hover:underline"
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
          <div className="flex flex-wrap gap-2">
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
          </div>
        </div>
      )}
    </div>
  )
}
