/**
 * 右侧抽屉（两个旧后台的共同做法，照搬）。
 *
 * 为什么不做独立详情页：点一个人看一眼、回到表上接着看下一个——独立页会把
 * 列表的滚动位置、筛选与分页全丢掉，而运营的动作几乎全是"在一批人里挑"。
 *
 * Esc 关、点遮罩关、打开时焦点进抽屉。没有上 Radix：这里只有一个抽屉，
 * 为它拉一层依赖不值得。
 */

import { X } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { useApp } from '@/lib/app'

export function Drawer({
  open,
  title,
  subtitle,
  onClose,
  children,
  footer,
}: {
  open: boolean
  title: string
  subtitle?: string | undefined
  onClose: () => void
  children: React.ReactNode
  footer?: React.ReactNode
}): React.ReactNode {
  const { t } = useApp()
  const panel = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    panel.current?.focus()
    return () => {
      document.removeEventListener('keydown', onKey)
    }
  }, [open, onClose])

  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex justify-end" data-testid="drawer">
      <button
        type="button"
        aria-label={t('drawer.close')}
        className="absolute inset-0 bg-black/25"
        onClick={onClose}
      />
      <div
        ref={panel}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="relative flex h-full w-full max-w-[520px] flex-col bg-ws-card shadow-ws-hover outline-none"
      >
        <header className="flex items-start justify-between gap-3 border-ws-line border-b px-5 py-4">
          <div className="min-w-0">
            <h2 className="ws-display truncate text-[16px] text-ws-ink">{title}</h2>
            {subtitle !== undefined && (
              <p className="mt-0.5 truncate text-xs text-ws-muted-fg">{subtitle}</p>
            )}
          </div>
          <button
            type="button"
            aria-label={t('drawer.close')}
            onClick={onClose}
            className="rounded-lg p-1 text-ws-muted-fg hover:bg-ws-surface hover:text-ws-ink"
          >
            <X className="size-4" aria-hidden />
          </button>
        </header>
        <div className="flex-1 overflow-auto px-5 py-4">{children}</div>
        {footer !== undefined && (
          <footer className="border-ws-line border-t px-5 py-3">{footer}</footer>
        )}
      </div>
    </div>
  )
}

/** 抽屉里那种「名字 : 值」两列。值是数字就给它 `ws-num`，列才对得齐。 */
export function KeyValues({
  rows,
}: {
  rows: { label: string; value: React.ReactNode }[]
}): React.ReactNode {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-[13px]">
      {rows.map((row) => (
        <div key={row.label} className="contents">
          <dt className="text-ws-muted-fg">{row.label}</dt>
          <dd className="ws-num min-w-0 break-words text-ws-ink">{row.value}</dd>
        </div>
      ))}
    </dl>
  )
}

export function DrawerSection({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}): React.ReactNode {
  return (
    <section className="mt-5 first:mt-0">
      <h3 className="mb-2 font-semibold text-[12px] text-ws-muted-fg uppercase tracking-wide">
        {title}
      </h3>
      {children}
    </section>
  )
}
