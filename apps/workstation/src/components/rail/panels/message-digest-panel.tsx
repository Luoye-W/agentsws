/**
 * WP441（docs/108 §5.6，M7）：消息页右栏「今天的简报」——命中「进今天的简报」的信攒在这里，按规则分组、
 * 每封一行摘要；「全部知道了」一键标完。每天到点（默认本地 9:00，规则清单「系统规则」里能改）铃铛来一条
 * 「消息简报：今天 N 封」指过来，0 封不发。不发邮件、不推到外部。
 *
 * 消息页主体（WP459 分拣台）顶上那张简报卡以后用同一份数据；这里只是右栏那一格。
 */
import type { MessageDigest } from '@agentsws/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CheckCheck } from 'lucide-react'
import type { ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { PanelError } from '@/components/rail/panel-error'
import { Button } from '@/components/ui/button'
import { Hint } from '@/components/ui/hint'
import { Skeleton } from '@/components/ui/skeleton'
import { ackMessageDigest, getMessageDigest } from '@/lib/api'
import { useApp } from '@/lib/app-context'

export const DIGEST_QUERY_KEY = ['messages', 'digest'] as const

export function MessageDigestPanel(): ReactNode {
  const { t } = useApp()
  const client = useQueryClient()
  const navigate = useNavigate()
  const digest = useQuery({ queryKey: DIGEST_QUERY_KEY, queryFn: getMessageDigest })
  const ack = useMutation({
    mutationFn: () => ackMessageDigest(),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: DIGEST_QUERY_KEY })
    },
  })
  if (digest.isPending) return <Skeleton className="m-3 h-40" />
  if (digest.error !== null) return <PanelError error={digest.error} />
  const data: MessageDigest = digest.data
  return (
    <div className="flex flex-col gap-3 p-3" data-testid="message-digest-panel">
      <div className="flex items-center gap-1.5 text-[12px] text-ws-muted-fg">
        <span className="ws-num" data-testid="message-digest-total" data-total={data.total}>
          {t('message_digest.total', { n: data.total })}
        </span>
        <Hint text={t('message_digest.hint', { time: data.time })} />
      </div>
      {data.total === 0 ? (
        <p className="text-[12px] text-ws-muted-fg" data-testid="message-digest-empty">
          {t('message_digest.empty')}
        </p>
      ) : (
        <>
          {data.groups.map((g) => (
            <section
              key={g.rule_id}
              className="flex flex-col gap-1.5"
              data-testid="message-digest-group"
            >
              <h3 className="flex items-center gap-1.5 text-[12px] font-medium text-ws-muted-fg">
                {g.rule_name}
                <span className="ws-num">{g.entries.length}</span>
              </h3>
              <ul className="flex flex-col divide-y divide-ws-line rounded-[12px] border border-ws-line bg-ws-card">
                {g.entries.map((e) => (
                  <li key={e.message_id}>
                    <button
                      type="button"
                      data-testid="message-digest-entry"
                      className="flex w-full min-w-0 flex-col gap-0.5 px-3 py-2 text-left hover:bg-ws-surface"
                      onClick={() => {
                        navigate(`/messages?view=all&thread=${encodeURIComponent(e.thread_id)}`)
                      }}
                    >
                      <span className="flex min-w-0 items-baseline gap-1.5 text-[13px]">
                        <span className="shrink-0 font-medium">{e.from}</span>
                        <span className="min-w-0 truncate">{e.summary}</span>
                      </span>
                      <span className="truncate text-[12px] text-ws-muted-fg">{e.subject}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
          <Button
            size="sm"
            variant="outline"
            data-testid="message-digest-ack"
            disabled={ack.isPending}
            onClick={() => {
              ack.mutate()
            }}
          >
            <CheckCheck aria-hidden />
            {t('message_digest.ack')}
          </Button>
        </>
      )}
    </div>
  )
}
