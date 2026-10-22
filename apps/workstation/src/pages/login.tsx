/**
 * 登录页（WP28 交付 B）：真实模式下工作区不止一个人，所以不能再拿所有者的邮箱自动登录。
 *
 * 两条路进这一页：
 * - `/login`：填邮箱 → 要一个一次性登录链接。本地档直接把链接给你（一按就进），
 *   托管档只说"去收件箱点链接"——token 那时只走邮件，不进这个页面（20 §3）。
 * - `/invite/:token`：同事点邀请链接进来。先接受邀请（这一步不需要凭据），
 *   接受完他就是这个工作区的成员了，然后用同一个邮箱走上面那条登录。
 *
 * 决策 945：服务开给局域网（bootstrap 里 `login: 'shared'`）时不出邮箱框——主人用日志里的
 * 设置码（{@link SharedLoginPanel}），同事的邀请接受完直接带登录 token。
 *
 * 页面上不出现任何裸 id：说的是"你已经加入 NordVolt Gear"，不是 `ws_dtc3c`。
 *
 * WP358：这一页常被当成「工坊账号注册 / 登录」。标题下一句话说清楚它是进这个工作区、
 * 不是工坊账号；邮箱不是成员时不再只报「未知邮箱」，而是告诉人该怎么办
 * （主人一键换成主人的邮箱，同事去找负责人要邀请链接）。
 *
 * WP371（决策 943）：也能用工坊账号（邮箱 + 验证码）进。局域网档它在最上面（主人 / 已加入的同事的
 * 主路，设置码是备用）；本机档一次性链接一按就进，工坊账号收在一个按钮后面。所以 WP358 那句
 * 「这不是工坊账号登录，不用密码」两档都不对了：本机档只留前半句，局域网档不出副标题。
 */
import { isPlaceholderOwnerEmail } from '@agentsws/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { BrandMark } from '@/components/design'
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
import { AccountLoginPanel } from './login-account'
import { SharedLoginPanel } from './login-shared'

export function LoginPage(): React.ReactNode {
  const { t } = useApp()
  const params = useParams()
  const navigate = useNavigate()
  const client = useQueryClient()
  const inviteToken = params.token
  const [email, setEmail] = useState('')
  const [linkToken, setLinkToken] = useState<string | null>(null)
  const [mailed, setMailed] = useState(false)
  // 决策 943：本机档的工坊账号入口先收着（一次性链接一按就进）；局域网档一直展开
  const [withAccount, setWithAccount] = useState(false)

  const hint = useQuery({ queryKey: ['bootstrap'], queryFn: bootstrapHint })

  // 邀请：进页面就接受，接受完把邮箱填好——同事只要再按一下"给我登录链接"
  const invite = useQuery({
    queryKey: ['invite', inviteToken],
    enabled: inviteToken !== undefined,
    retry: false,
    queryFn: () => acceptInvitation(inviteToken ?? ''),
  })

  const ownerHint = hint.data?.owner_email
  const shared = hint.data?.login === 'shared'
  // WP427：经「团队门」从别的电脑打开的——不出设置码（NAS 主人用的），只出工坊账号 + 一句怎么进
  const team = hint.data?.team === true
  useEffect(() => {
    // 决策 945：局域网档的邀请接受完就带登录 token，直接到「进去」那一步
    if (invite.data?.login_token !== undefined) setLinkToken(invite.data.login_token)
    else if (invite.data !== undefined) setEmail(invite.data.email)
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
  // 服务端「未知邮箱」是 404：换成人话，并给两条出路
  const unknownEmail =
    ask.error instanceof ApiClientError && ask.error.status === 404 ? ask.variables : undefined

  return (
    <div className="mx-auto flex min-h-screen max-w-md flex-col justify-center p-6">
      <div className="mb-5 flex items-center justify-center gap-2.5" data-testid="login-brand">
        <BrandMark size={32} motion="idle" />
        <span className="ws-display text-base">{t('app.title')}</span>
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">
            {inviteToken === undefined ? t('login.title') : t('login.invite.title')}
          </CardTitle>
          {inviteToken === undefined && !shared ? (
            <p className="text-xs text-muted-foreground" data-testid="login-subtitle">
              {t('login.subtitle')}
            </p>
          ) : null}
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
              {t(
                invite.data?.login_token === undefined
                  ? 'login.invite.joined'
                  : 'login.invite.joinedShared',
                { workspace: invite.data?.workspace_name ?? '' },
              )}
            </p>
          )}

          {!shared ? null : inviteToken === undefined ? (
            <>
              <AccountLoginPanel onToken={setLinkToken} />
              {team ? (
                <p className="text-xs text-muted-foreground" data-testid="login-team">
                  {t('login.team')}
                </p>
              ) : (
                <div className="border-t pt-3">
                  <SharedLoginPanel onToken={setLinkToken} />
                </div>
              )}
            </>
          ) : invite.error === null ? null : (
            <p className="text-xs text-muted-foreground" data-testid="login-shared-colleague">
              {t('login.shared.colleague')}
            </p>
          )}

          {shared ? null : (
            <>
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

              {ask.error === null ? null : unknownEmail !== undefined ? (
                <div className="flex flex-col gap-1.5" data-testid="login-unknown">
                  <p role="alert" className="text-destructive">
                    {t('login.unknown', { email: unknownEmail })}
                  </p>
                  {ownerHint !== undefined && ownerHint !== unknownEmail ? (
                    <p className="flex flex-wrap items-center gap-1.5 text-muted-foreground">
                      {t('login.unknown.owner')}
                      <Button
                        variant="outline"
                        size="sm"
                        data-testid="login-use-owner"
                        onClick={() => {
                          setEmail(ownerHint)
                          ask.mutate(ownerHint)
                        }}
                      >
                        {t('login.unknown.use_owner')}
                      </Button>
                    </p>
                  ) : null}
                  <p className="text-muted-foreground">{t('login.unknown.colleague')}</p>
                </div>
              ) : (
                <p role="alert" className="text-destructive" data-testid="login-error">
                  {failure(ask.error)}
                </p>
              )}
              {mailed ? (
                <p className="text-muted-foreground" data-testid="login-mailed">
                  {t('login.mailed')}
                </p>
              ) : null}
              {inviteToken !== undefined ? null : withAccount ? (
                <div className="border-t pt-3">
                  <AccountLoginPanel
                    initialEmail={isPlaceholderOwnerEmail(email) ? '' : email.trim()}
                    onToken={setLinkToken}
                  />
                </div>
              ) : (
                <Button
                  variant="ghost"
                  size="sm"
                  className="self-start"
                  data-testid="login-with-account"
                  onClick={() => {
                    setWithAccount(true)
                  }}
                >
                  {t('login.account.open')}
                </Button>
              )}
            </>
          )}
          {linkToken === null ? null : (
            <div className="flex flex-col gap-2 rounded-md border bg-muted/40 p-3">
              <p className="text-muted-foreground">
                {t(shared ? 'login.shared.ready' : 'login.ready')}
              </p>
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
          {shared || withAccount ? null : (
            <p className="text-xs text-muted-foreground">{t('login.note')}</p>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
