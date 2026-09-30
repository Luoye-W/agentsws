/**
 * WP207：「让 AI 找回」的候选卡——随便聊、⌘K、归档列表三处共用一份。
 *
 * **人点了哪张才恢复哪张**（`by: ai_suggested`，审计里看得出是 AI 给的候选、人点选的）；
 * 没有「全部恢复」按钮，这是刻意的：AI 只能给候选，不许不经点选批量放回。
 * 恢复完：左栏重取、跳进那件事。
 */
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { cn } from 'cn'
import { ArchiveRestore, Check } from 'lucide-react'
import type { ReactNode } from 'react'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useApp } from '@/lib/app-context'
import { formatDate } from '@/lib/format'
import { type ArchivedWorkCandidate, unarchiveMatter, whyParts } from '@/lib/work-archive'

/** `title:红人` → 「标题里有「红人」」；认不出的种类不显示（不把机器串摆给人看）。 */
export function whyText(why: string, t: (k: string, v?: Record<string, string>) => string): string {
  const { kind, text } = whyParts(why)
  if (!['title', 'summary', 'people', 'labels', 'body', 'time', 'semantic'].includes(kind))
    return ''
  if (kind === 'semantic') return t('archive.why.semantic')
  if (kind === 'time' && (text === '' || text === 'range')) return ''
  return t(`archive.why.${kind}`, { w: text })
}

export function RecallCards({
  candidates,
  onRestored,
  compact = false,
}: {
  candidates: readonly ArchivedWorkCandidate[]
  /** 恢复完之后（关面板之类）；不给就只跳进那件事。 */
  onRestored?: (matter_id: string) => void
  compact?: boolean
}): ReactNode {
  const { t, lang } = useApp()
  const client = useQueryClient()
  const navigate = useNavigate()
  const [done, setDone] = useState<string[]>([])
  const restore = useMutation({
    mutationFn: (id: string) => unarchiveMatter(id, 'ai_suggested'),
    onSuccess: async (_out, id) => {
      setDone((list) => [...list, id])
      await client.invalidateQueries({ queryKey: ['matter'] })
      onRestored?.(id)
      navigate(`/matters/${encodeURIComponent(id)}`)
    },
  })
  return (
    <ul
      className={cn('grid gap-2', compact ? 'grid-cols-1' : 'sm:grid-cols-2')}
      data-testid="recall-cards"
    >
      {candidates.map((c) => {
        const restored = done.includes(c.matter_id)
        const reasons = c.why.map((w) => whyText(w, t)).filter((w) => w !== '')
        return (
          <li key={c.matter_id}>
            <button
              type="button"
              data-testid="recall-card"
              data-matter={c.matter_id}
              disabled={restore.isPending || restored}
              className="flex w-full flex-col gap-1 rounded-[10px] border border-ws-line bg-ws-card p-2.5 text-left shadow-ws transition-shadow hover:shadow-ws-hover disabled:opacity-70"
              onClick={() => {
                restore.mutate(c.matter_id)
              }}
            >
              <span className="flex items-center gap-1.5 text-[13px] font-medium">
                <span className="min-w-0 flex-1 truncate">{c.title}</span>
                {restored ? (
                  <Check aria-hidden className="size-3.5 text-ws-good" />
                ) : (
                  <ArchiveRestore aria-hidden className="size-3.5 text-ws-muted-fg" />
                )}
              </span>
              {c.summary === '' ? null : (
                <span className="line-clamp-2 text-[12px] text-ws-muted-fg">{c.summary}</span>
              )}
              <span className="flex flex-wrap gap-x-2 text-[11px] text-ws-muted-fg">
                <span>{formatDate(c.last_activity, lang)}</span>
                {reasons.slice(0, 2).map((r) => (
                  <span key={r}>· {r}</span>
                ))}
              </span>
              <span className="text-[11.5px] text-ws-brand-ink">
                {restored ? t('free_chat.recall.restored') : t('free_chat.recall.restore')}
              </span>
            </button>
          </li>
        )
      })}
    </ul>
  )
}
