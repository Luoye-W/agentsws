/**
 * WP511（决策 1546 / 1765「资料在右、决策在中」）：第三栏「打开那一段」——助理长对话里以前某一段话题的原话。
 *
 * 从哪里开：话题分隔线上那一行小结、回复下面的出处（助理翻了以前聊过的 / 打开了以前那一段）。
 * 地址 `agentsws://assistant-segment/<段>/<句>`：开到那一段，亮那一句、滚到它。只读；附件只有名字与字数。
 * 一页 50 句，「更早的」「更多」翻页。
 */
import { useQuery } from '@tanstack/react-query'
import { Paperclip } from 'lucide-react'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { parseAssistantSegmentAddress } from '@/components/free-chat/segment-address'
import { PanelError } from '@/components/rail/panel-error'
import type { RailPanelBodyProps } from '@/components/rail/registry'
import { Skeleton } from '@/components/ui/skeleton'
import { useApp } from '@/lib/app-context'
import { type FreeChatMessage, getAssistantSegment } from '@/lib/free-chat'
import { cn } from '@/lib/utils'

/** 一页几句。 */
export const SEGMENT_PAGE = 50

export function AssistantSegmentPanel({ address }: RailPanelBodyProps): ReactNode {
  const { t, lang } = useApp()
  const target = parseAssistantSegmentAddress(address)
  // 翻到第几句跟着地址走：换了一段 / 一句就从头开（要亮的那句不在第一页时，第一次取回来再跳页）
  const [paging, setPaging] = useState<{ address?: string | undefined; from: number }>({ from: 1 })
  const from = paging.address === address ? paging.from : 1
  const setFrom = (n: number): void => setPaging({ address, from: n })
  const lit = useRef<HTMLLIElement>(null)
  const want = target?.message_id
  const page = useQuery({
    queryKey: ['free-chat', 'segment', target?.segment_id, from],
    queryFn: () => getAssistantSegment(target?.segment_id ?? '', from, SEGMENT_PAGE),
    enabled: target !== undefined,
    retry: false,
  })
  const data = page.data
  useEffect(() => {
    if (data === undefined || want === undefined) return
    if (data.messages.some((m) => m.id === want)) {
      lit.current?.scrollIntoView({ block: 'center' })
      return
    }
    // 要亮的那句在后面几页：往后翻（只自动翻这一回，之后人自己翻）
    if (data.from + data.messages.length <= data.total && data.from === 1)
      setPaging({ address, from: data.from + SEGMENT_PAGE })
  }, [data, want, address])
  if (target === undefined)
    return (
      <p className="p-3 text-[12px] text-ws-muted-fg" data-testid="assistant-segment-empty">
        {t('assistant.segment.pick')}
      </p>
    )
  if (page.isPending) return <Skeleton className="m-3 h-40" />
  if (page.error !== null) return <PanelError error={page.error} />
  const p = page.data
  const date = (at: string): string =>
    new Date(at).toLocaleString(lang === 'en' ? 'en-US' : 'zh-CN', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  const until = p.from + p.messages.length - 1
  return (
    <div className="flex flex-col gap-3 p-3" data-testid="assistant-segment-panel">
      <header className="flex flex-col gap-1">
        <h3 className="text-[13px] font-medium" data-testid="assistant-segment-title">
          {t('assistant.segment.head', { n: p.n, date: date(p.segment.started_at) })}
          {p.segment.title === undefined ? '' : ` · ${p.segment.title}`}
        </h3>
        {p.segment.summary === undefined ? null : (
          <details className="text-[12px] text-ws-muted-fg">
            <summary className="cursor-pointer">{t('assistant.segment.summary')}</summary>
            <p className="mt-1 whitespace-pre-wrap">{p.segment.summary}</p>
          </details>
        )}
      </header>
      {p.from > 1 ? (
        <button
          type="button"
          className="self-start text-[12px] text-ws-muted-fg hover:text-foreground"
          data-testid="assistant-segment-earlier"
          onClick={() => setFrom(Math.max(1, p.from - SEGMENT_PAGE))}
        >
          {t('assistant.segment.earlier')}
        </button>
      ) : null}
      <ol className="flex flex-col gap-2">
        {p.messages.map((m, i) => (
          <SegmentLine
            key={m.id}
            m={m}
            n={p.from + i}
            at={date(m.at)}
            lit={m.id === want}
            {...(m.id === want ? { refEl: lit } : {})}
          />
        ))}
      </ol>
      {until < p.total ? (
        <button
          type="button"
          className="self-start text-[12px] text-ws-muted-fg hover:text-foreground"
          data-testid="assistant-segment-more"
          onClick={() => setFrom(until + 1)}
        >
          {t('assistant.segment.more', { n: p.total - until })}
        </button>
      ) : null}
    </div>
  )
}

function SegmentLine({
  m,
  n,
  at,
  lit,
  refEl,
}: {
  m: FreeChatMessage
  n: number
  at: string
  lit: boolean
  refEl?: React.RefObject<HTMLLIElement | null>
}): ReactNode {
  const { t } = useApp()
  const who =
    m.role === 'user'
      ? t('assistant.segment.you')
      : m.report === undefined
        ? t('assistant.segment.assistant')
        : t('assistant.segment.report')
  return (
    <li
      ref={refEl}
      data-testid="assistant-segment-line"
      data-msg={m.id}
      data-lit={lit ? 'true' : undefined}
      className={cn(
        'flex flex-col gap-0.5 rounded-lg px-2.5 py-2',
        m.role === 'user' ? 'bg-ws-surface' : 'bg-ws-card',
        lit && 'ring-2 ring-ws-brand/50',
      )}
    >
      <span className="text-xs text-ws-muted-fg">
        <span className="ws-num">{n}</span> · {who} · {at}
      </span>
      {m.text === '' ? null : <p className="whitespace-pre-wrap text-[13px]">{m.text}</p>}
      {(m.attachments ?? []).map((a) => (
        <span
          key={a.name}
          className="inline-flex items-center gap-1 text-[12px] text-ws-muted-fg"
          data-testid="assistant-segment-file"
        >
          <Paperclip aria-hidden className="size-3" />
          {a.name} · {t('matter.file.chars', { n: a.chars })}
        </span>
      ))}
    </li>
  )
}
