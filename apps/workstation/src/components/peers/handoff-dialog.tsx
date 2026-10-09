/**
 * WP276（docs/95 §4.3 第 1 步）：「交给同事」——一个人名下拉（带忙闲）+ 一行可选留言。
 *
 * 事项页「⋯ → 交给同事」、待办行「交给同事」、⌘K「把这件事交给同事…」都开这一个。
 * 交出去主人不变，对方收一张卡点「接下」才算；几天没人理自动退回（tooltip 说，界面不铺字）。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Hint } from '@/components/ui/hint'
import { Input } from '@/components/ui/input'
import { ApiClientError } from '@/lib/api'
import { type HandoffKind, listColleagues, offerHandoff } from '@/lib/api-peers'
import { useApp } from '@/lib/app-context'
import { cn } from '@/lib/utils'
import { getWorkArchiveSettings } from '@/lib/work-archive'

export function HandoffDialog({
  kind,
  id,
  title,
  open,
  onOpenChange,
}: {
  kind: HandoffKind
  id: string
  title: string
  open: boolean
  onOpenChange: (open: boolean) => void
}): React.ReactNode {
  const { t } = useApp()
  const client = useQueryClient()
  const [to, setTo] = useState<string | null>(null)
  const [note, setNote] = useState('')
  const colleagues = useQuery({
    queryKey: ['colleagues'],
    queryFn: listColleagues,
    enabled: open,
    retry: false,
  })
  const settings = useQuery({
    queryKey: ['settings', 'work-archive'],
    queryFn: getWorkArchiveSettings,
    enabled: open,
    retry: false,
  })
  const send = useMutation({
    mutationFn: () =>
      offerHandoff(kind, id, {
        to: to ?? '',
        ...(note.trim() === '' ? {} : { note: note.trim() }),
      }),
    onSuccess: async () => {
      setTo(null)
      setNote('')
      onOpenChange(false)
      await client.invalidateQueries({ queryKey: ['handoffs'] })
      await client.invalidateQueries({ queryKey: ['matter', id] })
      await client.invalidateQueries({ queryKey: ['todos'] })
    },
  })
  const people = colleagues.data?.colleagues ?? []
  const days = settings.data?.handoff_days ?? 3

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="handoff-dialog"
        className="sm:max-w-md"
        /*
         * WP278：一打开先落在第一位同事上。默认的自动聚焦落在标题旁的问号上，tooltip 一打开就把
         * 标题挡住（WP277 向导同一个问题）；测试里 jsdom 给弹层算位置（`:modal` 匹配）还会卡住几秒。
         */
        onOpenAutoFocus={(e) => {
          e.preventDefault()
          const first =
            e.currentTarget instanceof HTMLElement
              ? e.currentTarget.querySelector<HTMLElement>(
                  '[data-testid="handoff-person"], [data-testid="handoff-note"]',
                )
              : null
          first?.focus()
        }}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-1.5">
            {t('handoff.give')}
            <Hint text={t('handoff.dialog.hint', { days: String(days) })} />
          </DialogTitle>
        </DialogHeader>
        <p className="truncate text-sm text-muted-foreground">{title}</p>
        <fieldset className="flex flex-col gap-1.5" aria-label={t('handoff.dialog.who')}>
          {people.length === 0 && colleagues.data !== undefined ? (
            <p className="text-sm text-muted-foreground">{t('handoff.dialog.none')}</p>
          ) : (
            people.map((p) => (
              <button
                key={p.person_id}
                type="button"
                aria-pressed={to === p.person_id}
                data-testid="handoff-person"
                onClick={() => {
                  setTo(p.person_id)
                }}
                className={cn(
                  'flex h-9 items-center justify-between rounded-lg border px-3 text-left text-sm',
                  to === p.person_id ? 'border-ws-brand bg-ws-surface' : 'hover:bg-muted',
                )}
              >
                <span>{p.name}</span>
                <span className="text-xs text-muted-foreground">{p.load}</span>
              </button>
            ))
          )}
        </fieldset>
        <Input
          data-testid="handoff-note"
          value={note}
          maxLength={200}
          placeholder={t('handoff.dialog.note')}
          onChange={(e) => {
            setNote(e.target.value)
          }}
        />
        {send.error === null ? null : (
          <p role="alert" className="text-xs text-destructive">
            {send.error instanceof ApiClientError ? send.error.message : t('error.generic')}
          </p>
        )}
        <div className="flex justify-end">
          <Button
            size="sm"
            data-testid="handoff-send"
            disabled={to === null || send.isPending}
            onClick={() => {
              send.mutate()
            }}
          >
            {t('handoff.dialog.send')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
