/**
 * 登录页（WP28 交付 B）：真实模式下工作区不止一个人，所以不能再拿所有者的邮箱自动登录。
 *
 * 两条路进这一页：
 * - `/login`：填邮箱 → 要一个一次性登录链接。本地档直接把链接给你（一按就进），
 *   托管档只说"去收件箱点链接"——token 那时只走邮件，不进这个页面（20 §3）。
 * - `/invite/:token`：同事点邀请链接进来。先接受邀请（这一步不需要凭据），
 *   接受完他就是这个工作区的成员了，然后用同一个邮箱走上面那条登录。
 *
 * 页面上不出现任何裸 id：说的是"你已经加入 NordVolt Gear"，不是 `ws_dtc3c`。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  ApiClientError,
  acceptInvitation,
  bootstrapHint,
  requestMagicLink,
  signInWithToken,
} from '@/lib/api'
import { useApp } from '@/lib/app-context'

export function LoginPage(): React.ReactNode {
  const { t } = useApp()
  const params = useParams()
  const navigate = useNavigate()
  const client = useQueryClient()
  const inviteToken = params.token
  const [email, setEmail] = useState('')
  const [linkToken, setLinkToken] = useState<string | null>(null)
  const [mailed, setMailed] = useState(false)

  const hint = useQuery({ queryKey: ['bootstrap'], queryFn: bootstrapHint })

  // 邀请：进页面就接受，接受完把邮箱填好——同事只要再按一下"给我登录链接"
  const invite = useQuery({
    queryKey: ['invite', inviteToken],
    enabled: inviteToken !== undefined,
    retry: false,
    queryFn: () => acceptInvitation(inviteToken ?? ''),
  })

  const ownerHint = hint.data?.owner_email
  useEffect(() => {
    if (invite.data !== undefined) setEmail(invite.data.email)
    else if (inviteToken === undefined && ownerHint !== undefined)
      setEmail((current) => (current === '' ? ownerHint : current))
  }, [invite.data, ownerHint, inviteToken])

  const ask = useMutation({
    mutationFn: (value: string) => requestMagicLink(value),
    onSuccess: (issued) => {
      if (issued.token === undefined) setMailed(true)
      else setLinkToken(issued.token)
    },
  })

  const enter = useMutation({
    mutationFn: (token: string) => signInWithToken(token),
    onSuccess: async () => {
      // 邀请是一次性的：换完会话就把这条查询扔掉，否则重取会拿已经用过的 token 再试一次
      client.removeQueries({ queryKey: ['invite'] })
      await client.invalidateQueries({ queryKey: ['session'] })
      navigate('/', { replace: true })
    },
  })

  const failure = (err: unknown): string =>
    err instanceof ApiClientError ? err.message : t('error.generic')

  return (
    <div className="mx-auto flex min-h-screen max-w-md flex-col justify-center p-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">
            {inviteToken === undefined ? t('login.title') : t('login.invite.title')}
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 text-sm">
          {inviteToken === undefined ? null : invite.isPending ? (
            <p className="text-muted-foreground">{t('login.invite.joining')}</p>
          ) : invite.error !== null ? (
            <p role="alert" className="text-destructive" data-testid="invite-error">
              {t('login.invite.invalid')}
            </p>
          ) : (
            <p data-testid="invite-joined">
              {t('login.invite.joined', { workspace: invite.data?.workspace_name ?? '' })}
            </p>
          )}

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="login-email">{t('login.email')}</Label>
            <Input
              id="login-email"
              type="email"
              autoComplete="email"
              value={email}
              placeholder="you@company.com"
              onChange={(e) => {
                setEmail(e.target.value)
                setLinkToken(null)
                setMailed(false)
              }}
            />
          </div>

          <Button
            disabled={email.trim() === '' || ask.isPending}
            onClick={() => {
              ask.mutate(email.trim())
            }}
          >
            {t('login.send')}
          </Button>

          {ask.error === null ? null : (
            <p role="alert" className="text-destructive" data-testid="login-error">
              {failure(ask.error)}
            </p>
          )}
          {mailed ? (
            <p className="text-muted-foreground" data-testid="login-mailed">
              {t('login.mailed')}
            </p>
          ) : null}
          {linkToken === null ? null : (
            <div className="flex flex-col gap-2 rounded-md border bg-muted/40 p-3">
              <p className="text-muted-foreground">{t('login.ready')}</p>
              <Button
                variant="default"
                size="sm"
                data-testid="login-enter"
                disabled={enter.isPending}
                onClick={() => {
                  enter.mutate(linkToken)
                }}
              >
                {t('login.enter')}
              </Button>
            </div>
          )}
          <p className="text-xs text-muted-foreground">{t('login.note')}</p>
        </CardContent>
      </Card>
    </div>
  )
}
