/**
 * WP330（docs/102 附）：**Reddit 周报**那张报表卡的主体。
 *
 * 界面少字（36 §7）：上面一排数，下面按配置的顺序几节；原文默认收着（点话题 / VOC / UGC 才展开），
 * 每条原文带作者、时间、链接。右上两个小图标：复制整份（Markdown）、导出 `.md`。
 * 只排版：数与原文都是服务端数好、截好的（`composeRedditWeekly`），这里一个都不算。
 */
import type {
  RedditWeeklyPayload,
  RedditWeeklyQuote,
  RedditWeeklySection,
} from '@agentsws/contracts'
import { Check, Copy, Download, ExternalLink } from 'lucide-react'
import { useState } from 'react'
import { StatusPill } from '@/components/design'
import { useApp } from '@/lib/app-context'

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** payload 是不是 Reddit 周报（看形状，不看卡的 kind）。 */
export function isRedditWeekly(payload: unknown): payload is RedditWeeklyPayload {
  return (
    isRecord(payload) &&
    payload.kind === 'reddit_weekly' &&
    Array.isArray(payload.sections) &&
    typeof payload.markdown === 'string'
  )
}

const when = (at: string): string => {
  const d = new Date(at)
  if (Number.isNaN(d.getTime())) return at
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function Link({ url }: { url: string | undefined }): React.ReactNode {
  if (url === undefined) return null
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer noopener"
      aria-label={url}
      title={url}
      className="inline-flex shrink-0 text-ws-muted-fg hover:text-ws-fg"
    >
      <ExternalLink className="size-3.5" />
    </a>
  )
}

function Quote({ q }: { q: RedditWeeklyQuote }): React.ReactNode {
  return (
    <li
      className="flex flex-col gap-0.5 rounded-[10px] bg-ws-surface px-3 py-2"
      data-testid="rw-quote"
    >
      {q.note === undefined ? null : <span className="text-xs text-ws-muted-fg">{q.note}</span>}
      <span className="text-[13px] text-ws-body">{q.text}</span>
      <span className="flex items-center gap-2 text-[11px] text-ws-muted-fg">
        {q.author === undefined ? null : <span>u/{q.author}</span>}
        <span>r/{q.subreddit}</span>
        <span>{when(q.at)}</span>
        <Link url={q.url} />
      </span>
    </li>
  )
}

/** 收着的一组（标题 + 数，点开才见原文）。 */
function Fold({
  head,
  quotes,
  testId,
}: {
  head: React.ReactNode
  quotes: RedditWeeklyQuote[]
  testId: string
}): React.ReactNode {
  return (
    <details className="group" data-testid={testId}>
      <summary className="flex cursor-pointer list-none items-center gap-2 text-[13px]">
        {head}
      </summary>
      {quotes.length === 0 ? null : (
        <ul className="mt-1.5 flex flex-col gap-1.5">
          {quotes.map((q) => (
            <Quote key={q.id} q={q} />
          ))}
        </ul>
      )}
    </details>
  )
}

