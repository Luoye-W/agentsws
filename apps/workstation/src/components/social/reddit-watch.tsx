/**
 * WP328：「Reddit 巡查」——「Reddit」那条社媒职责的快捷视图。
 *
 * 一屏：一行状态（上次什么时候、三块各自好了没有 + 「现在巡查」，说明进问号）→ 要回的清单
 * （来源 · 作者 · 一行原文 · AI 的一句理由 · 打开原帖 · 不回）。起草与发出在 WP329（「发出去」卡）。
 *
 * 界面纪律：读不成就照实说（缺连接 / 缺设置在卡片流里有卡）；正文是外部文本，原样截一行，不渲染。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ExternalLink, RefreshCw, X } from 'lucide-react'
import type { ReactNode } from 'react'
import { StatusPill, type Tone, WsTag } from '@/components/design'
import { Button } from '@/components/ui/button'
import { EmptyLine } from '@/components/ui/empty-line'
import { Hint } from '@/components/ui/hint'
import { useApp } from '@/lib/app-context'
import { formatDateTime } from '@/lib/format'
import {
  getRedditWatch,
  REDDIT_WATCH_KEY,
  type RedditWatchItem,
  runRedditWatch,
  setRedditWatchStatus,
} from '@/lib/reddit-watch-api'

const TONE: Record<string, Tone> = {
  ok: 'good',
  waiting: 'neutral',
  skipped: 'neutral',
  needs_connection: 'warn',
  needs_setup: 'warn',
  failed: 'bad',
}

export function RedditWatch({ assignment }: { assignment: string }): ReactNode {
  const { t, lang } = useApp()
  const qc = useQueryClient()
  const key = [...REDDIT_WATCH_KEY, assignment]
  const view = useQuery({ queryKey: key, queryFn: () => getRedditWatch(assignment) })
  const run = useMutation({
    mutationFn: () => runRedditWatch(assignment),
    onSettled: () => void qc.invalidateQueries({ queryKey: key }),
  })
  const dismiss = useMutation({
    mutationFn: (id: string) => setRedditWatchStatus(assignment, id, 'dismissed'),
    onSettled: () => void qc.invalidateQueries({ queryKey: key }),
  })
  const v = view.data
  const last = v?.last_run
  return (
    <div className="flex flex-col gap-3" data-testid="reddit-watch">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted-foreground">
          {last === undefined
            ? t('rwatch.never')
            : t('rwatch.last', { at: formatDateTime(last.finished_at ?? last.started_at, lang) })}
        </span>
        {(last?.parts ?? []).map((p) => (
          <StatusPill key={p.part} tone={TONE[p.status] ?? 'neutral'} title={p.message}>
            {t(`rwatch.part.${p.part}`)} · {t(`rwatch.status.${p.status}`)}
          </StatusPill>
        ))}
        <Hint text={t('rwatch.hint')} />
        <Button
          size="sm"
          variant="outline"
          className="ml-auto"
          disabled={run.isPending}
          onClick={() => run.mutate()}
          data-testid="reddit-watch-run"
        >
          <RefreshCw className="size-3.5" />
          {t('rwatch.run')}
        </Button>
      </div>
      {v !== undefined && !v.configured ? (
        <p className="text-sm text-muted-foreground">{t('rwatch.unconfigured')}</p>
      ) : null}
      {v === undefined ? null : v.pending.length === 0 ? (
        <EmptyLine text={t('rwatch.pending.empty')} testId="reddit-watch-empty" />
      ) : (
        <ul className="flex flex-col divide-y" data-testid="reddit-watch-pending">
          {v.pending.map((it) => (
            <Row key={it.id} item={it} onDismiss={() => dismiss.mutate(it.id)} />
          ))}
        </ul>
      )}
    </div>
  )
}

function Row({ item, onDismiss }: { item: RedditWatchItem; onDismiss(): void }): ReactNode {
  const { t } = useApp()
  const line = (item.title ?? item.text).replace(/\s+/g, ' ').slice(0, 140)
  return (
    <li className="flex items-start gap-2 py-2 text-sm">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <WsTag>{t(`rwatch.source.${item.source}`)}</WsTag>
          {item.subreddit === undefined ? null : <span>r/{item.subreddit}</span>}
          {item.author === undefined ? null : <span>u/{item.author}</span>}
        </div>
        <p className="truncate">{line}</p>
        {item.judgement === undefined ? null : (
          <p className="text-xs text-muted-foreground">{item.judgement.reason}</p>
        )}
      </div>
      {item.url === undefined ? null : (
        <a
          href={item.url}
          target="_blank"
          rel="noreferrer noopener"
          aria-label={t('rwatch.open')}
          className="p-1 text-muted-foreground hover:text-foreground"
        >
          <ExternalLink className="size-3.5" />
        </a>
      )}
      <Button size="sm" variant="ghost" onClick={onDismiss} data-testid="reddit-watch-dismiss">
        <X className="size-3.5" />
        {t('rwatch.dismiss')}
      </Button>
    </li>
  )
}
