/**
 * WP332（决策 762）：社媒岗位页「没发出去」提醒条——Reddit（插件「填好等人点」）那一条没发出去时出一行：
 * 哪一条 + 照实一句原因 +「再填一次」（同一份已批的草稿再交给插件，不用重批）+ 收起。
 *
 * 出现规则（docs/96 提醒条）：只在出问题时出；同一条写只一行（再填一次不另起一行）；人收起了不再出，
 * 再填又没发出去会重新出；七天前的不出（进度里还在）。正常时一个字都不画。
 *
 * WP432：批过、等你在浏览器插件里发的，顶上一行（插件不自己开页面）；
 * 浏览器里的插件不是新版 / 这几分钟没看到它，就地出「插件要重新加载一下」。
 * WP445（决策 1322）：AI 起草的 Reddit 回帖 / 发帖不在工坊出卡——这一行是「插件里 N 条等你发」（还没审的 + 主管批过的），
 * 点了提示去浏览器插件里发；不是卡。
 */

import { redditWriteNotices } from '@agentsws/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { RotateCcw, SendHorizontal, X } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { ExtensionReloadPrompt } from '@/components/connections/extension-reload'
import { NoticeLine } from '@/components/design/kit'
import { Button } from '@/components/ui/button'
import { Hint } from '@/components/ui/hint'
import { useApp } from '@/lib/app-context'
import {
  dismissRedditWrite,
  listRedditWrites,
  REDDIT_WRITES_KEY,
  type RedditWriteView,
  refillRedditWrite,
} from '@/lib/reddit-write-api'

/** 用哪一条社媒职责的分配去问（担 Reddit 的那条优先）。 */
export function redditWriteAssignment(
  duties: readonly { role_id: string; assignment_id: string }[],
): string | undefined {
  return (
    duties.find((d) => d.role_id === 'social.reddit') ??
    duties.find((d) => d.role_id.startsWith('social.'))
  )?.assignment_id
}

/** 最多出几行（再多的进度里看）。 */
const MAX_ROWS = 3

export function RedditWriteNotice({
  duties,
}: {
  duties: readonly { role_id: string; assignment_id: string }[]
}): ReactNode {
  const { t } = useApp()
  const qc = useQueryClient()
  const [go, setGo] = useState(false)
  const assignment = redditWriteAssignment(duties)
  const key = [...REDDIT_WRITES_KEY, assignment ?? '']
  const writes = useQuery({
    queryKey: key,
    queryFn: () => listRedditWrites(assignment ?? ''),
    enabled: assignment !== undefined,
    retry: false,
    refetchInterval: 60_000,
  })
  const settle = (): void => void qc.invalidateQueries({ queryKey: key })
  const refill = useMutation({
    mutationFn: (job_id: string) => refillRedditWrite(assignment ?? '', job_id),
    onSettled: settle,
  })
  const dismiss = useMutation({
    mutationFn: (job_id: string) => dismissRedditWrite(assignment ?? '', job_id),
    onSettled: settle,
  })
  if (assignment === undefined || writes.data === undefined) return null
  const rows = redditWriteNotices(writes.data.rows, new Date().toISOString())
  // WP445：插件里等你发的（还没审的卡 + 批过、等你打开的；同一张卡只算一条）。老服务没有 `in_plugin` 就数批过的
  const awaiting =
    writes.data.in_plugin ??
    new Set(writes.data.rows.filter((w) => w.state === 'awaiting').map((w) => w.approval_item_id))
      .size
  if (rows.length === 0 && awaiting === 0) return null

  const label = (w: RedditWriteView): string =>
    w.label ?? t(`redditw.notice.kind.${w.kind}`, { sub: w.subreddit })
  return (
    <div className="flex flex-col gap-1" data-testid="reddit-write-notice">
      {awaiting === 0 ? null : (
        <div
          className="flex flex-col gap-1 rounded-lg bg-ws-surface px-3 py-2 text-sm"
          data-testid="reddit-write-awaiting"
          data-slot="status"
        >
          <div className="flex flex-wrap items-center gap-2">
            <SendHorizontal className="size-4 shrink-0 text-ws-brand" aria-hidden />
            <button
              type="button"
              className="min-w-0 flex-1 truncate text-left hover:underline"
              onClick={() => setGo((v) => !v)}
              data-testid="reddit-write-awaiting-go"
            >
              {t('redditw.awaiting', { n: awaiting })}
            </button>
            <Hint text={t('redditw.awaiting.hint')} />
          </div>
          {go ? (
            <p className="text-xs text-ws-muted-fg" data-testid="reddit-write-awaiting-tip">
              {t('redditw.awaiting.go')}
            </p>
          ) : null}
        </div>
      )}
      {awaiting === 0 ? null : <ExtensionReloadPrompt waiting />}
      {rows.slice(0, MAX_ROWS).map((w) => (
        // WP456-T2：一行提醒（浅底、黄图标），不再铺一整条黄
        <NoticeLine
          key={w.approval_item_id}
          icon={SendHorizontal}
          data-testid="reddit-write-notice-row"
          data-outcome={w.outcome}
          end={
            <>
              {w.can_refill === true ? (
                <>
                  <Hint text={t('redditw.notice.refill.hint')} />
                  <Button
                    size="xs"
                    className="gap-1"
                    disabled={refill.isPending}
                    onClick={() => refill.mutate(w.job_id)}
                    data-testid="reddit-write-refill"
                  >
                    <RotateCcw className="size-3.5" aria-hidden />
                    {t('redditw.notice.refill')}
                  </Button>
                </>
              ) : null}
              <button
                type="button"
                className="shrink-0 rounded-md p-1 text-ws-muted-fg hover:bg-ws-hover"
                aria-label={t('redditw.notice.dismiss')}
                title={t('redditw.notice.dismiss')}
                disabled={dismiss.isPending}
                onClick={() => dismiss.mutate(w.job_id)}
                data-testid="reddit-write-dismiss"
              >
                <X className="size-3.5" aria-hidden />
              </button>
            </>
          }
        >
          {t('redditw.notice.title', { what: label(w) })}
          {w.message === undefined ? null : (
            <span className="text-ws-muted-fg"> · {w.message}</span>
          )}
        </NoticeLine>
      ))}
      {rows.length > MAX_ROWS ? (
        <p className="px-1 text-xs text-ws-muted-fg">
          {t('redditw.notice.more', { n: rows.length - MAX_ROWS })}
        </p>
      ) : null}
      {refill.error === null ? null : (
        <p role="alert" className="px-1 text-xs text-destructive">
          {refill.error.message}
        </p>
      )}
    </div>
  )
}
