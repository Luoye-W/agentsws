/**
 * WP209：技能页 / 知识库页 / 第三栏共用的三样小件——**一组**（可折叠、带计数）、
 * **搜索框**、**筛选芯片**。
 *
 * 36 §7 少字：组头只有「名字 + 数字 + 箭头」；为什么这么分进问号（`hint`）。
 */
import { ChevronDown, Search } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { Hint } from '@/components/ui/hint'
import { Input } from '@/components/ui/input'
import { useApp } from '@/lib/app-context'
import { cn } from '@/lib/utils'

export function LibraryGroup({
  id,
  title,
  count,
  defaultOpen = true,
  forceOpen = false,
  hint,
  level = 1,
  children,
}: {
  id: string
  title: string
  count: number
  defaultOpen?: boolean
  /** 搜索 / 筛选生效时一律摊开：结果不能藏在一个收着的组里。 */
  forceOpen?: boolean
  hint?: string
  /** 1 = 页面上的组；2 = 组里的组（「没开的岗位」里那几个）。 */
  level?: 1 | 2
  children: ReactNode
}): ReactNode {
  const { t } = useApp()
  const [open, setOpen] = useState(defaultOpen)
  const shown = forceOpen || open
  return (
    <section
      data-testid="library-group"
      data-group={id}
      data-open={shown ? 'yes' : 'no'}
      className="flex flex-col gap-2"
    >
      <div className="flex items-center gap-1">
        <button
          type="button"
          aria-expanded={shown}
          aria-label={`${title} · ${t('library.group.toggle')}`}
          data-testid="library-group-toggle"
          className={cn(
            'flex min-w-0 items-center gap-1.5 rounded-md py-1 text-left hover:text-ws-ink',
            level === 1 ? 'text-sm font-semibold text-ws-ink' : 'text-sm text-ws-body',
          )}
          onClick={() => {
            setOpen(!shown)
          }}
        >
          <ChevronDown
            aria-hidden
            className={cn('size-4 shrink-0 transition-transform', !shown && '-rotate-90')}
          />
          <span className="truncate">{title}</span>
          <span
            data-testid="library-group-count"
            className="rounded-full bg-ws-surface px-1.5 text-xs font-normal text-ws-muted-fg"
          >
            {count}
          </span>
        </button>
        {hint === undefined ? null : <Hint text={hint} />}
      </div>
      {shown ? children : null}
    </section>
  )
}

export function LibrarySearch({
  value,
  onChange,
  testId = 'library-search',
}: {
  value: string
  onChange(next: string): void
  testId?: string
}): ReactNode {
  const { t } = useApp()
  return (
    <div className="relative min-w-0 flex-1 sm:max-w-xs">
      <Search
        aria-hidden
        className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-ws-muted-fg"
      />
      <Input
        type="search"
        value={value}
        data-testid={testId}
        aria-label={t('library.search')}
        placeholder={t('library.search')}
        className="bg-ws-card pl-8"
        onChange={(e) => {
          onChange(e.target.value)
        }}
      />
    </div>
  )
}

/** 一个开关芯片（`aria-pressed`）。`count` 给了就在后面跟一个数。 */
export function FilterChip({
  active,
  onClick,
  count,
  testId,
  children,
}: {
  active: boolean
  onClick(): void
  count?: number
  testId?: string
  children: ReactNode
}): ReactNode {
  return (
    <button
      type="button"
      aria-pressed={active}
      data-testid={testId}
      className={cn(
        'inline-flex h-7 items-center gap-1 rounded-full px-3 text-xs transition-colors',
        active
          ? 'bg-ws-tint font-medium text-ws-brand-ink'
          : 'bg-ws-surface text-ws-body hover:text-ws-ink',
      )}
      onClick={onClick}
    >
      {children}
      {count === undefined ? null : <span className="text-ws-muted-fg">{count}</span>}
    </button>
  )
}
