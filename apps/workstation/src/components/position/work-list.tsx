/**
 * WP241「工作」的列表视图（默认）：按 进行中 / 排着的 / 等别人 / 已完成（折叠）分组，
 * 也能按职责分或不分。一行：状态 · 类别 · 标题（+ N 张卡等你）· 最近进展 · 职责 · 截止 · 谁在做。
 *
 * 没有任何决定按钮（Luoye 10-06：工作管进度）。点标题进事项页；待办没挂事项就只是一行。
 */
import type { PositionWorkGroup, PositionWorkItem } from '@agentsws/contracts'
import { ChevronDown, ChevronRight, Plus } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { Link } from 'react-router-dom'
import { Hint } from '@/components/ui/hint'
import { Input } from '@/components/ui/input'
import { createTodoAt, type PositionWorkData } from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { dueTone, type GroupBy, groupItems, whenText } from '@/lib/position-work'
import { CardsBadge, DutyChip, GroupIcon, KindIcon, WhoBadge } from './work-bits'

const TONE_TEXT = { bad: 'text-ws-bad font-medium', warn: 'text-ws-warn font-medium' } as const

/** 标题：有事项就链到事项页。`wrap` = 看板卡片里折两行，列表 / 表格里一行省略。 */
export function ItemTitle({
  item,
  wrap = false,
}: {
  item: PositionWorkItem
  wrap?: boolean
}): ReactNode {
  const cls = wrap ? 'line-clamp-2 break-words' : 'min-w-0 truncate'
  return item.matter_id === undefined ? (
    <span className={cls} title={item.title}>
      {item.title}
    </span>
  ) : (
    <Link
      className={`${cls} hover:underline`}
      title={item.title}
      to={`/matters/${encodeURIComponent(item.matter_id)}`}
    >
      {item.title}
    </Link>
  )
}

export function DueText({ item, now }: { item: PositionWorkItem; now: Date }): ReactNode {
  const { t } = useApp()
  if (item.due_at === undefined) return <span className="text-ws-muted-fg">—</span>
  const tone = dueTone(item, now)
  return (
    <time
      dateTime={item.due_at}
      className={`ws-num whitespace-nowrap ${tone === undefined ? 'text-ws-muted-fg' : TONE_TEXT[tone]}`}
      data-tone={tone ?? 'none'}
    >
      {whenText(item.due_at, now, t)}
    </time>
  )
}

function Row({
  item,
  now,
  onJump,
}: {
  item: PositionWorkItem
  now: Date
  onJump(card_id: string): void
}): ReactNode {
  const { t } = useApp()
  return (
    <li
      data-testid="work-row"
      data-kind={item.kind}
      data-group={item.group}
      data-id={item.id}
      className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 border-b px-3 py-2 text-[13.5px] last:border-b-0 md:grid-cols-[auto_minmax(0,1.3fr)_minmax(0,1fr)_7.5rem_5.5rem_auto]"
    >
      <span className="flex items-center gap-2">
        <GroupIcon group={item.group} />
        <KindIcon kind={item.kind} />
      </span>
      <span className="flex min-w-0 items-center gap-2 font-medium">
        <ItemTitle item={item} />
        <CardsBadge item={item} onJump={onJump} />
      </span>
      <span
        className="col-start-2 row-start-2 min-w-0 truncate text-xs text-ws-muted-fg md:col-start-auto md:row-start-auto"
        title={item.progress}
      >
        {item.progress ?? (item.status === 'paused' ? t('pos2.set.schedules.paused') : '')}
      </span>
      <span className="hidden min-w-0 md:block">
        <DutyChip item={item} />
      </span>
      <span className="hidden text-right text-xs md:block">
        <DueText item={item} now={now} />
      </span>
      <span className="row-span-2 flex items-center justify-end gap-2 md:row-span-1">
        <span className="text-xs md:hidden">
          <DueText item={item} now={now} />
        </span>
        <WhoBadge item={item} />
      </span>
    </li>
  )
}

