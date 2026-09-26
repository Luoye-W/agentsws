/**
 * 「用我的 DeepSeek 账号登录」那一块（WP134）：向导第 ① 步的第三张大卡与设置页「模型」的第三张卡
 * **共用这一个件**——分成两份的话，哪天改了一处另一处就会漏掉一步（与 WP127 的三步验证同一条理由）。
 *
 * 一条线走下来，界面只说当前这一步：
 *
 * 1. **没登录** → 一个按钮「用 DeepSeek 账号登录」。点了：服务端挂上 dsh 官方模块、起一次登录，
 *    拿到授权页地址 → 交给系统浏览器打开（桌面壳里走 `window.agentsws.openExternal`，普通浏览器里
 *    是新标签页——复用现有的外链打开逻辑）。
 * 2. **等浏览器** → 一句"在浏览器里登录并点同意，这一页会自己接上"，外加"再打开一次"与"取消"。
 *    这边每隔一会儿问一次状态；回调由官方模块在服务进程自己的端口上接住，不经过这一页。
 * 3. **登上了** → 账号名 + 余额（查不到就说人话，**不显示成 0**），接着自动存这条模型来源、
 *    跑三步验证（连通 → 文字 → 看图）。三步都过才算接上。
 *
 * WP150（跟官方 dsh 0.1.7-rc.2）：
 *
 * - **登录失效**：DeepSeek 那边不认这份登录了，服务端自动登出、摘掉这条模型来源；这里在登录按钮上面
 *   说一句"登录过期了，点一下重新登录"，按钮变成「重新登录」。重新登上后照样自动存 + 三步验证。
 * - **登出前确认并停任务**：点「登出」时先问一次服务端"现在有没有在用这个账号跑的事"。有就在卡片里
 *   列出这几件（事项名），确认后服务端先停这些、再登出；没有就是原来那个确认框。
 *
 * 凭据纪律：这个件里没有任何令牌——服务端给的只有「登录了没有 / 账号名 / 余额」。
 */
import { modelFailureKind, VISION_MODEL_EXAMPLES } from '@agentsws/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, ExternalLink, Loader2, LogIn, LogOut } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { BrandIcon } from '@/components/brand-icons'
import { openExternal } from '@/components/connections/bridge'
import { ModelCheckSteps } from '@/components/models/model-check-steps'
import { QuotaNotice } from '@/components/models/quota-notice'
import { Button } from '@/components/ui/button'
import {
  ApiClientError,
  cancelDeepSeekAccountLogin,
  DEEPSEEK_ACCOUNT_PROVIDER_ID,
  type DeepSeekAccountData,
  type DeepSeekAccountTask,
  type DeepSeekWallet,
  getDeepSeekAccount,
  listModelProviders,
  type ModelTestResult,
  saveDeepSeekAccountProvider,
  signOutDeepSeekAccount,
  startDeepSeekAccountLogin,
  testModelProvider,
} from '@/lib/api'
import { useApp } from '@/lib/app-context'

/** 登录途中多久问一次状态。 */
const POLL_MS = 1500

/** WP151：余额不足时多久刷一次余额（等用户充值回来）。 */
const QUOTA_POLL_MS = 30_000

/** 这几步是"还在走"，要接着问。 */
const IN_FLIGHT = new Set(['initializing', 'waiting-browser', 'exchanging', 'committing'])

/** 一个钱包 → 「¥42.50」。平台给的是十进制串，原样显示，不转数字。 */
export function formatWallet(w: DeepSeekWallet): string {
  return `${w.currency === 'CNY' ? '¥' : '$'}${w.balance}`
}

/** 验证没过那一句：账号这一路的"密钥不对"其实是登录失效，余额不足指的是 DeepSeek 账号。 */
export function accountTestKey(result: ModelTestResult): string {
  const kind = modelFailureKind(result)
  if (kind === 'key') return 'dsa.err.key'
  if (kind === 'balance') return 'dsa.err.balance'
  return `onboarding.ai.own.err.${kind}`
}

export interface DeepSeekAccountLoginProps {
  assignment?: string
  /** 三步都过了（向导据此亮「下一步」）。 */
  onConnected?: () => void
  /** 包一层卡片边框（设置页要，向导的大卡自己有边框）。 */
  framed?: boolean
}