function SectionBody({
  s,
  labels,
}: {
  s: RedditWeeklySection
  labels: RedditWeeklyPayload['assessment_labels']
}): React.ReactNode {
  const { t } = useApp()
  if (s.id === 'own_stats')
    return (
      <p className="text-[13px] text-ws-body">
        {s.subreddits.map((x) => `r/${x}`).join('、')}{' '}
        {t('rw.posts_comments', { posts: String(s.posts), comments: String(s.comments) })}
      </p>
    )
  if (s.id === 'voc_ugc')
    return (
      <div className="flex flex-col gap-1.5">
        <Fold head={<span>VOC · {s.voc.length}</span>} quotes={s.voc} testId="rw-voc" />
        <Fold head={<span>UGC · {s.ugc.length}</span>} quotes={s.ugc} testId="rw-ugc" />
      </div>
    )
  if (s.id === 'external')
    return s.topics.length === 0 ? (
      <p className="text-[13px] text-ws-muted-fg">{t('rw.none')}</p>
    ) : (
      <div className="flex flex-col gap-1.5">
        {s.topics.map((topic) => (
          <Fold
            key={topic.key}
            testId="rw-topic"
            quotes={topic.quotes}
            head={
              <>
                <span className="min-w-0 flex-1 truncate">{topic.label}</span>
                <span className="ws-num shrink-0 text-xs text-ws-muted-fg">
                  post × {topic.posts} / comment × {topic.comments}
                </span>
                <StatusPill tone={topic.assessment === 'follow_up' ? 'warn' : 'neutral'}>
                  {labels[topic.assessment]}
                </StatusPill>
              </>
            }
          />
        ))}
      </div>
    )
  return (
    <div className="flex flex-col gap-1">
      <p className="text-[13px] text-ws-body">
        {t('rw.replies', { posts: String(s.to_posts), comments: String(s.to_comments) })}
        {s.new_posts > 0 ? ` · ${t('rw.new_posts', { n: String(s.new_posts) })}` : ''}
      </p>
      {s.replies.length === 0 ? null : (
        <ul className="flex flex-col gap-0.5" data-testid="rw-replies">
          {s.replies.map((r) => (
            <li key={r.record_id} className="flex items-center gap-2 text-xs text-ws-muted-fg">
              <span className="ws-num shrink-0">{when(r.at)}</span>
              <span className="min-w-0 flex-1 truncate">{r.thread_title ?? r.text}</span>
              <Link url={r.url} />
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** 导出 `.md`（浏览器下载；不经服务端，内容就是卡上那一份）。 */
function download(filename: string, content: string): void {
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

const ICON_BTN =
  'inline-flex size-7 items-center justify-center rounded-md text-ws-muted-fg hover:bg-ws-surface hover:text-ws-fg'

export function RedditWeeklyBody({ payload }: { payload: RedditWeeklyPayload }): React.ReactNode {
  const { t } = useApp()
  const [copied, setCopied] = useState(false)
  const tot = payload.totals
  const figures: [string, number][] = [
    [t('rw.fig.posts'), tot.posts],
    [t('rw.fig.comments'), tot.comments],
    ['VOC', tot.voc],
    ['UGC', tot.ugc],
    [t('rw.fig.follow_up'), tot.follow_up_topics],
    [t('rw.fig.replies'), tot.to_posts + tot.to_comments],
  ]
  return (
    <div className="mt-2.5 flex flex-col gap-3" data-testid="reddit-weekly">
      <div className="flex items-start gap-3">
        <dl className="flex flex-1 flex-wrap gap-x-5 gap-y-1" data-testid="rw-figures">
          {figures.map(([k, v]) => (
            <div key={k}>
              <dt className="text-[11px] text-ws-muted-fg">{k}</dt>
              <dd className="ws-display ws-num text-base">{v}</dd>
            </div>
          ))}
        </dl>
        <button
          type="button"
          className={ICON_BTN}
          aria-label={t('rw.copy')}
          title={t('rw.copy')}
          data-testid="rw-copy"
          onClick={() => {
            void navigator.clipboard?.writeText(payload.markdown).then(() => {
              setCopied(true)
              setTimeout(() => setCopied(false), 1500)
            })
          }}
        >
          {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
        </button>
        <button
          type="button"
          className={ICON_BTN}
          aria-label={t('rw.export')}
          title={t('rw.export')}
          data-testid="rw-export"
          onClick={() => download(`reddit-weekly-${payload.week_of}.md`, payload.markdown)}
        >
          <Download className="size-4" />
        </button>
      </div>
      {payload.sections.map((s) => (
        <section key={s.id} className="flex flex-col gap-1" data-testid={`rw-section-${s.id}`}>
          <h4 className="text-xs font-medium text-ws-muted-fg">{s.title}</h4>
          <SectionBody s={s} labels={payload.assessment_labels} />
        </section>
      ))}
      {payload.sweeps.count === 0 ? (
        <p className="text-xs text-ws-muted-fg" data-testid="rw-no-sweep">
          {t('rw.no_sweep')}
        </p>
      ) : null}
    </div>
  )
}