/** 「加一个待办」：一行输入，挂在选的那条职责上（默认第一条）。 */
export function AddTodo({
  duties,
  onAdded,
  compact = false,
}: {
  duties: PositionWorkData['duties']
  onAdded(): void
  compact?: boolean
}): ReactNode {
  const { t } = useApp()
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [duty, setDuty] = useState(duties[0]?.assignment_id ?? '')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  if (duties.length === 0) return null
  const save = async (): Promise<void> => {
    if (title.trim() === '' || busy) return
    setBusy(true)
    try {
      await createTodoAt(duty, { title: title.trim() })
      setTitle('')
      setError('')
      setOpen(false)
      onAdded()
    } catch (err) {
      setError(t('pos2.todo.error', { message: err instanceof Error ? err.message : String(err) }))
    } finally {
      setBusy(false)
    }
  }
  if (!open)
    return (
      <button
        type="button"
        data-testid="work-add-todo"
        className={
          compact
            ? 'inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground hover:bg-accent'
            : 'flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-ws-muted-fg hover:bg-accent'
        }
        onClick={() => {
          setOpen(true)
        }}
      >
        <Plus className="size-3.5" aria-hidden />
        {compact ? t('pos2.todo.add.short') : t('pos2.todo.add')}
      </button>
    )
  return (
    <div className="flex flex-col gap-1 px-3 py-2" data-testid="work-add-todo-form">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          autoFocus
          value={title}
          className="h-7 min-w-[12rem] flex-1 text-sm"
          placeholder={t('pos2.todo.placeholder')}
          aria-label={t('pos2.todo.placeholder')}
          data-testid="work-add-todo-input"
          onChange={(e) => {
            setTitle(e.target.value)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void save()
            if (e.key === 'Escape') setOpen(false)
          }}
        />
        {duties.length > 1 ? (
          <label className="flex items-center gap-1 text-xs text-muted-foreground">
            {t('pos2.todo.duty')}
            <select
              className="rounded-md border bg-transparent px-1.5 py-0.5 text-xs text-foreground"
              value={duty}
              onChange={(e) => {
                setDuty(e.target.value)
              }}
            >
              {duties.map((d) => (
                <option key={d.assignment_id} value={d.assignment_id}>
                  {d.role_name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <button
          type="button"
          data-testid="work-add-todo-save"
          disabled={title.trim() === '' || busy}
          className="h-7 rounded-md bg-primary px-2.5 text-xs text-primary-foreground disabled:opacity-50"
          onClick={() => {
            void save()
          }}
        >
          {t('pos2.todo.save')}
        </button>
        <button
          type="button"
          className="h-7 rounded-md px-2 text-xs text-muted-foreground hover:bg-accent"
          onClick={() => {
            setOpen(false)
          }}
        >
          {t('pos2.todo.cancel')}
        </button>
      </div>
      {error === '' ? null : (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}

export function WorkList({
  items,
  groupBy,
  data,
  now,
  onJump,
  onAdded,
}: {
  items: readonly PositionWorkItem[]
  groupBy: GroupBy
  data: PositionWorkData
  now: Date
  onJump(card_id: string): void
  onAdded(): void
}): ReactNode {
  const { t } = useApp()
  // 已完成默认折叠；别的组默认展开
  const [closed, setClosed] = useState<Set<string>>(new Set(['done']))
  const groups = groupItems(
    items,
    groupBy,
    data.duties.map((d) => d.role_id),
  )
  const titleOf = (id: string): string => {
    if (groupBy === 'status') return t(`pos2.group.${id}`)
    if (groupBy === 'none') return t('pos2.group.none')
    if (id === 'none') return t('pos2.group.noduty')
    return data.duties.find((d) => d.role_id === id)?.role_name ?? id
  }
  return (
    <div className="flex flex-col gap-4" data-testid="work-list">
      {groups.map((g, index) => {
        // 按状态分时空组不画（「已完成」除外也一样：没有就不出）
        if (g.items.length === 0 && !(groupBy === 'status' && g.id === 'doing')) return null
        const isClosed = closed.has(g.id)
        const addHere = groupBy === 'status' ? g.id === 'doing' : index === 0
        return (
          <section key={g.id} data-testid="work-group" data-group={g.id}>
            <h4 className="mb-1.5 flex items-center gap-1.5 px-1 text-sm font-medium">
              <button
                type="button"
                aria-expanded={!isClosed}
                data-testid="work-group-toggle"
                className="inline-flex items-center gap-1.5"
                onClick={() => {
                  const next = new Set(closed)
                  if (isClosed) next.delete(g.id)
                  else next.add(g.id)
                  setClosed(next)
                }}
              >
                {isClosed ? (
                  <ChevronRight className="size-3.5 text-ws-muted-fg" aria-hidden />
                ) : (
                  <ChevronDown className="size-3.5 text-ws-muted-fg" aria-hidden />
                )}
                {groupBy === 'status' ? <GroupIcon group={g.id as PositionWorkGroup} /> : null}
                {titleOf(g.id)}
              </button>
              {groupBy === 'status' ? (
                <Hint
                  text={t(`pos2.group.${g.id}.hint`, { n: data.done_window_days })}
                  testId={`work-group-hint-${g.id}`}
                />
              ) : null}
              <span className="ws-num text-xs font-normal text-ws-muted-fg">{g.items.length}</span>
            </h4>
            {isClosed ? null : (
              <div className="overflow-hidden rounded-xl border bg-card">
                <ul>
                  {g.items.map((item) => (
                    <Row key={item.id} item={item} now={now} onJump={onJump} />
                  ))}
                </ul>
                {addHere ? (
                  <div className={g.items.length === 0 ? '' : 'border-t'}>
                    <AddTodo duties={data.duties} onAdded={onAdded} />
                  </div>
                ) : null}
              </div>
            )}
          </section>
        )
      })}
    </div>
  )
}
