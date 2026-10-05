/**
 * WP219（docs/90 §6.1）：「查看改动」与「看对比」两个弹窗。
 *
 * - 查看改动：按段列出新版加了 / 改了 / 删了什么（服务端算好，`/items/:id/diff`）；
 * - 看对比：冲突卡上那一段的三份——旧版、新版、你的（卡的 payload 里就有，不再请求）。
 *
 * 只排版不改写：段落原文照抄，空的那一格不出。
 */
import type { ContentConflictCardPayload, ContentSectionChange } from '@agentsws/contracts'
import { useQuery } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useApp } from '@/lib/app-context'
import { getContentDiff } from '@/lib/content-updates'

const CHANGE_TONE: Record<ContentSectionChange['change'], string> = {
  added: 'bg-ws-good-bg text-ws-good',
  changed: 'bg-ws-info-bg text-ws-info',
  removed: 'bg-ws-bad-bg text-ws-bad',
}

function Block({
  label,
  text,
  testId,
}: {
  label: string
  text: string
  testId: string
}): ReactNode {
  return (
    <div className="flex min-w-0 flex-col gap-1" data-testid={testId}>
      <span className="text-xs text-ws-muted-fg">{label}</span>
      <p className="max-h-56 overflow-auto rounded-[10px] bg-ws-surface p-2.5 text-[13px] leading-5 whitespace-pre-wrap">
        {text === '' ? '—' : text}
      </p>
    </div>
  )
}

/** 「查看改动」：一条内容这次改了哪些段。 */
export function ContentDiffDialog({
  itemId,
  open,
  onOpenChange,
}: {
  itemId: string
  open: boolean
  onOpenChange: (open: boolean) => void
}): ReactNode {
  const { t, lang } = useApp()
  const diff = useQuery({
    queryKey: ['content-updates', 'diff', itemId],
    queryFn: () => getContentDiff(itemId),
    enabled: open,
    retry: false,
  })
  const d = diff.data
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl" data-testid="content-diff-dialog">
        <DialogHeader>
          <DialogTitle>
            {d === undefined
              ? t('content_updates.diff.title')
              : `${d.title[lang]} · ${d.from_version ?? '—'} → ${d.to_version}`}
          </DialogTitle>
        </DialogHeader>
        {diff.isError ? (
          <p className="text-sm text-ws-bad">{t('content_updates.diff.error')}</p>
        ) : null}
        <ul className="flex max-h-[60vh] flex-col gap-3 overflow-auto">
          {(d?.sections ?? []).map((s) => (
            <li
              key={`${s.change}:${s.heading}`}
              className="flex flex-col gap-1.5"
              data-testid="content-diff-section"
            >
              <div className="flex items-center gap-2">
                <span className={`rounded px-1.5 py-0.5 text-xs ${CHANGE_TONE[s.change]}`}>
                  {t(`content_updates.diff.${s.change}`)}
                </span>
                <span className="text-sm font-medium">
                  {s.heading === '' ? t('content_updates.diff.preamble') : s.heading}
                </span>
              </div>
              <div className={s.change === 'changed' ? 'grid gap-2 sm:grid-cols-2' : 'grid gap-2'}>
                {s.before === undefined ? null : (
                  <Block
                    label={t('content_updates.diff.before')}
                    text={s.before}
                    testId="content-diff-before"
                  />
                )}
                {s.after === undefined ? null : (
                  <Block
                    label={t('content_updates.diff.after')}
                    text={s.after}
                    testId="content-diff-after"
                  />
                )}
              </div>
            </li>
          ))}
          {d !== undefined && d.sections.length === 0 ? (
            <li className="text-sm text-ws-muted-fg">{t('content_updates.diff.none')}</li>
          ) : null}
        </ul>
      </DialogContent>
    </Dialog>
  )
}

/** 「看对比」：冲突的那一段——旧版、新版、你的。 */
export function ContentConflictDialog({
  payload,
  open,
  onOpenChange,
}: {
  payload: Partial<ContentConflictCardPayload>
  open: boolean
  onOpenChange: (open: boolean) => void
}): ReactNode {
  const { t, lang } = useApp()
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl" data-testid="content-conflict-dialog">
        <DialogHeader>
          <DialogTitle>
            {`${payload.title?.[lang] ?? payload.name ?? ''} · ${payload.heading ?? ''}`}
          </DialogTitle>
        </DialogHeader>
        <div className="grid gap-2 sm:grid-cols-3">
          <Block
            label={t('content_updates.conflict.before')}
            text={payload.base_before ?? ''}
            testId="conflict-before"
          />
          <Block
            label={t('content_updates.conflict.after')}
            text={payload.base_after ?? ''}
            testId="conflict-after"
          />
          <Block
            label={t('content_updates.conflict.mine')}
            text={payload.mine ?? ''}
            testId="conflict-mine"
          />
        </div>
      </DialogContent>
    </Dialog>
  )
}
