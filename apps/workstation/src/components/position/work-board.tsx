/**
 * WP241「工作」的看板视图：一列一个分组（WP244：「卡住了」那列只在有东西时出）。
 *
 * 拖动按 `canMoveWorkItem`（`@agentsws/contracts`，docs/54 §7.3）：**只有待办能拖**，
 * 在「进行中 / 等别人 / 已完成」之间拖，改的是待办自己的状态（`PUT /v1/todos/:id`）；
 * 事项 / 定时 / 排期拿着不动，悬停说为什么。拖动之后整份工作重取，不在前端改本地数据。
 */
import {
  canMoveWorkItem,
  POSITION_WORK_GROUPS,
  type PositionWorkGroup,
  type PositionWorkItem,
  todoStatusForGroup,
} from '@agentsws/contracts'
import { type ReactNode, useState } from 'react'
import { setTodoStatus } from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { CardsBadge, DutyChip, GroupIcon, KindIcon, ProgressText } from './work-bits'
import { DueText, ItemTitle } from './work-list'

const DRAG_TYPE = 'application/x-agentsws-work-item'

export function WorkBoard({
  items,
  now,
  onJump,
  onMoved,
}: {
  items: readonly PositionWorkItem[]
  now: Date
  onJump(card_id: string): void
  onMoved(): void
}): ReactNode {
  const { t } = useApp()
  const [dragging, setDragging] = useState<PositionWorkItem | undefined>(undefined)
  const [over, setOver] = useState<PositionWorkGroup | undefined>(undefined)
  const [error, setError] = useState('')

  // WP244：「卡住了」那一列只在有东西时出（它只收事项，空着摆一列只是占地方）
  const columns = POSITION_WORK_GROUPS.filter(
    (g) => g !== 'stuck' || items.some((i) => i.group === 'stuck'),
  )

  const move = async (item: PositionWorkItem, to: PositionWorkGroup): Promise<void> => {
    if (!canMoveWorkItem(item, to)) return
    try {
      await setTodoStatus(item.ref_id, todoStatusForGroup(to) as 'doing' | 'blocked' | 'done')
      setError('')
      onMoved()
    } catch (err) {
      setError(t('pos2.board.error', { message: err instanceof Error ? err.message : String(err) }))
    }
  }

  return (
    <div className="flex flex-col gap-2" data-testid="work-board">
      {error === '' ? null : (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      <div
        className={`grid grid-cols-1 gap-3 sm:grid-cols-2 ${columns.length > 4 ? 'lg:grid-cols-5' : 'lg:grid-cols-4'}`}
      >
        {columns.map((g) => {
          const col = items.filter((i) => i.group === g)
          const accepts = dragging !== undefined && canMoveWorkItem(dragging, g)
          return (
            <section
              key={g}
              data-testid="work-board-column"
              data-group={g}
              data-accepts={accepts ? 'true' : 'false'}
              title={
                dragging?.kind === 'todo' && g === 'queued'
                  ? t('pos2.board.queued_locked')
                  : undefined
              }
              className={`flex min-h-24 flex-col gap-2 rounded-xl bg-ws-surface p-2 transition-colors ${over === g && accepts ? 'ring-2 ring-ws-brand/50' : ''} ${dragging !== undefined && !accepts && dragging.group !== g ? 'opacity-60' : ''}`}
              onDragOver={(e) => {
                if (!accepts) return
                e.preventDefault()
                setOver(g)
              }}
              onDragLeave={() => {
                setOver(undefined)
              }}
              onDrop={(e) => {
                e.preventDefault()
                setOver(undefined)
                const item = dragging
                setDragging(undefined)
                if (item !== undefined) void move(item, g)
              }}
            >
              <h4 className="flex items-center gap-1.5 px-1 pt-1 text-sm font-medium">
                <GroupIcon group={g} />
                {t(`pos2.group.${g}`)}
                <span className="ws-num text-xs font-normal text-ws-muted-fg">{col.length}</span>
              </h4>
              {col.map((item) => {
                const lockedText = t('pos2.board.locked')
                return (
                  <article
                    key={item.id}
                    data-testid="work-board-card"
                    data-id={item.id}
                    data-movable={item.movable ? 'true' : 'false'}
                    draggable={item.movable}
                    title={item.movable ? undefined : lockedText}
                    className={`flex flex-col gap-1.5 rounded-lg border bg-card p-2.5 text-[13px] shadow-xs ${item.movable ? 'cursor-grab active:cursor-grabbing' : ''}`}
                    onDragStart={(e) => {
                      if (!item.movable) return
                      e.dataTransfer.setData(DRAG_TYPE, item.id)
                      e.dataTransfer.effectAllowed = 'move'
                      setDragging(item)
                    }}
                    onDragEnd={() => {
                      setDragging(undefined)
                      setOver(undefined)
                    }}
                  >
                    <div className="flex items-start gap-1.5 font-medium">
                      <KindIcon kind={item.kind} />
                      <span className="min-w-0 flex-1 leading-snug">
                        <ItemTitle item={item} wrap />
                      </span>
                    </div>
                    {item.cards > 0 ? (
                      <div>
                        <CardsBadge item={item} onJump={onJump} />
                      </div>
                    ) : null}
                    {item.progress === undefined &&
                    item.stuck_reason === undefined &&
                    item.result_ready !== true ? null : (
                      <p className="truncate text-xs text-ws-muted-fg">
                        <ProgressText item={item} />
                      </p>
                    )}
                    <div className="flex items-center justify-between gap-2 text-xs">
                      <span className="min-w-0">
                        <DutyChip item={item} />
                      </span>
                      <DueText item={item} now={now} />
                    </div>
                  </article>
                )
              })}
            </section>
          )
        })}
      </div>
    </div>
  )
}
