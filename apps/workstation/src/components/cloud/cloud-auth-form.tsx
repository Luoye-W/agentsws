/**
 * WP231（Luoye 10-05）：「Agents 工坊账号」的**注册 / 登录**表单——向导第 ① 步那张「用 Agents 工坊的接口」
 * 与设置页「Agents 工坊账号」卡是**同一个件**，口径与网页版 `/account` 一致（同一套云端接口）。
 *
 * - 两个页签：**注册新账号**（默认，大多数人）/ **已有账号，登录**。
 * - 注册：名字或公司名 + 邮箱 + 密码（≥ 8 位，强度条；不要「确认密码」，给眼睛）+ 勾选同意《用户条款》
 *   《隐私政策》（链接到官网，新窗口；不勾不能提交）→ 云发 6 位验证码 → 输对了才建号、送 10 积分。
 *   邮箱注册过 → 「这个邮箱注册过了，直接登录」+ 一键切到登录。
 * - 登录两种：默认「邮箱验证码」（没注册的邮箱云上静默不发，界面统一说「如果已注册，验证码已发出；
 *   还没有账号？去注册」）；另一种「密码登录」，下面挂「忘记密码」（验证码 + 新密码）。
 *
 * **原生表单**（同 `SecureForm` 的纪律）：密码与验证码用浏览器原生 `<form>` + `FormData` 取，
 * 不进 React state、不进任何全局变量、不打 `console.*`；提交完立刻 `form.reset()`。强度条只存分数。
 * 发给本机服务的那一跳由它转到云（HTTPS），本机不落盘、不进事件、不经 AI。
 */
import { legalDocumentUrl, passwordStrength } from '@agentsws/contracts'
import { AlertCircle, Eye, EyeOff, Loader2, MailCheck } from 'lucide-react'
import { type FormEvent, useId, useState } from 'react'
import { openExternal } from '@/components/connections/bridge'
import { Button } from '@/components/ui/button'
import { Hint, SafetyNote } from '@/components/ui/hint'
import { Input } from '@/components/ui/input'
import {
  ApiClientError,
  type CloudAuthDone,
  cloudLoginCode,
  cloudLoginCodeVerify,
  cloudPasswordForgot,
  cloudPasswordLogin,
  cloudPasswordReset,
  cloudSignup,
  cloudSignupVerify,
} from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { cn } from '@/lib/utils'

export type CloudAuthTab = 'signup' | 'login'
type LoginVia = 'code' | 'password'
type Step = 'form' | 'code' | 'forgot'
type CodeFor = 'signup' | 'login' | 'reset'

interface Failure {
  /** 云回的 `details.reason`（已注册 / 验证码不对 / 锁定…）；有它就按词条说。 */
  reason?: string
  message: string
  /** 连不上云（给「再试一次」与「先逛逛演示数据」）。 */
  offline?: boolean
}

export interface CloudAuthFormProps {
  assignment?: string
  /** testid 前缀：向导用 `ai-official`，设置页用 `cloud-account`。 */
  testPrefix: string
  /** 注册 / 登录成了（本机已关联）。 */
  onDone: (result: CloudAuthDone) => void
  /** 连不上云时多给一个「先逛逛演示数据」（只有向导给）。 */
  onDemo?: () => void
  disabled?: boolean
  /** 一打开停在哪个页签（默认「注册新账号」）。 */
  initialTab?: CloudAuthTab
  /** 预填的邮箱（WP265：重新登录时填好账号邮箱）。 */
  initialEmail?: string
  /**
   * WP265：已关联、**同一个账号**再登录一次换新令牌（老令牌缺新动作集）。只有登录页签、
   * 没有「去注册」；登录那几条带 `refresh: true`。
   */
  refresh?: boolean
}

const fieldOf = (form: HTMLFormElement, name: string): string => {
  const v = new FormData(form).get(name)
  return typeof v === 'string' ? v : ''
}

