/**
 * 聊天窗设置页「转发方式」第三项：**客服增值服务——云端替你值守**（WP128）。
 *
 * 商家要回答的只有一件事：「我关电脑的时候，聊天窗还有没有人接？」所以这一块
 * 只画四样东西：
 *
 * 1. 一句结论：没开 / **云端替你值守中** / 正在起来 / 暂时没在跑 / 欠费宽限中；
 * 2. 最近一次心跳（「3 分钟前还在」比「running」这种词有用）；
 * 3. 一个动作按钮：开通（30 积分 / 月）或取消（当期用完为止）；
 * 4. 两个同步按钮：用本机这一份更新云端 / 把云端那一份取回来（落备份目录）。
 *
 * 没有容器、镜像、规格这些词——那是运营后台的事（docs/36：用户是非开发者）。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { StatusPill } from '@/components/design'
import type { Tone } from '@/components/design/tone'
import { Button } from '@/components/ui/button'
import {
  bringHomeChatRelayHosted,
  type ChatRelayHostedView,
  cancelChatRelayHosted,
  getChatRelayHosted,
  seedChatRelayHosted,
  subscribeChatRelayHosted,
} from '@/lib/api'
import { useApp } from '@/lib/app-context'

/** 一句结论 + 颜色。 */
export function hostedVerdict(view: ChatRelayHostedView | undefined): { key: string; tone: Tone } {
  if (view === undefined || !view.available || !view.linked)
    return { key: 'chat.window.hosted.off', tone: 'neutral' }
  const status = view.subscription.status
  if (status === 'none' || status === 'suspended')
    return {
      key: status === 'suspended' ? 'chat.window.hosted.suspended' : 'chat.window.hosted.off',
      tone: status === 'suspended' ? 'bad' : 'neutral',
    }
  const state = view.hosted?.state
  if (status === 'grace') return { key: 'chat.window.hosted.grace', tone: 'warn' }
  if (state === 'running') return { key: 'chat.window.hosted.on', tone: 'good' }
  if (state === 'starting') return { key: 'chat.window.hosted.starting', tone: 'info' }
  return { key: 'chat.window.hosted.sleeping', tone: 'warn' }
}

/** 「3 分钟前」这种说法（给心跳用；精确到分钟就够了）。 */
function minutesAgo(at: string | undefined, now: number): number | undefined {
  if (at === undefined) return undefined
  return Math.max(0, Math.round((now - Date.parse(at)) / 60_000))
}

export function HostedRelayOption(): React.ReactNode {
  const { t } = useApp()
  const client = useQueryClient()
  const [note, setNote] = useState<string | undefined>(undefined)
  const hosted = useQuery({
    queryKey: ['chat-widget', 'hosted'],
    queryFn: getChatRelayHosted,
    // 心跳 3 分钟一拍，页面上一分钟刷一次就够
    refetchInterval: 60_000,
  })
  const refresh = async (): Promise<void> => {
    await client.invalidateQueries({ queryKey: ['chat-widget'] })
  }
  const toggle = useMutation({
    mutationFn: (on: boolean) => (on ? subscribeChatRelayHosted() : cancelChatRelayHosted()),
    onSuccess: async (view) => {
      setNote(view.message)
      await refresh()
    },
  })
  const seed = useMutation({
    mutationFn: seedChatRelayHosted,
    onSuccess: (out) => setNote(out.message),
  })
  const bringHome = useMutation({
    mutationFn: bringHomeChatRelayHosted,
    onSuccess: (out) => setNote(out.message),
  })

  const view = hosted.data
  const verdict = hostedVerdict(view)
  const status = view?.subscription.status ?? 'none'
  const subscribed = status === 'active' || status === 'cancelling' || status === 'grace'
  const ago = minutesAgo(view?.hosted?.last_heartbeat_at, Date.now())

  return (
    <div className="flex flex-col gap-2 rounded-md border p-2" data-testid="relay-hosted">
      <div className="flex items-center justify-between gap-2">
        <p className="font-medium">{t('chat.window.hosted.title')}</p>
        <StatusPill tone={verdict.tone} data-testid="relay-hosted-verdict">
          {t(verdict.key)}
        </StatusPill>
      </div>
      <p className="text-xs text-muted-foreground">{t('chat.window.hosted.hint')}</p>
      {ago !== undefined && subscribed ? (
        <p className="text-xs text-muted-foreground" data-testid="relay-hosted-heartbeat">
          {t('chat.window.hosted.heartbeat', { n: String(ago) })}
        </p>
      ) : null}
      {status === 'cancelling' && view?.subscription.current_cycle_end !== undefined ? (
        <p className="text-xs text-muted-foreground">
          {t('chat.window.hosted.cancelling', {
            date: view.subscription.current_cycle_end.slice(0, 10),
          })}
        </p>
      ) : null}
      {view?.message !== undefined ? (
        <p className="text-xs text-muted-foreground" data-testid="relay-hosted-message">
          {view.message}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        {view?.available === true && view.linked ? (
          status === 'active' || status === 'grace' ? (
            <Button
              size="sm"
              variant="outline"
              data-testid="relay-hosted-cancel"
              disabled={toggle.isPending}
              onClick={() => toggle.mutate(false)}
            >
              {t('chat.window.hosted.cancel')}
            </Button>
          ) : (
            <Button
              size="sm"
              data-testid="relay-hosted-subscribe"
              disabled={toggle.isPending}
              onClick={() => toggle.mutate(true)}
            >
              {t('chat.window.hosted.subscribe')}
            </Button>
          )
        ) : null}
        {subscribed ? (
          <>
            <Button
              size="sm"
              variant="secondary"
              data-testid="relay-hosted-seed"
              disabled={seed.isPending}
              onClick={() => seed.mutate()}
            >
              {t('chat.window.hosted.seed')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              data-testid="relay-hosted-bring-home"
              disabled={bringHome.isPending}
              onClick={() => bringHome.mutate()}
            >
              {t('chat.window.hosted.bring_home')}
            </Button>
          </>
        ) : null}
      </div>
      {note !== undefined ? (
        <p className="text-xs text-muted-foreground" data-testid="relay-hosted-note">
          {note}
        </p>
      ) : null}
    </div>
  )
}
