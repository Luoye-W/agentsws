/**
 * WP188：随便聊左边那一列——新对话、按日期分组的会话（今天 / 昨天 / 7 天内 / 更早），
 * 每一行悬停出「改名 / 删除」两个小按钮。
 */
import { Pencil, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { useApp } from '@/lib/app-context'
import { type FreeChatSession, groupOf, type SessionGroup } from '@/lib/free-chat'
import { cn } from '@/lib/utils'

const ORDER: SessionGroup[] = ['today', 'yesterday', 'week', 'older']

export function SessionList({
  sessions,
  current,
  onNew,
  onPick,
  onRename,
  onDelete,
}: {
  sessions: FreeChatSession[]
  current: string | undefined
  onNew: () => void
  onPick: (id: string) => void
  onRename: (id: string, title: string) => void
  onDelete: (id: string) => void
}): React.ReactNode {
  const { t } = useApp()
  const [editing, setEditing] = useState<string | undefined>(undefined)
  const [draft, setDraft] = useState('')
  const now = new Date()
  const groups = ORDER.map((g) => ({
    g,
    rows: sessions.filter((s) => groupOf(s.updated_at, now) === g),
  })).filter((x) => x.rows.length > 0)

  return (
    <div className="flex h-full flex-col gap-2" data-testid="free-chat-sessions">
      <Button
        variant="outline"
        size="sm"
        className="justify-start"
        data-testid="free-chat-new"
        onClick={onNew}
      >
        <Plus aria-hidden />
        {t('free_chat.new')}
      </Button>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
        {groups.map(({ g, rows }) => (
          <section key={g} className="flex flex-col gap-0.5" data-group={g}>
            <h4 className="px-2 text-[11px] text-ws-muted-fg">{t(`free_chat.group.${g}`)}</h4>
            {rows.map((s) =>
              editing === s.id ? (
                <input
                  key={s.id}
                  // biome-ignore lint/a11y/noAutofocus: 点了「改名」就是要马上打字
                  autoFocus
                  value={draft}
                  aria-label={t('free_chat.rename')}
                  data-testid="free-chat-rename-input"
                  className="rounded-md border px-2 py-1 text-[13px]"
                  onChange={(e) => {
                    setDraft(e.target.value)
                  }}
                  onBlur={() => {
                    setEditing(undefined)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') setEditing(undefined)
                    if (e.key === 'Enter' && draft.trim() !== '') {
                      onRename(s.id, draft.trim())
                      setEditing(undefined)
                    }
                  }}
                />
              ) : (
                <div
                  key={s.id}
                  className={cn(
                    'group flex items-center rounded-md text-[13px]',
                    s.id === current
                      ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                      : 'hover:bg-muted/60',
                  )}
                >
                  <button
                    type="button"
                    className="min-w-0 flex-1 truncate px-2 py-1.5 text-left"
                    data-testid="free-chat-session"
                    data-session={s.id}
                    aria-current={s.id === current ? 'page' : undefined}
                    onClick={() => {
                      onPick(s.id)
                    }}
                  >
                    {s.title}
                  </button>
                  {/* 悬停才出的两个小按钮：改名 / 删除（不弹菜单，少一次点击） */}
                  <span className="flex shrink-0 items-center opacity-0 group-focus-within:opacity-100 group-hover:opacity-100">
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-label={t('free_chat.rename')}
                      title={t('free_chat.rename')}
                      data-testid="free-chat-rename"
                      onClick={() => {
                        setDraft(s.title)
                        setEditing(s.id)
                      }}
                    >
                      <Pencil aria-hidden />
                    </Button>
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-label={t('free_chat.delete')}
                      title={t('free_chat.delete')}
                      data-testid="free-chat-delete"
                      onClick={() => {
                        if (globalThis.confirm(t('free_chat.delete.confirm'))) onDelete(s.id)
                      }}
                    >
                      <Trash2 aria-hidden />
                    </Button>
                  </span>
                </div>
              ),
            )}
          </section>
        ))}
      </div>
    </div>
  )
}