export function CloudAuthForm({
  assignment,
  testPrefix: p,
  onDone,
  onDemo,
  disabled = false,
  initialTab,
  initialEmail,
  refresh = false,
}: CloudAuthFormProps): React.ReactNode {
  const { t, lang } = useApp()
  const id = useId()
  const [tab, setTab] = useState<CloudAuthTab>(initialTab ?? (refresh ? 'login' : 'signup'))
  const [via, setVia] = useState<LoginVia>('code')
  const [step, setStep] = useState<Step>('form')
  const [codeFor, setCodeFor] = useState<CodeFor>('signup')
  const [name, setName] = useState('')
  const [email, setEmail] = useState(initialEmail ?? '')
  const [agree, setAgree] = useState(false)
  const [show, setShow] = useState(false)
  /** 强度条只存分数，不存密码。 */
  const [strength, setStrength] = useState<0 | 1 | 2 | 3 | 4 | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<Failure | undefined>(undefined)
  /** 上一次失败的那个动作（「再试一次」重放它；里面没有密码——要密码的动作失败了让人重填）。 */
  const [retry, setRetry] = useState<(() => void) | undefined>(undefined)

  const locale = lang === 'en' ? 'en' : 'zh'
  const clean = email.trim().toLowerCase()
  /** WP265：重新登录那一档，登录那几条多带一个 `refresh: true`。 */
  const again = refresh ? { refresh: true as const } : {}

  const fail = (err: unknown, again?: () => void): void => {
    if (err instanceof ApiClientError) {
      if (err.code === 'provider_unavailable')
        setFailure({ message: t('onboarding.ai.official.offline'), offline: true })
      else if (err.reason !== undefined) setFailure({ reason: err.reason, message: err.message })
      else if (err.code === 'rate_limited')
        setFailure({ reason: 'rate_limited', message: err.message })
      else setFailure({ message: err.message })
    } else setFailure({ message: t('error.generic') })
    setRetry(() => again)
  }

  const run = async <T,>(work: () => Promise<T>, after: (out: T) => void, again?: () => void) => {
    setBusy(true)
    setFailure(undefined)
    setRetry(undefined)
    try {
      after(await work())
    } catch (err) {
      fail(err, again)
    } finally {
      setBusy(false)
    }
  }

  const switchTab = (next: CloudAuthTab): void => {
    setTab(next)
    setStep('form')
    setFailure(undefined)
    setStrength(undefined)
  }

  const sendLoginCode = (purpose: 'login' | 'reset'): void => {
    const send = (): void => {
      void run(
        () =>
          purpose === 'login'
            ? cloudLoginCode({ email: clean, locale, ...again }, assignment)
            : cloudPasswordForgot({ email: clean, locale }, assignment),
        () => {
          setCodeFor(purpose)
          setStep('code')
        },
        send,
      )
    }
    send()
  }

  const onSignup = (e: FormEvent<HTMLFormElement>): void => {
    e.preventDefault()
    const form = e.currentTarget
    const password = fieldOf(form, 'password')
    form.reset()
    setStrength(undefined)
    void run(
      () => cloudSignup({ name: name.trim(), email: clean, password, locale }, assignment),
      () => {
        setCodeFor('signup')
        setStep('code')
      },
    )
  }

  const onPasswordLogin = (e: FormEvent<HTMLFormElement>): void => {
    e.preventDefault()
    const form = e.currentTarget
    const password = fieldOf(form, 'password')
    form.reset()
    void run(() => cloudPasswordLogin({ email: clean, password, ...again }, assignment), onDone)
  }

  const onCode = (e: FormEvent<HTMLFormElement>): void => {
    e.preventDefault()
    const form = e.currentTarget
    const code = fieldOf(form, 'code').trim()
    const next = codeFor === 'reset' ? fieldOf(form, 'new_password') : ''
    form.reset()
    setStrength(undefined)
    void run(
      () =>
        codeFor === 'signup'
          ? cloudSignupVerify({ email: clean, code }, assignment)
          : codeFor === 'login'
            ? cloudLoginCodeVerify({ email: clean, code, ...again }, assignment)
            : cloudPasswordReset({ email: clean, code, new_password: next }, assignment),
      onDone,
    )
  }

  const errorText = (f: Failure): string => {
    if (f.reason !== undefined) {
      const key = `cauth.err.${f.reason}`
      const said = t(key)
      if (said !== key) return said
    }
    return f.message
  }

  const passwordField = (fieldName: 'password' | 'new_password', meter: boolean) => (
    <div className="flex flex-col gap-1">
      <div className="relative">
        <Input
          name={fieldName}
          type={show ? 'text' : 'password'}
          required
          minLength={meter ? 8 : 1}
          maxLength={128}
          autoComplete={meter ? 'new-password' : 'current-password'}
          spellCheck={false}
          aria-label={t(fieldName === 'password' ? 'cauth.password' : 'cauth.forgot.new')}
          placeholder={
            meter
              ? t('cauth.password.placeholder')
              : t(fieldName === 'password' ? 'cauth.password' : 'cauth.forgot.new')
          }
          data-testid={`${p}-${fieldName === 'password' ? 'password' : 'new-password'}`}
          className="pr-9"
          onInput={
            meter
              ? (ev) => {
                  const v = (ev.target as HTMLInputElement).value
                  setStrength(v === '' ? undefined : passwordStrength(v))
                }
              : undefined
          }
        />
        <button
          type="button"
          className="absolute inset-y-0 right-2 flex items-center text-muted-foreground hover:text-foreground"
          aria-label={t(show ? 'cauth.password.hide' : 'cauth.password.show')}
          data-testid={`${p}-eye`}
          onClick={() => {
            setShow((v) => !v)
          }}
        >
          {show ? (
            <EyeOff aria-hidden className="size-4" />
          ) : (
            <Eye aria-hidden className="size-4" />
          )}
        </button>
      </div>
      {meter && strength !== undefined ? (
        <div
          className="flex items-center gap-2"
          data-testid={`${p}-strength`}
          data-score={strength}
        >
          <div className="flex flex-1 gap-1" aria-hidden>
            {[1, 2, 3, 4].map((n) => (
              <span
                key={n}
                className={cn(
                  'h-1 flex-1 rounded-full',
                  strength >= n
                    ? strength <= 1
                      ? 'bg-destructive'
                      : strength === 2
                        ? 'bg-amber-500'
                        : 'bg-primary'
                    : 'bg-ws-subtle',
                )}
              />
            ))}
          </div>
          <span className="text-[11px] text-ws-muted-fg" data-slot="status">
            {t(`cauth.strength.${String(strength)}`)}
          </span>
        </div>
      ) : null}
    </div>
  )

  const emailField = (
    <Input
      type="email"
      required
      maxLength={320}
      autoComplete="email"
      aria-label={t('cauth.email')}
      placeholder={t('cauth.email')}
      data-testid={`${p}-email`}
      value={email}
      onChange={(e) => {
        setEmail(e.target.value)
      }}
    />
  )

  const legal = (doc: 'terms' | 'privacy') => (
    <button
      type="button"
      className="text-primary underline-offset-2 hover:underline"
      data-testid={`${p}-${doc}`}
      onClick={() => {
        openExternal(legalDocumentUrl(doc, locale))
      }}
    >
      {t(doc === 'terms' ? 'cauth.terms' : 'cauth.privacy')}
    </button>
  )

  const pill = (on: boolean) =>
    cn(
      'rounded-full border px-2.5 py-0.5 text-xs',
      on ? 'border-primary text-foreground' : 'text-ws-muted-fg',
    )

  return (
    <div className="flex flex-col gap-2" data-testid={`${p}-auth`} data-tab={tab} data-step={step}>
      <div className={cn('flex flex-wrap gap-1.5', refresh && 'hidden')} role="tablist">
        {(['signup', 'login'] as const).map((k) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={tab === k}
            data-testid={`${p}-tab-${k}`}
            className={pill(tab === k)}
            onClick={() => {
              switchTab(k)
            }}
          >
            {t(`cauth.tab.${k}`)}
          </button>
        ))}
      </div>

      {step === 'code' ? (
        <form className="flex flex-col gap-2" onSubmit={onCode} data-testid={`${p}-code-form`}>
          <p
            className="flex items-start gap-1.5 text-ws-muted-fg"
            data-slot="status"
            data-testid={`${p}-sent`}
          >
            <MailCheck aria-hidden className="mt-0.5 size-4 shrink-0 text-primary" />
            <span>{t(`cauth.code.sent.${codeFor}`, { email: clean })}</span>
          </p>
          <div className="flex items-center gap-2">
            <Input
              name="code"
              required
              inputMode="numeric"
              pattern="\d{6}"
              maxLength={6}
              autoComplete="one-time-code"
              aria-label={t('cauth.code')}
              placeholder={t('cauth.code')}
              data-testid={`${p}-code`}
              className="max-w-40 tracking-[0.3em]"
            />
            {codeFor === 'reset' ? null : (
              <Button
                size="sm"
                type="submit"
                disabled={busy || disabled}
                data-testid={`${p}-verify`}
              >
                {busy ? <Loader2 aria-hidden className="animate-spin" /> : null}
                {t('cauth.code.verify')}
              </Button>
            )}
          </div>
          {codeFor === 'reset' ? (
            <>
              {passwordField('new_password', true)}
              <Button
                size="sm"
                type="submit"
                className="self-start"
                disabled={busy || disabled}
                data-testid={`${p}-verify`}
              >
                {busy ? <Loader2 aria-hidden className="animate-spin" /> : null}
                {t('cauth.forgot.submit')}
              </Button>
            </>
          ) : null}
          <div className="flex flex-wrap items-center gap-3 text-xs">
            {codeFor === 'signup' ? (
              <button
                type="button"
                className="text-ws-muted-fg hover:text-foreground"
                data-testid={`${p}-back`}
                onClick={() => {
                  setStep('form')
                  setFailure(undefined)
                }}
              >
                {t('cauth.back')}
              </button>
            ) : (
              <button
                type="button"
                className="text-ws-muted-fg hover:text-foreground"
                data-testid={`${p}-resend`}
                disabled={busy}
                onClick={() => {
                  sendLoginCode(codeFor)
                }}
              >
                {t('cauth.code.resend')}
              </button>
            )}
            {codeFor === 'login' && !refresh ? (
              <span className="text-ws-muted-fg">
                {t('cauth.code.no_account')}{' '}
                <button
                  type="button"
                  className="text-primary underline-offset-2 hover:underline"
                  data-testid={`${p}-go-signup`}
                  onClick={() => {
                    switchTab('signup')
                  }}
                >
                  {t('cauth.go.signup')}
                </button>
              </span>
            ) : null}
          </div>
        </form>
      ) : tab === 'signup' ? (
        <form className="flex flex-col gap-2" onSubmit={onSignup} data-testid={`${p}-signup-form`}>
          <p className="flex items-center gap-1 text-xs text-ws-muted-fg">
            {t('cauth.signup.lead')}
            <Hint text={t('cauth.signup.lead.hint')} />
          </p>
          <Input
            required
            maxLength={120}
            autoComplete="organization"
            aria-label={t('cauth.name')}
            placeholder={t('cauth.name')}
            data-testid={`${p}-name`}
            value={name}
            onChange={(e) => {
              setName(e.target.value)
            }}
          />
          {emailField}
          {passwordField('password', true)}
          <label htmlFor={`${id}-agree`} className="flex items-start gap-1.5 text-xs">
            <input
              id={`${id}-agree`}
              type="checkbox"
              className="mt-0.5"
              data-testid={`${p}-agree`}
              checked={agree}
              onChange={(e) => {
                setAgree(e.target.checked)
              }}
            />
            <span>
              {t('cauth.agree.before')} {legal('terms')} {t('cauth.agree.and')} {legal('privacy')}
            </span>
          </label>
          <Button
            size="sm"
            type="submit"
            className="self-start"
            disabled={busy || disabled || !agree || clean === '' || name.trim() === ''}
            data-testid={`${p}-send`}
          >
            {busy ? <Loader2 aria-hidden className="animate-spin" /> : null}
            {t('cauth.signup.send')}
          </Button>
        </form>
      ) : step === 'forgot' ? (
        <form
          className="flex flex-col gap-2"
          data-testid={`${p}-forgot-form`}
          onSubmit={(e) => {
            e.preventDefault()
            sendLoginCode('reset')
          }}
        >
          <p className="text-xs text-ws-muted-fg">{t('cauth.forgot.lead')}</p>
          {emailField}
          <div className="flex items-center gap-3">
            <Button
              size="sm"
              type="submit"
              disabled={busy || disabled || clean === ''}
              data-testid={`${p}-send`}
            >
              {busy ? <Loader2 aria-hidden className="animate-spin" /> : null}
              {t('cauth.forgot.send')}
            </Button>
            <button
              type="button"
              className="text-xs text-ws-muted-fg hover:text-foreground"
              data-testid={`${p}-back`}
              onClick={() => {
                setStep('form')
                setFailure(undefined)
              }}
            >
              {t('cauth.back')}
            </button>
          </div>
        </form>
      ) : (
        <form
          className="flex flex-col gap-2"
          data-testid={`${p}-login-form`}
          onSubmit={(e) => {
            if (via === 'password') {
              onPasswordLogin(e)
              return
            }
            e.preventDefault()
            sendLoginCode('login')
          }}
        >
          <div className="flex gap-1.5">
            {(['code', 'password'] as const).map((k) => (
              <button
                key={k}
                type="button"
                aria-pressed={via === k}
                data-testid={`${p}-via-${k}`}
                className={cn(
                  'rounded-sm border px-2 py-0.5 text-[11px]',
                  via === k ? 'border-primary text-foreground' : 'text-ws-muted-fg',
                )}
                onClick={() => {
                  setVia(k)
                  setFailure(undefined)
                }}
              >
                {t(k === 'code' ? 'cauth.login.code' : 'cauth.login.password')}
              </button>
            ))}
          </div>
          {emailField}
          {via === 'password' ? passwordField('password', false) : null}
          <div className="flex items-center gap-3">
            <Button
              size="sm"
              type="submit"
              disabled={busy || disabled || clean === ''}
              data-testid={`${p}-send`}
            >
              {busy ? <Loader2 aria-hidden className="animate-spin" /> : null}
              {t(via === 'code' ? 'cauth.login.send' : 'cauth.login.submit')}
            </Button>
            {via === 'password' ? (
              <button
                type="button"
                className="text-xs text-ws-muted-fg hover:text-foreground"
                data-testid={`${p}-forgot`}
                onClick={() => {
                  setStep('forgot')
                  setFailure(undefined)
                }}
              >
                {t('cauth.forgot')}
              </button>
            ) : null}
          </div>
        </form>
      )}

      {busy ? (
        <p
          className="flex items-center gap-1.5 text-xs text-ws-muted-fg"
          data-slot="status"
          data-testid={`${p}-pending`}
        >
          <Loader2 aria-hidden className="size-3.5 animate-spin" />
          {t('onboarding.ai.official.pending')}
        </p>
      ) : null}

      {failure === undefined || busy ? null : (
        <div
          className="flex flex-col gap-2"
          data-testid={`${p}-failed`}
          data-reason={failure.reason}
        >
          <p
            role="alert"
            className="flex items-start gap-1.5 text-destructive"
            data-testid={`${p}-error`}
          >
            <AlertCircle aria-hidden className="mt-0.5 size-4 shrink-0" />
            <span>{errorText(failure)}</span>
          </p>
          <div className="flex flex-wrap items-center gap-2">
            {failure.reason === 'already_registered' ? (
              <Button
                size="sm"
                variant="outline"
                data-testid={`${p}-switch-login`}
                onClick={() => {
                  setVia('code')
                  switchTab('login')
                }}
              >
                {t('cauth.go.login')}
              </Button>
            ) : null}
            {failure.reason === 'locked' || failure.reason === 'bad_credentials' ? (
              <Button
                size="sm"
                variant="outline"
                data-testid={`${p}-switch-code`}
                onClick={() => {
                  setVia('code')
                  setFailure(undefined)
                }}
              >
                {t('cauth.login.code')}
              </Button>
            ) : null}
            {failure.offline === true && retry !== undefined ? (
              <Button
                size="sm"
                variant="outline"
                data-testid={`${p}-retry`}
                onClick={() => {
                  retry()
                }}
              >
                {t('onboarding.ai.official.retry')}
              </Button>
            ) : null}
            {failure.offline === true && onDemo !== undefined ? (
              <Button size="sm" variant="ghost" data-testid={`${p}-demo`} onClick={onDemo}>
                {t('onboarding.ai.demo')}
              </Button>
            ) : null}
          </div>
        </div>
      )}

      <SafetyNote text={t('cauth.safety')} />
    </div>
  )
}
