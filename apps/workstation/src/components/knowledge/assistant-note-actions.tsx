/**
 * WP357（决策 902）：助理记进知识库的口径——**改 / 删**。
 *
 * 方案卡上点一次「就这样」口径就生效了，所以要能事后改、删（Luoye 10-16：「知识库里可改可删」）。
 * 只给助理扇出的条目（`subject.type = assistant_note`、还没退役的）出这两个小钮；别的知识照旧
 * 「写只经审批项」（19 §4），这里不碰。改 = 就地改正文（出处不变、改之前那句服务端留痕），
 * 删 = 退役（留痕不真删）。只有让助理记的那个人改得了——别人点了服务端照实回一句，显示在这一行下面。
 *
 * 两处用：知识库页每一行（`KnowledgeRow`）与岗位第三栏「知识」里「助理记下的」那一块。
 */
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Pencil, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import type { KnowledgeCardRow } from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { editAssistantNote, removeAssistantNote } from '@/lib/free-chat'

/** 这条是不是助理记下、还能改的口径。 */
export const isAssistantNote = (card: Pick<KnowledgeCardRow, 'subject' | 'status'>): boolean =>
  card.subject.type === 'assistant_note' && card.status !== 'retired'

export function AssistantNoteActions({ card }: { card: KnowledgeCardRow }): React.ReactNode {
  const { t } = useApp()
  const client = useQueryClient()
  const [draft, setDraft] = useState<string | undefined>(undefined)
  const done = (): void => {
    setDraft(undefined)
    // 知识库页与第三栏各用一个查询键
    void client.invalidateQueries({ queryKey: ['knowledge-cards'] })
    void client.invalidateQueries({ queryKey: ['knowledge', 'cards'] })
  }
  const edit = useMutation({
    mutationFn: (text: string) => editAssistantNote(card.id, text),
    onSuccess: done,
  })
  const remove = useMutation({ mutationFn: () => removeAssistantNote(card.id), onSuccess: done })
  const failed = edit.error ?? remove.error
  if (!isAssistantNote(card)) return null

  if (draft !== undefined)
    return (
      <form
        className="flex w-full flex-col gap-1"
        data-testid="assistant-note-form"
        onSubmit={(e) => {
          e.preventDefault()
          if (draft.trim() !== '') edit.mutate(draft.trim())
        }}
      >
        <textarea
          className="min-h-14 w-full rounded-md border bg-ws-card px-2 py-1 text-[13px] text-ws-ink"
          value={draft}
          maxLength={300}
          aria-label={t('knowledge.note.edit')}
          data-testid="assistant-note-input"
          onChange={(e) => setDraft(e.target.value)}
        />
        <div className="flex items-center gap-1.5">
          <Button
            type="submit"
            size="xs"
            disabled={edit.isPending || draft.trim() === ''}
            data-testid="assistant-note-save"
          >
            {t('knowledge.note.save')}
          </Button>
          <Button type="button" size="xs" variant="ghost" onClick={() => setDraft(undefined)}>
            {t('knowledge.note.cancel')}
          </Button>
          {failed === null ? null : (
            <span className="text-xs text-destructive">{failed.message}</span>
          )}
        </div>
      </form>
    )

  return (
    <span className="inline-flex items-center gap-0.5" data-testid="assistant-note-actions">
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        title={t('knowledge.note.edit')}
        aria-label={t('knowledge.note.edit')}
        data-testid="assistant-note-edit"
        onClick={() => setDraft(card.statement)}
      >
        <Pencil aria-hidden />
      </Button>
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        title={t('knowledge.note.remove')}
        aria-label={t('knowledge.note.remove')}
        disabled={remove.isPending}
        data-testid="assistant-note-remove"
        onClick={() => remove.mutate()}
      >
        <Trash2 aria-hidden />
      </Button>
      {failed === null ? null : (
        <span className="text-xs text-destructive" data-testid="assistant-note-error">
          {failed.message}
        </span>
      )}
    </span>
  )
}
