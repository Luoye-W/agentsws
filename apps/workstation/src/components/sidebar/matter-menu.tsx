/**
 * WP207（Fable 09-30）：左栏每件事悬停出的「⋯」小菜单——现在只有一项「归档」。
 *
 * 在跑的、有卡等你批的，「归档」置灰，旁边一个问号说为什么（36 §7：说明进 tooltip）。
 * 不用 Radix 下拉：一项的菜单用不着它，自己画一小块，Esc / 点外面 / 失焦就关。
 */
import { cn } from 'cn'
import { Archive, MoreHorizontal } from 'lucide-react'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { Hint } from '@/components/ui/hint'
import { useApp } from '@/lib/app-context'
import type { RailMatterState } from '@/lib/work-archive'

/** 这件事现在能不能归档；不能的话回说明那一句的 i18n 键。 */
export function archiveBlock(state: RailMatterState | undefined): string | undefined {
  if (state === 'running') return 'archive.blocked.running'
  if (state === 'awaiting') return 'archive.blocked.awaiting'
  return undefined
}

export function MatterMenu({
  title,
  state,
  onArchive,
}: {
  title: string
  state: RailMatterState
  onArchive: () => void
}): ReactNode {
  const { t } = useApp()
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent): void => {
      if (box.current !== null && !box.current.contains(e.target as Node)) setOpen(false)
    }
    const esc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    globalThis.document?.addEventListener('mousedown', close)
    globalThis.document?.addEventListener('keydown', esc)
    return () => {
      globalThis.document?.removeEventListener('mousedown', close)
      globalThis.document?.removeEventListener('keydown', esc)
    }
  }, [open])
  const blocked = archiveBlock(state)
  return (
    <div ref={box} className="relative">
      <button
        type="button"
        aria-label={t('rail.matter.menu', { title })}
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid="rail-matter-menu"
        className={cn(
          'flex size-5 shrink-0 items-center justify-center rounded text-ws-muted-fg hover:bg-sidebar-accent hover:text-foreground focus-visible:opacity-100',
          !open && 'opacity-0 group-hover/thread:opacity-100',
        )}
        onClick={(e) => {
          e.preventDefault()
          e.stopPropagation()
          setOpen((v) => !v)
        }}
      >
        <MoreHorizontal aria-hidden className="size-3.5" />
      </button>
      {open ? (
        <div
          role="menu"
          className="absolute top-6 right-0 z-30 flex min-w-32 items-center gap-1 rounded-[10px] border border-ws-line bg-ws-card p-1 shadow-ws"
        >
          <button
            type="button"
            role="menuitem"
            data-testid="rail-matter-archive"
            disabled={blocked !== undefined}
            className="flex flex-1 items-center gap-1.5 rounded-md px-2 py-1 text-left text-[12.5px] hover:bg-muted disabled:text-ws-muted-fg disabled:hover:bg-transparent"
            onClick={() => {
              setOpen(false)
              onArchive()
            }}
          >
            <Archive aria-hidden className="size-3.5" />
            {t('archive.action')}
          </button>
          {blocked === undefined ? null : (
            <Hint text={t(blocked)} testId="rail-matter-archive-why" />
          )}
        </div>
      ) : null}
    </div>
  )
}
