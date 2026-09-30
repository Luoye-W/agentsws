/**
 * 设置 → 诊断（WP210，Luoye 09-30）。
 *
 * 失败的信以前挂在连接卡上，要人一封封点「重投」。现在系统自己按退避重投（修好之后的新版本
 * 一起来也会再投一次）；**彻底投不进的只记在这里**，客户来信另外出一张卡提醒。手动「重投」
 * 也只留在这里——平时用不着，排查时才来。
 *
 * 只有「是谁 / 何时 / 为什么 / 系统打算怎么办」，正文永远不进这一层。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Stethoscope, Undo2 } from 'lucide-react'
import { useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Hint } from '@/components/ui/hint'
import { type DeadLetterView, listDeadLetters, requeueDeadLetter } from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { formatDate, formatDateTime } from '@/lib/format'

export function DiagnosticsCard({ assignment }: { assignment: string }): React.ReactNode {
  const { t, lang } = useApp()
  const client = useQueryClient()
  const letters = useQuery({
    queryKey: ['dead-letters', assignment],
    queryFn: () => listDeadLetters(assignment),
    retry: false,
  })
  const [busy, setBusy] = useState<string | undefined>(undefined)
  const requeue = useMutation({
    mutationFn: (id: string) => requeueDeadLetter(id, assignment),
    onSettled: () => {
      setBusy(undefined)
      void client.invalidateQueries({ queryKey: ['dead-letters'] })
      void client.invalidateQueries({ queryKey: ['view'] })
    },
  })
  const rows = letters.data?.dead_letters ?? []

  /** 系统打算怎么办：下次几点再试 / 已放弃自动重试。 */
  const plan = (d: DeadLetterView): string => {
    if (d.auto_retry === undefined) return ''
    if (d.auto_retry.gave_up || d.auto_retry.next_at === undefined)
      return t('diagnostics.dead.gave_up')
    return t('diagnostics.dead.next', { at: formatDateTime(d.auto_retry.next_at, lang) })
  }

  return (
    <Card id="diagnostics" data-testid="settings-diagnostics">
      <CardHeader>
        <CardTitle className="flex items-center gap-1.5 text-sm">
          <Stethoscope className="size-4" aria-hidden />
          {t('diagnostics.title')}
          <Hint text={t('diagnostics.hint')} />
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 text-sm">
        <h4 className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          {t('diagnostics.dead.title')}
          <Hint text={t('diagnostics.dead.hint')} />
        </h4>
        {letters.isPending ? null : rows.length === 0 ? (
          <p className="text-xs text-muted-foreground" data-testid="diagnostics-dead-empty">
            {t('diagnostics.dead.empty')}
          </p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {rows.map((d) => (
              <li
                key={d.id}
                data-testid="dead-letter"
                data-dead-letter-id={d.id}
                className="flex flex-wrap items-center gap-2 rounded-md border px-2 py-1.5 text-xs"
              >
                <span className="font-medium">{d.from ?? d.channel}</span>
                {d.customer === true ? (
                  <Badge variant="outline" data-slot="badge">
                    {t('diagnostics.dead.customer')}
                  </Badge>
                ) : null}
                <span className="text-muted-foreground">{formatDate(d.at, lang)}</span>
                <span className="text-muted-foreground" data-slot="status">
                  {plan(d)}
                </span>
                <Hint
                  text={[d.reason, d.last_error ?? ''].filter((x) => x !== '').join('：')}
                  testId="dead-letter-why"
                />
                <Button
                  size="xs"
                  variant="outline"
                  className="ml-auto"
                  disabled={busy !== undefined}
                  onClick={() => {
                    setBusy(d.id)
                    requeue.mutate(d.id)
                  }}
                >
                  <Undo2 aria-hidden />
                  {busy === d.id ? t('connections.requeuing') : t('connections.requeue')}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}
