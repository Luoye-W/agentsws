/**
 * WP207：职责行下面挂着的「正在进行的对话 / 任务」。
 *
 * 一行一件：状态小点 + 标题，点进去就是那件事（`/matters/:id`）。按最近活动排（服务端排好的），
 * 默认 5 条，多的收在「更多」后面；最底下一行「已归档（n）」打开归档列表（筛好这条职责）。
 *
 * 状态小点是**图形不是字**（36 减字）：在跑 = 品牌色、会呼吸；等你批 = 琥珀；
 * 做完待看 = 绿；都不是 = 不画。点的意思写在 `title` 与读屏文字里。
 */
import { cn } from 'cn'
import { Archive } from 'lucide-react'
import type { ReactNode } from 'react'
import { NavLink } from 'react-router-dom'
import { useApp } from '@/lib/app-context'
import type { RailDuty, RailMatterState } from '@/lib/work-archive'

const DOT: Record<Exclude<RailMatterState, 'idle'>, string> = {
  running: 'bg-ws-brand animate-pulse motion-reduce:animate-none',
  awaiting: 'bg-ws-warn',
  ready: 'bg-ws-good',
}

export function StateDot({ state }: { state: RailMatterState }): ReactNode {
  const { t } = useApp()
  if (state === 'idle') return <i aria-hidden className="size-1.5 shrink-0" />
  const label = t(`rail.state.${state}`)
  return (
    <i
      role="img"
      aria-label={label}
      title={label}
      data-testid="rail-matter-dot"
      data-state={state}
      className={cn('size-1.5 shrink-0 rounded-full', DOT[state])}
    />
  )
}

/** 左栏每条职责下默认列几条（Luoye 09-30：默认最多 5 条 +「更多」）。 */
export const RAIL_SHOWN = 5
/** 一次向服务端要几条（「更多」点开时就地展开，不再重取）。 */
export const RAIL_FETCH = 20

export function DutyThreads({
  duty,
  expanded,
  onMore,
  onArchived,
}: {
  duty: RailDuty
  /** 「更多」点开了没有。 */
  expanded: boolean
  onMore: () => void
  onArchived: () => void
}): ReactNode {
  const { t } = useApp()
  if (duty.matters.length === 0 && duty.archived === 0) return null
  const shown = expanded ? duty.matters : duty.matters.slice(0, RAIL_SHOWN)
  const hidden = duty.matters.length - shown.length + duty.more
  return (
    <ul
      className="ml-3 flex flex-col gap-px border-l border-ws-line pl-1.5"
      data-testid="rail-threads"
    >
      {shown.map((m) => (
        <li key={m.id}>
          <NavLink
            to={`/matters/${encodeURIComponent(m.id)}`}
            data-testid="rail-matter"
            data-state={m.state}
            className={({ isActive }) =>
              cn(
                'flex items-center gap-1.5 rounded-[8px] px-1.5 py-1 text-[12.5px] transition-colors',
                isActive
                  ? 'bg-sidebar-accent font-medium text-sidebar-accent-foreground'
                  : 'text-ws-body hover:bg-sidebar-accent/60',
              )
            }
          >
            <StateDot state={m.state} />
            <span className="truncate">{m.title}</span>
          </NavLink>
        </li>
      ))}
      {hidden === 0 && !expanded ? null : (
        <li>
          <button
            type="button"
            data-testid="rail-more"
            className="w-full rounded-[8px] px-1.5 py-0.5 text-left text-[12px] text-ws-muted-fg hover:bg-sidebar-accent/60 hover:text-foreground"
            onClick={onMore}
          >
            {expanded ? t('rail.less') : t('rail.more', { n: hidden })}
          </button>
        </li>
      )}
      {duty.archived === 0 ? null : (
        <li>
          <button
            type="button"
            data-testid="rail-archived"
            className="flex w-full items-center gap-1.5 rounded-[8px] px-1.5 py-0.5 text-left text-[12px] text-ws-muted-fg hover:bg-sidebar-accent/60 hover:text-foreground"
            onClick={onArchived}
          >
            <Archive aria-hidden className="size-3 shrink-0" />
            {t('rail.archived', { n: duty.archived })}
          </button>
        </li>
      )}
    </ul>
  )
}
