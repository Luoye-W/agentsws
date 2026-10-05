/**
 * 「账号与积分」上半张卡：关联 agentsws 云账号（49 M1 / M5）。
 *
 * 两个状态，各一句人话：
 *
 * - **没关联**：一句"关联之后能一键用 agentsws 的模型和数据服务（按积分）" +
 *   WP231 的注册 / 登录表单（`CloudAuthForm`，与向导第 ① 步同一个件）：注册新账号（默认）/
 *   已有账号登录（邮箱验证码或密码）。验过就关联上，不跳转、不弹窗。
 * - **已关联**：邮箱、令牌到期、动作集、「解除关联」。
 *
 * 这一页**永远看不到令牌**：服务端的 `GET /v1/cloud/account` 就不回它
 * （令牌在本机加密库里，21 §5）。所以这个文件里没有一处 token 变量。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { CloudAuthForm } from '@/components/cloud/cloud-auth-form'
import { BrandMark, StatusIcons } from '@/components/design'
import { TutorialLink } from '@/components/help/tutorial-link'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Hint } from '@/components/ui/hint'
import { Skeleton } from '@/components/ui/skeleton'
import {
  ApiClientError,
  type CloudAccountView,
  getCloudAccount,
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
  const [error, setError] = useState<string | null>(null)

  const account = useQuery({
    queryKey: ['cloud-account', assignment],
    queryFn: () => getCloudAccount(assignment),
    retry: false,
  })

  /*
   * WP140：关联一成，下半张「积分」卡那几份（余额 / 用量 / 价目 / 充值档）当场重取——
   * 它们是关联之前取的，还写着「还没关联」。
   */
  const linkedNow = account.data?.linked === true
  /*
   * WP142：**解除关联也要重取**——下半张积分卡解除之后得换成「没关联」那一面
   * （价目三块、充值四档照常在，按钮换成「先关联」），不能还摆着已关联时的余额。
   * 只在状态真的变了时重取（第一次取到不算变）。
   */
  const seen = useRef<boolean | undefined>(undefined)
  useEffect(() => {
    if (account.data === undefined) return
    const before = seen.current
    seen.current = linkedNow
    if (before === undefined && !linkedNow) return
    if (before === linkedNow) return
    for (const key of [
      'cloud-credits',
      'cloud-usage',
      'cloud-pricing',
      'cloud-topup-tiers',
      'kol-cloud-status',
    ])
      void client.invalidateQueries({ queryKey: [key] })
  }, [linkedNow, account.data, client])

  const unlink = useMutation({
    mutationFn: () => unlinkCloudAccount(assignment),
    onSuccess: async (result) => {
      setError(result.reason ?? null)
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
        <CardTitle className="flex items-center gap-2 text-sm">
          {/* WP195：关联的就是「Agents 工坊」账号，图标换成待机的品牌标记（原来是一朵云） */}
          <BrandMark size={24} motion="idle" />
          {t('cloud.account.title')}
          <TutorialLink slug="agentsws-credits" className="ml-auto font-normal" />
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        {account.isLoading ? <Skeleton className="h-16 w-full" /> : null}
        {view === undefined ? null : view.linked ? (
          <div className="flex flex-col gap-3" data-testid="cloud-account-linked">
            {/*
              WP214（36 §7 第四档）：「邮箱 / 令牌到期 / 这把令牌能做」三行 → 一个「已关联」小图标 + 邮箱；
              到期、权限、连到的云端地址都在 tooltip 里（技术信息不常显）
            */}
            <StatusIcons
              testId="cloud-account-status"
              items={[
                {
                  key: 'linked',
                  label: t('cloud.account.title'),
                  state: 'ok',
                  stateText: t('cloud.account.linked'),
                  icon: Link2,
                  ...(view.email === undefined ? {} : { value: view.email }),
                  testId: 'cloud-account-email',
                  detail: [
                    `${t('cloud.account.expires')} ${day(view.expires_at)}`,
                    `${t('cloud.account.scopes')} ${(view.scopes ?? []).join(' · ')}`,
                    `${t('cloud.account.endpoint')} ${view.cloud_base_url}`,
                  ].join('\n'),
                },
              ]}
            />
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
            {/* WP156：一句话留着，"不关联也照常用、一分不扣"那半句进问号 */}
            <p className="flex items-center gap-1 text-muted-foreground">
              {t('cloud.account.intro')}
              <Hint
                text={`${t('cloud.account.intro.hint')} ${t('cloud.account.endpoint')} ${view.cloud_base_url}`}
              />
            </p>
            <CloudAuthForm
              {...(assignment === undefined ? {} : { assignment })}
              testPrefix="cloud-account"
              disabled={view.blocked_reason !== undefined}
              onDone={() => {
                setError(null)
                void client.invalidateQueries({ queryKey: ['cloud-account'] })
              }}
            />
            {view.blocked_reason === undefined ? null : (
              <p className="text-muted-foreground" data-slot="status">
                {view.blocked_reason}
              </p>
            )}
          </div>
        )}
        {error === null ? null : (
          <p className="text-destructive" data-testid="cloud-account-error">
            {error}
          </p>
        )}
        {/* WP214：「连到：云端地址」是技术信息——关联了在状态图标的 tooltip 里，没关联在那句话的问号里 */}
      </CardContent>
    </Card>
  )
}
