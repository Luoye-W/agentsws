/**
 * 等你点头的「约时间」（41 §1.2）。
 *
 * 同一件事在首页队列里也有一张卡（`claim` 形态），那张卡是**通知**；真正的点头在这里，
 * 因为答它要挑一个时段、要在回绝时把替代时段带回去——这两件事不是一个"批准"按钮能表达的。
 *
 * **对方点头才进双方日历**：在这之前谁的日历上都不会多出这场会。
 */
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { decideMeet, type MeetProposalView } from '@/lib/api'
import { useApp } from '@/lib/app-context'

const when = (iso: string): string => {
  const d = new Date(iso)
  return `${d.getMonth() + 1}月${d.getDate()}日 ${`${d.getHours()}`.padStart(2, '0')}:${`${d.getMinutes()}`.padStart(2, '0')}`
}

export function MeetInbox({ meets }: { meets: MeetProposalView[] }): React.ReactNode {
  const { t } = useApp()
  const client = useQueryClient()

  const decide = useMutation({
    mutationFn: (input: {
      id: string
      decision: { action: 'accept'; slot?: { start: string; end: string } } | { action: 'decline' }
    }) => decideMeet(input.id, input.decision),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: ['secretary', 'meets'] })
      void client.invalidateQueries({ queryKey: ['calendar'] })
      void client.invalidateQueries({ queryKey: ['home'] })
    },
  })

  if (meets.length === 0)
    return <p className="text-muted-foreground text-sm">{t('secretary.meets.empty')}</p>

  return (
    <div className="flex flex-col gap-3" data-testid="meet-inbox">
      {meets.map((m) => (
        <Card key={m.id} data-testid="meet-card" data-state={m.state}>
          <CardHeader>
            <CardTitle className="text-sm">
              {t('secretary.meets.from', { who: m.from_label ?? m.from })}：{m.title}
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2 text-sm">
            <div className="flex flex-wrap gap-2">
              {m.candidates.map((slot) => (
                <span key={slot.start} className="rounded-md border px-2 py-0.5 text-xs">
                  {when(slot.start)}（{m.duration_minutes} 分钟）
                </span>
              ))}
            </div>
            {m.state === 'proposed' ? (
              <div className="flex gap-2">
                {m.candidates.map((slot) => (
                  <Button
                    key={slot.start}
                    size="sm"
                    data-testid="meet-accept"
                    disabled={decide.isPending}
                    onClick={() => {
                      decide.mutate({ id: m.id, decision: { action: 'accept', slot } })
                    }}
                  >
                    {t('secretary.meets.accept')}
                  </Button>
                ))}
                <Button
                  size="sm"
                  variant="ghost"
                  data-testid="meet-decline"
                  disabled={decide.isPending}
                  onClick={() => {
                    decide.mutate({ id: m.id, decision: { action: 'decline' } })
                  }}
                >
                  {t('secretary.meets.decline')}
                </Button>
              </div>
            ) : (
              <span className="text-muted-foreground text-xs">
                {m.state === 'accepted'
                  ? t('secretary.meets.accepted')
                  : t('secretary.meets.declined')}
              </span>
            )}
            {m.alternatives.length === 0 ? null : (
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span>{t('secretary.meets.alternatives')}</span>
                {m.alternatives.map((slot) => (
                  <span key={slot.start} className="rounded border px-1.5 py-0.5">
                    {when(slot.start)}
                  </span>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  )
}
