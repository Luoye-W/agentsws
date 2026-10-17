/**
 * 决策 943（WP371）：用工坊账号进这个工作区（邮箱 + 6 位验证码）。
 *
 * 本机服务替页面去问云端「这个邮箱 + 验证码对不对」，对上了、这个邮箱又是这个工作区的成员，
 * 才签一张一次性登录 token 交回登录页的「进去」那一步。云端那张会话当场注销，本机不留。
 * 本机档、局域网档都有这一块；局域网档里它是主人 / 已加入的同事的主路（设置码、邀请链接是备用）。
 */
import { useMutation } from '@tanstack/react-query'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ApiClientError, sendAccountLoginCode, verifyAccountLoginCode } from '@/lib/api'
import { useApp } from '@/lib/app-context'

export function AccountLoginPanel({
  initialEmail = '',
  onToken,
}: {
  /** 预填的邮箱（本机档是主人的、邀请进来的是被邀请人的）。 */
  initialEmail?: string
  /** 验码成功：把一次性登录 token 交回登录页（页面上不显示它）。 */
  onToken: (token: string) => void
}): React.ReactNode {
  const { t, lang } = useApp()
  const [email, setEmail] = useState(initialEmail)
  const [code, setCode] = useState('')
  const [sentTo, setSentTo] = useState<string | null>(null)

  const send = useMutation({
    mutationFn: (value: string) => sendAccountLoginCode(value, lang),
    onSuccess: (_out, value) => {
      setSentTo(value)
    },
  })
  const verify = useMutation({
    mutationFn: (input: { email: string; code: string }) =>
      verifyAccountLoginCode(input.email, input.code),
    onSuccess: (issued) => {
      setCode('')
      onToken(issued.token)
    },
  })
  const failure = (err: unknown): string => {
    if (!(err instanceof ApiClientError)) return t('error.generic')
    if (err.reason === 'not_member') return t('login.account.notMember', { email: sentTo ?? email })
    return err.message
  }
  const error = verify.error ?? send.error

  return (
    <div className="flex flex-col gap-2" data-testid="login-account">
      <Label htmlFor="login-account-email">{t('login.account.email')}</Label>
      <div className="flex gap-2">
        <Input
          id="login-account-email"
          type="email"
          autoComplete="email"
          value={email}
          placeholder="you@company.com"
          onChange={(e) => {
            setEmail(e.target.value)
            setSentTo(null)
          }}
        />
        <Button
          variant={sentTo === null ? 'default' : 'outline'}
          data-testid="login-account-send"
          disabled={!email.includes('@') || send.isPending}
          onClick={() => {
            verify.reset()
            send.mutate(email.trim().toLowerCase())
          }}
        >
          {sentTo === null ? t('login.account.send') : t('login.account.resend')}
        </Button>
      </div>
      {sentTo === null ? null : (
        <div className="flex gap-2">
          <Input
            aria-label={t('login.account.code')}
            data-testid="login-account-code"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={code}
            placeholder={t('login.account.code')}
            onChange={(e) => {
              setCode(e.target.value.replace(/\D/gu, ''))
            }}
          />
          <Button
            data-testid="login-account-verify"
            disabled={code.length !== 6 || verify.isPending}
            onClick={() => {
              verify.mutate({ email: sentTo, code })
            }}
          >
            {t('login.account.verify')}
          </Button>
        </div>
      )}
      {sentTo === null ? null : (
        <p className="text-xs text-muted-foreground" data-testid="login-account-sent">
          {t('login.account.sent', { email: sentTo })}
        </p>
      )}
      {error === null ? null : (
        <p role="alert" className="text-destructive" data-testid="login-account-error">
          {failure(error)}
        </p>
      )}
    </div>
  )
}
