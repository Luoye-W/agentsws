/**
 * 「账号与积分」上半张卡：关联 agentsws 云账号（49 M1 / M5）。
 *
 * 两个状态，各一句人话：
 *
 * - **没关联**：一句"关联之后能一键用 agentsws 的模型和数据服务（按积分）" +
 *   邮箱框 + 「发登录邮件」。按完不跳转、不弹窗——只提示"去邮箱点那条链接"，
 *   因为真正的下一步发生在用户的邮箱里，不在这一页。
 * - **已关联**：邮箱、令牌到期、动作集、「解除关联」。
 *
 * 这一页**永远看不到令牌**：服务端的 `GET /v1/cloud/account` 就不回它
 * （令牌在本机加密库里，21 §5）。所以这个文件里没有一处 token 变量。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Cloud } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import {
  ApiClientError,
  type CloudAccountView,
  getCloudAccount,
  linkCloudAccount,
  unlinkCloudAccount,
} from '@/lib/api'
import { useApp } from '@/lib/app-context'

/** ISO → `2026-12-14`（到期只看到天，不必精确到秒）。 */
function day(iso: string | undefined): string {
  if (iso === undefined || iso === '') return '—'
  const at = Date.parse(iso)
  return Number.isNaN(at) ? '—' : new Date(at).toISOString().slice(0, 10)
}

export function CloudAccountCard({ assignment }: { assignment?: string }): React.ReactNode {
  const { t } = useApp()
  const client = useQueryClient()
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const account = useQuery({
    queryKey: ['cloud-account', assignment],
    queryFn: () => getCloudAccount(assignment),
    retry: false,
    // WP140：信发出去之后每隔几秒问一次（与向导第 ① 步同一个口径），点开了就停
    refetchInterval: (q) => (sent && q.state.data?.linked !== true ? 3000 : false),
  })

  /*
   * WP140：关联一成，下半张「积分」卡那几份（余额 / 用量 / 价目 / 充值档）当场重取——
   * 它们是关联之前取的，还写着「还没关联」。
   */
  const linkedNow = account.data?.linked === true
  useEffect(() => {
    if (!linkedNow) return
    setSent(false)
    for (const key of ['cloud-credits', 'cloud-usage', 'cloud-pricing', 'cloud-topup-tiers'])
      void client.invalidateQueries({ queryKey: [key] })
  }, [linkedNow, client])

  const link = useMutation({
    mutationFn: (value: string) => linkCloudAccount(value, assignment),
    onSuccess: () => {
      setError(null)
      setSent(true)
    },
    onError: (err: unknown) => {
      setSent(false)
      setError(err instanceof ApiClientError ? err.message : t('error.generic'))
    },
  })

  const unlink = useMutation({
    mutationFn: () => unlinkCloudAccount(assignment),
    onSuccess: async (result) => {
      setError(result.reason ?? null)
      setSent(false)
      await client.invalidateQueries({ queryKey: ['cloud-account'] })
    },
    onError: (err: unknown) => {
      setError(err instanceof ApiClientError ? err.message : t('error.generic'))
    },
  })

  const view: CloudAccountView | undefined = account.data

  return (
    <Card data-testid="cloud-account">
      <CardHeader>
        <CardTitle className="flex items-center gap-1.5 text-sm">
          <Cloud className="size-4" />
          {t('cloud.account.title')}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        {account.isLoading ? <Skeleton className="h-16 w-full" /> : null}
        {view === undefined ? null : view.linked ? (
          <div className="flex flex-col gap-3" data-testid="cloud-account-linked">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">{t('cloud.account.email')}</span>
              <span className="font-mono text-xs">{view.email}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">{t('cloud.account.expires')}</span>
              <span className="font-mono text-xs">{day(view.expires_at)}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">{t('cloud.account.scopes')}</span>
              <span className="font-mono text-xs">{(view.scopes ?? []).join(' · ')}</span>
            </div>
            <div>
              <Button
                size="sm"
                variant="outline"
                disabled={unlink.isPending}
                onClick={() => {
                  unlink.mutate()
                }}
              >
                {t('cloud.account.unlink')}
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-3" data-testid="cloud-account-unlinked">
            <p className="text-muted-foreground">{t('cloud.account.intro')}</p>
            <div className="flex items-center gap-2">
              <Input
                type="email"
                aria-label={t('cloud.account.email')}
                placeholder={t('cloud.account.email.placeholder')}
                value={email}
                disabled={view.blocked_reason !== undefined}
                onChange={(e) => {
                  setEmail(e.target.value)
                  setSent(false)
                }}
              />
              <Button
                size="sm"
                disabled={
                  link.isPending || email.trim() === '' || view.blocked_reason !== undefined
                }
                onClick={() => {
                  link.mutate(email.trim())
                }}
              >
                {t('cloud.account.send')}
              </Button>
            </div>
            {sent ? (
              <p className="text-muted-foreground" data-testid="cloud-account-sent">
                {t('cloud.account.sent')}
              </p>
            ) : null}
            {view.blocked_reason === undefined ? null : (
              <p className="text-muted-foreground">{view.blocked_reason}</p>
            )}
          </div>
        )}
        {error === null ? null : (
          <p className="text-destructive" data-testid="cloud-account-error">
            {error}
          </p>
        )}
        {view === undefined ? null : (
          <p className="text-xs text-muted-foreground">
            {t('cloud.account.endpoint')} <span className="font-mono">{view.cloud_base_url}</span>
          </p>
        )}
      </CardContent>
    </Card>
  )
}
