/**
 * WP241 岗位页「工作」的小零件：状态图标、类别图标、「N 张卡等你」、职责胶囊、谁在做、弹层。
 *
 * 状态图标颜色 + 形状双编码（设计稿 README「我自己定的几处」，同 36 §7 的思路，色弱也分得开）：
 * 进行中 = 绿色半圆、卡住了 = 琥珀色圈加感叹号（WP244）、排着的 = 灰圈一横、等别人 = 蓝色虚线圈加钟、
 * 已完成 = 绿底勾。
 */
import type { PositionWorkGroup, PositionWorkItem } from '@agentsws/contracts'
import { AlarmClock, CalendarClock, Check, FolderClosed, SquareCheck } from 'lucide-react'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { InfoTip } from '@/components/design'
import { DutyIcon } from '@/components/role-icons/role-icon'
import { useApp } from '@/lib/app-context'

export function GroupIcon({
  group,
  size = 14,
}: {
  group: PositionWorkGroup
  size?: number
}): ReactNode {
  const { t } = useApp()
  const label = t(`pos2.group.${group}`)
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 16 16',
    'aria-label': label,
    role: 'img',
  }
  if (group === 'doing')
    return (
      <svg
        {...common}
        className="shrink-0 text-ws-good"
        data-testid="group-icon"
        data-group={group}
      >
        <title>{label}</title>
        <circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <path d="M8 1.75a6.25 6.25 0 0 1 0 12.5z" fill="currentColor" />
      </svg>
    )
  // WP244：卡住了 = 琥珀色圈里一个感叹号
  if (group === 'stuck')
    return (
      <svg
        {...common}
        className="shrink-0 text-ws-warn"
        data-testid="group-icon"
        data-group={group}
      >
        <title>{label}</title>
        <circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <path d="M8 4.6v4.2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        <circle cx="8" cy="11.2" r="0.95" fill="currentColor" />
      </svg>
    )
  if (group === 'queued')
    return (
      <svg
        {...common}
        className="shrink-0 text-ws-muted-fg"
        data-testid="group-icon"
        data-group={group}
      >
        <title>{label}</title>
        <circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <path d="M5 8h6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    )
  if (group === 'waiting')
    return (
      <svg
        {...common}
        className="shrink-0 text-ws-info"
        data-testid="group-icon"
        data-group={group}
      >
        <title>{label}</title>
        <circle
          cx="8"
          cy="8"
          r="6.25"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeDasharray="2.4 1.6"
        />
        <path
          d="M8 4.8V8l2 1.4"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </svg>
    )
  return (
    <span
      role="img"
      aria-label={label}
      data-testid="group-icon"
      data-group={group}
      className="inline-flex shrink-0 items-center justify-center rounded-full bg-ws-good text-background"
      style={{ width: size, height: size }}
    >
      <Check className="size-[70%]" strokeWidth={3} aria-hidden />
    </span>
  )
}

const KIND_ICON = {
  matter: FolderClosed,
  todo: SquareCheck,
  schedule: AlarmClock,
  post: CalendarClock,
} as const

/** 每行前面一个灰色小图标区分 事项 / 待办 / 定时 / 排期，悬停才说是什么。 */
export function KindIcon({ kind }: { kind: PositionWorkItem['kind'] }): ReactNode {
  const { t } = useApp()
  const Icon = KIND_ICON[kind]
  return (
    <InfoTip text={t(`pos2.kind.${kind}`)}>
      <Icon
        className="size-3.5 shrink-0 text-ws-muted-fg"
        aria-hidden
        data-testid="kind-icon"
        data-kind={kind}
      />
    </InfoTip>
  )
}

/** 行尾「N 张卡等你」：点了跳回卡片流翻到第一张（docs/54 §7.3）。 */
export function CardsBadge({
  item,
  onJump,
}: {
  item: PositionWorkItem
  onJump(card_id: string): void
}): ReactNode {
  const { t } = useApp()
  const first = item.card_ids[0]
  if (item.cards === 0 || first === undefined) return null
  return (
    <button
      type="button"
      data-testid="work-cards-badge"
      data-card={first}
      className="inline-flex h-5 shrink-0 items-center rounded-full bg-ws-warn-bg px-2 text-[11px] font-medium whitespace-nowrap text-ws-warn hover:underline"
      onClick={(e) => {
        e.stopPropagation()
        onJump(first)
      }}
    >
      {t('pos2.cards.badge', { n: item.cards })}
    </button>
  )
}

