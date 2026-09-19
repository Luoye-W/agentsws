/**
 * WP117 交付 4（界面那一半）：**演练开关 + 状态带**。
 *
 * 三条界面纪律：
 *
 * 1. **状态带的字是服务端给的**（`banner`）。界面不自己拼一句"演练中"——
 *    拦不拦信是服务端说了算，那句话就该由说了算的那一方出。两边各拼一句，
 *    早晚会出现"界面说在演练、服务端其实在真发"的那一天。
 * 2. **开关不是保险**。开着演练也照样能干真活（真红人一条不受影响），
 *    所以这条带子说的是"演练活动里不会发出真邮件"，不是"现在全局安全"。
 * 3. **清空要确认**。演练数据是造出来的，可它也是用户刚玩了半小时的东西。
 *    点一下就没了不行，两段式（点一次变成「真的清空？」）。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { FastForward, FlaskConical, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import {
  advanceKolSandbox,
  clearKolSandbox,
  getKolSandbox,
  type KolChannelId,
  startKolSandbox,
} from '@/lib/api'
import { errorText, KolError, KolReceipt } from './kol-shared'

/** 跳几天的三档。3 / 7 对应跟进序列的两档，30 是"看看一个月后长什么样"。 */
const JUMPS: readonly number[] = [3, 7, 30]

export function KolSandboxBar({
  assignment,
  channel,
}: {
  assignment: string
  channel: KolChannelId
}): React.ReactNode {
  const client = useQueryClient()
  const [error, setError] = useState<string | undefined>(undefined)
  const [receipt, setReceipt] = useState<string | undefined>(undefined)
  const [confirming, setConfirming] = useState(false)

  const status = useQuery({
    queryKey: ['kol-sandbox', assignment],
    queryFn: () => getKolSandbox(assignment),
  })

  /** 演练动了库，红人 / 合作两份清单都要重取。 */
  const refresh = (): void => {
    void client.invalidateQueries({ queryKey: ['kol-sandbox'] })
    void client.invalidateQueries({ queryKey: ['kol-creators'] })
    void client.invalidateQueries({ queryKey: ['kol-collaborations'] })
  }

  const toggle = useMutation({
    mutationFn: (on: boolean) =>
      on ? startKolSandbox(channel, assignment) : clearKolSandbox(assignment),
    onSuccess: (data) => {
      setError(undefined)
      setConfirming(false)
      setReceipt(
        data.on
          ? `演练开了：库里放了 ${data.creators} 个合成红人，每人一条合作。发信照真路子走，只是发不出去。`
          : '演练数据清空了。真红人、真合作一条没动。',
      )
      refresh()
    },
    onError: (e: unknown) => {
      setReceipt(undefined)
      setError(errorText(e, '演练开关没拨动，这一步没成。'))
    },
  })

  const jump = useMutation({
    mutationFn: (days: number) => advanceKolSandbox(days, assignment),
    onSuccess: (data) => {
      setError(undefined)
      const bounced = data.received.filter((r) => r.bounce_reason !== undefined).length
      setReceipt(
        data.received.length === 0
          ? `跳到 ${data.advanced_days} 天后：这一段没有人回信。${data.pending > 0 ? `还有 ${data.pending} 封在路上。` : '发过信的人里没有会回的——再发几封试试。'}`
          : `跳到 ${data.advanced_days} 天后：收到 ${data.received.length} 封回信${bounced > 0 ? `（其中 ${bounced} 封是退信）` : ''}，合作线程已经跟着动了。`,
      )
      refresh()
    },
    onError: (e: unknown) => {
      setReceipt(undefined)
      setError(errorText(e, '时间没跳成，这一步没生效。'))
    },
  })

  const on = status.data?.on === true
  const busy = toggle.isPending || jump.isPending

  return (
    <div className="flex flex-col gap-2" data-testid="kol-sandbox-bar" data-on={String(on)}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-sm font-medium">
          <FlaskConical className="size-4" aria-hidden />
          <label htmlFor="kol-sandbox-toggle">演练</label>
          <Switch
            id="kol-sandbox-toggle"
            checked={on}
            disabled={busy || status.isPending}
            data-testid="kol-sandbox-toggle"
            aria-label="演练模式"
            onCheckedChange={(next) => {
              // 关掉 = 清空数据，所以走两段式；开着不用确认
              if (!next) {
                setConfirming(true)
                return
              }
              toggle.mutate(true)
            }}
          />
        </span>
        {on ? (
          <span className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
            <FastForward className="size-3" aria-hidden />
            跳到
            {JUMPS.map((days) => (
              <Button
                key={days}
                size="xs"
                variant="outline"
                data-testid="kol-sandbox-jump"
                data-days={days}
                disabled={busy}
                onClick={() => {
                  jump.mutate(days)
                }}
              >
                {days} 天后
              </Button>
            ))}
          </span>
        ) : null}
      </div>

      {/*
        顶上那条明显的状态带。**只在演练开着的时候出现**——常驻一条"没在演练"
        的带子等于教用户忽略它。
      */}
      {on ? (
        <div
          className="flex flex-wrap items-center justify-between gap-2 rounded-[var(--ws-radius-card)] border border-[var(--ws-warn)] bg-[var(--ws-warn-bg)] px-3 py-2"
          data-testid="kol-sandbox-banner"
          role="status"
        >
          <span className="text-sm font-medium text-[var(--ws-ink)]">{status.data?.banner}</span>
          <span className="text-xs text-muted-foreground" data-testid="kol-sandbox-counts">
            合成红人 {status.data?.creators ?? 0} · 已发 {status.data?.sent ?? 0} · 回信{' '}
            {status.data?.replies ?? 0} · 在路上 {status.data?.pending ?? 0} · 演练世界现在是{' '}
            {(status.data?.now ?? '').slice(0, 10)}
          </span>
        </div>
      ) : null}

      {confirming ? (
        <div
          className="flex flex-wrap items-center gap-2 text-xs"
          data-testid="kol-sandbox-confirm"
        >
          <span>清空演练数据？这一批合成红人与他们的合作会被删掉（真数据不碰）。</span>
          <Button
            size="xs"
            variant="destructive"
            data-testid="kol-sandbox-clear"
            disabled={busy}
            onClick={() => {
              toggle.mutate(false)
            }}
          >
            <Trash2 className="size-3" aria-hidden />
            真的清空
          </Button>
          <Button
            size="xs"
            variant="ghost"
            onClick={() => {
              setConfirming(false)
            }}
          >
            算了
          </Button>
        </div>
      ) : null}

      <KolError error={error} testid="kol-sandbox-error" />
      <KolReceipt text={receipt} testid="kol-sandbox-receipt" />
    </div>
  )
}