export function DeepSeekAccountLogin({
  assignment,
  onConnected,
  framed = false,
}: DeepSeekAccountLoginProps): React.ReactNode {
  const { t } = useApp()
  const client = useQueryClient()
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const [test, setTest] = useState<ModelTestResult | undefined>(undefined)
  /** 这一次登录的授权页开过没有（同一次尝试只自动开一次）。 */
  const opened = useRef<string | undefined>(undefined)
  /** 登上之后的"存 + 测"只自动跑一次。 */
  const connecting = useRef(false)
  /** WP150：登出前要确认的那几件正在用账号跑的事（有才出那一块）。 */
  const [confirming, setConfirming] = useState<DeepSeekAccountTask[] | undefined>(undefined)

  const account = useQuery({
    queryKey: ['deepseek-account', assignment],
    queryFn: () => getDeepSeekAccount(assignment),
    retry: false,
    refetchInterval: (q) =>
      q.state.data?.attempt !== undefined && IN_FLIGHT.has(q.state.data.attempt.phase)
        ? POLL_MS
        : // WP151：余额不足时隔一会儿刷一次余额（去充值的浏览器回来时，窗口聚焦也会刷），充上了提示自己收
          q.state.data?.quota_exceeded !== undefined
          ? QUOTA_POLL_MS
          : false,
  })
  const providers = useQuery({
    queryKey: ['model-providers', assignment],
    queryFn: () => listModelProviders(assignment),
  })

  const data = account.data
  const row = providers.data?.providers.find((p) => p.id === DEEPSEEK_ACCOUNT_PROVIDER_ID)
  const shown = test ?? row?.last_test

  const refresh = (): void => {
    void client.invalidateQueries({ queryKey: ['deepseek-account'] })
    void client.invalidateQueries({ queryKey: ['model-providers'] })
    void client.invalidateQueries({ queryKey: ['model-defaults'] })
    // WP150：顶栏那个"现在用哪个模型"的芯片（`['models', 'defaults']`）也跟着变
    void client.invalidateQueries({ queryKey: ['models'] })
    void client.invalidateQueries({ queryKey: ['home'] })
  }

  const onError = (err: unknown): void => {
    setFailure(err instanceof ApiClientError ? err.message : t('error.generic'))
  }

  /** 拿到授权页就交给系统浏览器（同一次尝试只开一次）。 */
  const openOnce = (view: DeepSeekAccountData | undefined): void => {
    const attempt = view?.attempt
    if (attempt?.authorize_url === undefined || opened.current === attempt.id) return
    opened.current = attempt.id
    openExternal(attempt.authorize_url)
  }

  const login = useMutation({
    mutationFn: () => startDeepSeekAccountLogin(assignment),
    onSuccess: (view) => {
      setFailure(undefined)
      setTest(undefined)
      connecting.current = false
      client.setQueryData(['deepseek-account', assignment], view)
      openOnce(view)
    },
    onError,
  })

  const cancel = useMutation({
    mutationFn: (id: string) => cancelDeepSeekAccountLogin(id, assignment),
    onSuccess: (view) => {
      client.setQueryData(['deepseek-account', assignment], view)
    },
    onError,
  })

  const connect = useMutation({
    mutationFn: async (model: string) => {
      await saveDeepSeekAccountProvider(model, assignment)
      return testModelProvider(DEEPSEEK_ACCOUNT_PROVIDER_ID, assignment)
    },
    onSuccess: (result) => {
      setTest(result)
      setFailure(undefined)
      refresh()
      if (result.ok) onConnected?.()
    },
    onError,
  })

  const signOut = useMutation({
    mutationFn: () => signOutDeepSeekAccount(assignment),
    onSuccess: () => {
      setConfirming(undefined)
      setTest(undefined)
      connecting.current = false
      opened.current = undefined
      refresh()
    },
    onError,
  })

  // 登录是在 initializing 时回来的：等轮询拿到授权页再开浏览器
  useEffect(() => {
    openOnce(data)
  })

  /*
   * WP150：登出了（包括登录失效被自动登出）——上一次的"存 + 测"作废，重新登上时要再跑一遍；
   * 登出确认那一块也收起来。
   */
  const signedIn = data?.signed_in === true

  /*
   * WP151：余额刷新回来提示收了——模型卡与顶栏胶囊读的是模型来源那一份，跟着刷一下。
   */
  const quota = data?.quota_exceeded !== undefined
  const hadQuota = useRef(quota)
  useEffect(() => {
    if (hadQuota.current && !quota) {
      void client.invalidateQueries({ queryKey: ['model-providers'] })
    }
    hadQuota.current = quota
  }, [quota, client])

  useEffect(() => {
    if (signedIn) return
    connecting.current = false
    setTest(undefined)
    setConfirming(undefined)
  }, [signedIn])

  /** WP150：点「登出」：先问一次现在有没有在用这个账号跑的事，有就列出来让人确认。 */
  const askSignOut = async (): Promise<void> => {
    const fresh = (await account.refetch()).data ?? data
    const tasks = fresh?.running_tasks ?? []
    if (tasks.length > 0) {
      setConfirming(tasks)
      return
    }
    if (!globalThis.confirm(t('dsa.sign_out.confirm'))) return
    signOut.mutate()
  }

  // 登上了、这条还没存或还没验证过：自己存、自己测（用户按的是"登录"，中间这几下替他做完）
  useEffect(() => {
    if (data?.signed_in !== true || providers.isPending || connecting.current) return
    if (row?.last_test?.ok === true) {
      connecting.current = true
      onConnected?.()
      return
    }
    connecting.current = true
    connect.mutate(row?.model ?? data.default_model)
  }, [data, providers.isPending, row, connect, onConnected])

  if (account.isPending) return null
  const attempt = data?.attempt
  const phase = attempt?.phase
  const waiting = phase !== undefined && IN_FLIGHT.has(phase)
  const balance = data?.balance

  const body = (
    <div
      className="flex flex-col gap-2 text-sm"
      data-testid="dsa"
      data-signed-in={data?.signed_in === true}
      data-phase={phase ?? 'none'}
    >
      {framed ? (
        <>
          <p className="flex items-center gap-2 font-medium">
            <BrandIcon provider="deepseek" />
            {t('dsa.title')}
            <span className="rounded-sm bg-ws-subtle px-1.5 py-0.5 text-[11px] font-normal">
              {t('dsa.region')}
            </span>
          </p>
          <p className="text-xs text-muted-foreground">{t('dsa.summary')}</p>
        </>
      ) : null}

      {data?.available === false ? (
        <p className="text-xs text-muted-foreground" data-testid="dsa-unavailable">
          {data.unavailable_reason}
        </p>
      ) : data?.signed_in === true ? (
        <div className="flex flex-col gap-1.5" data-testid="dsa-signed-in">
          <p className="flex items-center gap-1.5">
            <Check aria-hidden className="size-4 text-primary" />
            {data.account === undefined
              ? t('dsa.signed_in.unknown')
              : t('dsa.signed_in', { account: data.account })}
          </p>
          {balance === undefined ? null : balance.status === 'ready' ? (
            <p className="text-xs text-ws-muted-fg" data-testid="dsa-balance">
              {t('dsa.balance', {
                balance:
                  balance.wallets.map(formatWallet).join(' / ') ||
                  formatWallet({ currency: 'CNY', balance: '0' }),
              })}
              {balance.bonus.length === 0
                ? null
                : ` · ${t('dsa.bonus', { bonus: balance.bonus.map(formatWallet).join(' / ') })}`}
            </p>
          ) : (
            <p className="text-xs text-ws-muted-fg" data-testid="dsa-balance-failed">
              {balance.message}
            </p>
          )}
          {data.account_error === undefined ? null : (
            <p className="text-xs text-ws-muted-fg">{data.account_error}</p>
          )}
          {/* WP151：余额不足——一行醒目提示 +「去充值」（官方 links.topUpUrl：充到这个账号上） */}
          {data.quota_exceeded === undefined ? null : (
            <QuotaNotice account topUpUrl={data.top_up_url} />
          )}
          {connect.isPending ? (
            <p className="flex items-center gap-1.5 text-ws-muted-fg" data-testid="dsa-testing">
              <Loader2 aria-hidden className="size-3.5 animate-spin" />
              {t('dsa.testing')}
            </p>
          ) : null}
          {shown === undefined ? null : <ModelCheckSteps steps={shown.steps} />}
          {shown === undefined || connect.isPending ? null : shown.ok ? (
            <p className="flex items-center gap-1.5 text-primary" data-testid="dsa-ok">
              <Check aria-hidden className="size-4" />
              {t('dsa.ok')}
            </p>
          ) : (
            <p
              role="alert"
              className="text-destructive"
              data-testid="dsa-test-failed"
              data-kind={modelFailureKind(shown)}
            >
              {t(accountTestKey(shown), { models: VISION_MODEL_EXAMPLES.join('、') })}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            {shown?.ok === false && !connect.isPending ? (
              <Button
                size="xs"
                variant="outline"
                data-testid="dsa-retest"
                onClick={() => {
                  connect.mutate(row?.model ?? data.default_model)
                }}
              >
                {t('dsa.retest')}
              </Button>
            ) : null}
            {/* 余额不足时「去充值」在上面那一行里，这里不再重复一个 */}
            {data.top_up_url === undefined || data.quota_exceeded !== undefined ? null : (
              <Button
                size="xs"
                variant="ghost"
                data-testid="dsa-top-up"
                onClick={() => {
                  if (data.top_up_url !== undefined) openExternal(data.top_up_url)
                }}
              >
                {t('dsa.top_up')}
                <ExternalLink aria-hidden className="size-3" />
              </Button>
            )}
            <Button
              size="xs"
              variant="ghost"
              disabled={signOut.isPending || confirming !== undefined}
              data-testid="dsa-sign-out"
              onClick={() => {
                void askSignOut()
              }}
            >
              <LogOut aria-hidden className="size-3" />
              {t('dsa.sign_out')}
            </Button>
          </div>
          {confirming === undefined ? null : (
            <div
              role="alertdialog"
              aria-labelledby="dsa-sign-out-tasks-title"
              className="flex flex-col gap-1.5 rounded-md bg-ws-warn-bg p-2 text-xs"
              data-testid="dsa-sign-out-tasks"
            >
              <p id="dsa-sign-out-tasks-title" className="font-medium text-ws-warn">
                {t('dsa.sign_out.tasks', { n: confirming.length })}
              </p>
              <ul className="flex flex-col gap-0.5 pl-1">
                {confirming.map((task) => (
                  <li
                    key={task.run_id}
                    className="flex items-center gap-1.5"
                    data-testid="dsa-sign-out-task"
                  >
                    <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-ws-warn" />
                    <span className="truncate">
                      {task.brand === undefined ? task.title : `${task.brand} · ${task.title}`}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="text-ws-muted-fg">{t('dsa.sign_out.tasks_hint')}</p>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="xs"
                  variant="destructive"
                  disabled={signOut.isPending}
                  data-testid="dsa-sign-out-stop"
                  onClick={() => {
                    signOut.mutate()
                  }}
                >
                  {signOut.isPending ? <Loader2 aria-hidden className="animate-spin" /> : null}
                  {t('dsa.sign_out.stop_and_leave')}
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={signOut.isPending}
                  data-testid="dsa-sign-out-keep"
                  onClick={() => {
                    setConfirming(undefined)
                  }}
                >
                  {t('dsa.sign_out.keep')}
                </Button>
              </div>
            </div>
          )}
        </div>
      ) : waiting ? (
        <div className="flex flex-col gap-1.5" data-testid="dsa-waiting">
          <p className="flex items-center gap-1.5 text-ws-muted-fg">
            <Loader2 aria-hidden className="size-3.5 animate-spin" />
            {phase === 'initializing' ? t('dsa.starting') : t('dsa.waiting')}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            {attempt?.authorize_url === undefined ? null : (
              <Button
                size="xs"
                variant="outline"
                data-testid="dsa-open-again"
                onClick={() => {
                  if (attempt.authorize_url !== undefined) openExternal(attempt.authorize_url)
                }}
              >
                <ExternalLink aria-hidden className="size-3" />
                {t('dsa.open_again')}
              </Button>
            )}
            <Button
              size="xs"
              variant="ghost"
              disabled={cancel.isPending || attempt === undefined}
              data-testid="dsa-cancel"
              onClick={() => {
                if (attempt !== undefined) cancel.mutate(attempt.id)
              }}
            >
              {t('dsa.cancel')}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          {data?.session_expired === undefined ? null : (
            // WP150：登录失效被自动登出——说人话，按钮变「重新登录」
            <p role="alert" className="text-xs text-ws-warn" data-testid="dsa-expired">
              {t('dsa.expired')}
            </p>
          )}
          {phase === 'cancelled' ? (
            <p className="text-xs text-ws-muted-fg" data-testid="dsa-cancelled">
              {t('dsa.cancelled')}
            </p>
          ) : attempt?.error === undefined ? null : (
            <p role="alert" className="text-xs text-destructive" data-testid="dsa-error">
              {attempt.error}
            </p>
          )}
          <Button
            size="sm"
            variant="outline"
            className="self-start"
            disabled={login.isPending}
            data-testid="dsa-login"
            onClick={() => {
              setFailure(undefined)
              login.mutate()
            }}
          >
            {login.isPending ? (
              <Loader2 className="animate-spin" aria-hidden />
            ) : (
              <LogIn aria-hidden />
            )}
            {data?.session_expired === undefined ? t('dsa.login') : t('dsa.relogin')}
          </Button>
        </div>
      )}

      {failure === undefined ? null : (
        <p role="alert" className="text-xs text-destructive" data-testid="dsa-failure">
          {failure}
        </p>
      )}
    </div>
  )

  if (!framed) return body
  return (
    <div className="rounded-lg border p-2.5" data-testid="model-deepseek-account-card">
      {body}
    </div>
  )
}
