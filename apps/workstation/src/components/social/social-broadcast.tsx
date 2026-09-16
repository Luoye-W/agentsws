/**
 * WP73（56 §6 第五项）：**群发向导**（社群组五条职责的岗位页上那一块）。
 *
 * 三步一屏：① 发到哪个群 → ② 发给谁 → ③ 写什么。按下最后那个按钮之后
 * 服务端算受众、剔抑制名单、过承诺扫描，然后出一张**永远要人点头**的群发卡。
 *
 * 四条界面纪律：
 *
 * 1. **数是服务端算的**。"342 人收，剔了 18 个"那一句来自
 *    `SocialBroadcastView.note`（`social-core` 的 `buildAudience`）——界面
 *    不自己数一遍，否则迟早与卡面上那句话对不上。
 * 2. **拦下来就照实显示**。承诺词、WhatsApp 少模板名 / 没核过 opt-in，
 *    这几条服务端当场拦；这里把那几句原样摆出来，**不弹红框**——
 *    被拦下来是正常结果之一。
 * 3. **"永远要人点头"写在按钮旁边**，不是点完之后才出现。
 * 4. **WhatsApp 的两道闸摆在明处**：选到那条渠道就多出模板名与 opt-in 两格，
 *    并且说清为什么（违了封的是这个品牌的号）。
 */
import { useMutation, useQuery } from '@tanstack/react-query'
import { Megaphone, ShieldAlert } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import {
  createSocialBroadcast,
  getSocialAccounts,
  type SocialBroadcastData,
  type SocialChannelId,
} from '@/lib/api'
import { useApp } from '@/lib/app-context'

type Audience = 'all' | 'tagged' | 'active_30d'

const AUDIENCES: Audience[] = ['all', 'tagged', 'active_30d']

export function SocialBroadcast({
  assignment,
  channel,
}: {
  assignment: string
  channel: SocialChannelId
}): React.ReactNode {
  const { t } = useApp()
  const [audience, setAudience] = useState<Audience>('all')
  const [tag, setTag] = useState('')
  const [body, setBody] = useState('')
  const [template, setTemplate] = useState('')
  const [optIn, setOptIn] = useState(false)
  const [result, setResult] = useState<SocialBroadcastData | undefined>(undefined)

  const accounts = useQuery({
    queryKey: ['social-accounts', assignment, channel],
    queryFn: () => getSocialAccounts({ channel }, assignment),
  })
  const rows = accounts.data?.rows ?? []
  const account_id = rows[0]?.id

  const send = useMutation({
    mutationFn: () =>
      createSocialBroadcast(
        {
          account_id: account_id as string,
          body,
          audience,
          ...(audience === 'tagged' ? { tag } : {}),
          ...(channel === 'whatsapp' ? { template_id: template, opt_in_verified: optIn } : {}),
        },
        assignment,
      ),
    onSuccess: setResult,
  })

  return (
    <Card data-testid="social-broadcast">
      <CardHeader>
        <CardTitle className="flex items-center gap-1.5 text-sm">
          <Megaphone className="size-4" aria-hidden />
          {t('social.broadcast.title')}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        {account_id === undefined ? (
          // 36 §3：没有群就说没有群，不画一个点不动的向导
          <p className="text-xs text-muted-foreground" data-testid="social-broadcast-no-account">
            {t('social.broadcast.no_account')}
          </p>
        ) : (
          <>
            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">
                {t('social.broadcast.step.channel')}
              </span>
              <span data-testid="social-broadcast-account">{rows[0]?.display_name}</span>
            </div>

            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">
                {t('social.broadcast.step.audience')}
              </span>
              <div className="flex flex-wrap items-center gap-1">
                {AUDIENCES.map((a) => (
                  <Button
                    key={a}
                    size="xs"
                    variant={audience === a ? 'secondary' : 'ghost'}
                    aria-pressed={audience === a}
                    data-testid={`social-broadcast-audience-${a}`}
                    onClick={() => {
                      setAudience(a)
                    }}
                  >
                    {t(`social.broadcast.audience.${a}`)}
                  </Button>
                ))}
              </div>
              {audience === 'tagged' ? (
                <Input
                  value={tag}
                  placeholder={t('social.broadcast.tag.placeholder')}
                  onChange={(e) => {
                    setTag(e.target.value)
                  }}
                />
              ) : null}
            </div>

            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">
                {t('social.broadcast.step.copy')}
              </span>
              <Textarea
                rows={3}
                value={body}
                placeholder={t('social.broadcast.copy.placeholder')}
                onChange={(e) => {
                  setBody(e.target.value)
                }}
              />
            </div>

            {/* 纪律 4：WhatsApp 的两道闸摆在明处 */}
            {channel === 'whatsapp' ? (
              <div className="flex flex-col gap-1 rounded border border-amber-500/40 bg-amber-500/5 p-2">
                <p className="flex items-start gap-1 text-xs text-muted-foreground">
                  <ShieldAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                  {t('social.broadcast.whatsapp_note')}
                </p>
                <Input
                  value={template}
                  placeholder={t('social.broadcast.template.placeholder')}
                  onChange={(e) => {
                    setTemplate(e.target.value)
                  }}
                />
                <label className="flex items-center gap-1.5 text-xs">
                  <input
                    type="checkbox"
                    checked={optIn}
                    data-testid="social-broadcast-optin"
                    onChange={(e) => {
                      setOptIn(e.target.checked)
                    }}
                  />
                  {t('social.broadcast.opt_in')}
                </label>
              </div>
            ) : null}

            <div className="flex items-center gap-2">
              <Button
                size="sm"
                disabled={body.trim() === '' || send.isPending}
                data-testid="social-broadcast-submit"
                onClick={() => {
                  send.mutate()
                }}
              >
                {t('social.broadcast.submit')}
              </Button>
              {/* 纪律 3：这句话在按钮旁边，不在点完之后才出现 */}
              <span className="text-xs text-muted-foreground">
                {t('social.broadcast.always_l1')}
              </span>
            </div>

            {result === undefined ? null : (
              <div
                className="flex flex-col gap-1 rounded border p-2"
                data-testid="social-broadcast-result"
              >
                {/* 纪律 1：这一句原样来自服务端 */}
                <p>{result.note}</p>
                {/* 纪律 2：被拦下来就照实摆出来 */}
                {result.problems.map((p) => (
                  <p key={p} className="text-xs text-destructive">
                    {p}
                  </p>
                ))}
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}