/** WP248（决策 79）：没做完、截止已过的待办——标题旁一个红色小标「已过期」。 */
export function OverdueBadge({ item }: { item: PositionWorkItem }): ReactNode {
  const { t } = useApp()
  if (item.overdue !== true) return null
  return (
    <span
      data-testid="work-overdue"
      className="inline-flex h-5 shrink-0 items-center rounded-full bg-ws-bad-bg px-2 text-[11px] font-medium whitespace-nowrap text-ws-bad"
    >
      {t('pos2.overdue')}
    </span>
  )
}

/**
 * WP244：行上「到哪了」那一格——卡住了先说缺什么（琥珀色），AI 答完了前面挂「待你看结果」，
 * 其余照旧是最近一句进展。
 */
export function ProgressText({
  item,
  fallback = '',
}: {
  item: PositionWorkItem
  fallback?: string
}): ReactNode {
  const { t } = useApp()
  if (item.stuck_reason !== undefined)
    return (
      <span className="text-ws-warn" data-testid="work-stuck-reason">
        {item.stuck_reason}
      </span>
    )
  return (
    <>
      {item.result_ready === true ? (
        <span
          className="mr-1.5 inline-flex h-4 items-center rounded-full bg-ws-good-bg px-1.5 text-[10.5px] font-medium text-ws-good"
          data-testid="work-result-ready"
        >
          {t('pos2.result_ready')}
        </span>
      ) : null}
      {item.progress ?? fallback}
    </>
  )
}

export function DutyChip({ item }: { item: PositionWorkItem }): ReactNode {
  if (item.role_id === undefined) return <span className="text-xs text-ws-muted-fg">—</span>
  return (
    <span
      className="inline-flex max-w-full min-w-0 items-center gap-1 rounded-md bg-ws-surface px-1.5 py-0.5 text-xs text-ws-muted-fg"
      data-testid="work-duty"
      data-role={item.role_id}
    >
      <DutyIcon role_id={item.role_id} size={13} />
      <span className="truncate">{item.role_name ?? item.role_id}</span>
    </span>
  )
}

/** 谁在做：AI / 你（待办的承诺人永远是人）。WP244：AI 做完了 / 卡住了的不说「AI 在做」。 */
export function WhoBadge({ item }: { item: PositionWorkItem }): ReactNode {
  const { t } = useApp()
  const mine = item.kind === 'todo'
  const aiText =
    item.group === 'stuck'
      ? t('pos2.who.ai_stuck')
      : item.group === 'done'
        ? t('pos2.who.ai_done')
        : t('pos2.who.ai')
  return (
    <InfoTip text={mine ? t('pos2.who.you') : aiText}>
      <span
        data-testid="work-who"
        data-who={mine ? 'you' : 'ai'}
        className={`inline-flex size-5 shrink-0 items-center justify-center rounded-full text-[9px] font-semibold ${mine ? 'bg-ws-warn-bg text-ws-warn' : 'bg-ws-good-bg text-ws-good'}`}
      >
        {mine ? '你' : 'AI'}
      </span>
    </InfoTip>
  )
}

/** 一个按钮 + 一块弹层（点外面收起）。不用 Radix 菜单：里面是多选，点一下不该关。 */
export function Pop({
  label,
  icon,
  testId,
  children,
  align = 'right',
  active = false,
}: {
  label: string
  icon?: ReactNode
  testId: string
  children: ReactNode
  align?: 'left' | 'right'
  active?: boolean
}): ReactNode {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (ref.current !== null && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])
  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        aria-expanded={open}
        data-testid={testId}
        className={`inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs hover:bg-accent ${active ? 'font-medium text-foreground' : 'text-muted-foreground'}`}
        onClick={() => {
          setOpen(!open)
        }}
      >
        {icon}
        {label}
      </button>
      {open ? (
        <div
          data-testid={`${testId}-panel`}
          className={`absolute top-8 z-30 min-w-[200px] rounded-xl border bg-popover p-2 text-sm text-popover-foreground shadow-lg ${align === 'right' ? 'right-0' : 'left-0'}`}
        >
          {children}
        </div>
      ) : null}
    </div>
  )
}

/** 弹层里的一个可选项（多选打勾 / 单选打点）。 */
export function PopOption({
  selected,
  onClick,
  children,
  testId,
}: {
  selected: boolean
  onClick(): void
  children: ReactNode
  testId?: string
}): ReactNode {
  return (
    <button
      type="button"
      aria-pressed={selected}
      {...(testId === undefined ? {} : { 'data-testid': testId })}
      className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs hover:bg-accent"
      onClick={onClick}
    >
      <span
        className={`inline-flex size-3.5 items-center justify-center rounded-[4px] border ${selected ? 'border-ws-brand bg-ws-brand text-background' : ''}`}
      >
        {selected ? <Check className="size-3" strokeWidth={3} aria-hidden /> : null}
      </span>
      {children}
    </button>
  )
}
