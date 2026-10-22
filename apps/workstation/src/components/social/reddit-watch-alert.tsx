/**
 * WP340：社媒岗位页「优先」提醒条——巡查抓回来的条目命中了告警词（巡查设置里那一组，本地匹配）就出一行：
 * 命中的词 · 在哪 · 谁 · 一行原话 + 打开原帖 + 收起。
 *
 * 出现规则（docs/96 提醒条）：只在有事时出；同一条只一行（同一帖子从几处读到也只一行），收起了不再出；
 * 七天前的不出（巡查数据里还在，可按「优先」筛）。正常时一个字都不画。正文是外部文本：原样截一行，不渲染。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ExternalLink, Siren, X } from 'lucide-react'
import type { ReactNode } from 'react'
import { NoticeLine } from '@/components/design/kit'
import { redditWriteAssignment } from '@/components/social/reddit-write-notice'
import { useApp } from '@/lib/app-context'
import {
  dismissRedditWatchAlert,
  getRedditWatch,
  REDDIT_WATCH_KEY,
  type RedditWatchEntry,
} from '@/lib/reddit-watch-api'

/** 最多出几行（再多的在巡查数据里按「优先」筛）。 */
const MAX_ROWS = 3

export function RedditWatchAlertNotice({
  duties,
}: {
  duties: readonly { role_id: string; assignment_id: string }[]
}): ReactNode {
  const { t } = useApp()
  const qc = useQueryClient()
  const assignment = redditWriteAssignment(duties)
  const key = [...REDDIT_WATCH_KEY, assignment ?? '']
  const view = useQuery({
    queryKey: key,
    queryFn: () => getRedditWatch(assignment ?? ''),
    enabled: assignment !== undefined,
    retry: false,
    refetchInterval: 5 * 60_000,
  })
  const dismiss = useMutation({
    mutationFn: (id: string) => dismissRedditWatchAlert(assignment ?? '', id),
    onSettled: () => void qc.invalidateQueries({ queryKey: key }),
  })
  const rows = view.data?.alerts ?? []
  if (assignment === undefined || rows.length === 0) return null
  return (
    <div className="flex flex-col gap-1" data-testid="reddit-watch-alert">
      {rows.slice(0, MAX_ROWS).map((it) => (
        <AlertRow key={it.id} item={it} onDismiss={() => dismiss.mutate(it.id)} />
      ))}
      {rows.length > MAX_ROWS ? (
        <p className="px-1 text-xs text-ws-muted-fg">
          {t('rwatch.alert.more', { n: rows.length - MAX_ROWS })}
        </p>
      ) : null}
    </div>
  )
}

function AlertRow({ item, onDismiss }: { item: RedditWatchEntry; onDismiss(): void }): ReactNode {
  const { t } = useApp()
  const line = (item.title ?? item.text).replace(/\s+/g, ' ').slice(0, 120)
  const where = [
    item.subreddit === undefined ? '' : `r/${item.subreddit}`,
    item.author === undefined ? '' : `u/${item.author}`,
  ]
    .filter((s) => s !== '')
    .join(' · ')
  return (
    // WP456-T2：一行提醒（浅底、黄图标），不再铺一整条黄
    <NoticeLine
      icon={Siren}
      data-testid="reddit-watch-alert-row"
      end={
        <>
          {item.url === undefined ? null : (
            <a
              href={item.url}
              target="_blank"
              rel="noreferrer noopener"
              aria-label={t('rwatch.open')}
              title={t('rwatch.open')}
              className="shrink-0 rounded-md p-1 text-ws-muted-fg hover:bg-ws-hover"
              data-testid="reddit-watch-alert-open"
            >
              <ExternalLink className="size-3.5" aria-hidden />
            </a>
          )}
          <button
            type="button"
            className="shrink-0 rounded-md p-1 text-ws-muted-fg hover:bg-ws-hover"
            aria-label={t('rwatch.alert.dismiss')}
            title={t('rwatch.alert.dismiss')}
            onClick={onDismiss}
            data-testid="reddit-watch-alert-dismiss"
          >
            <X className="size-3.5" aria-hidden />
          </button>
        </>
      }
    >
      {t('rwatch.alert.title', { words: (item.alert_hits ?? []).join(' / ') })}
      {where === '' ? null : <span className="text-ws-muted-fg"> · {where}</span>}
      <span className="text-ws-muted-fg"> · {line}</span>
    </NoticeLine>
  )
}
