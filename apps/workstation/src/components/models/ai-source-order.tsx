/**
 * WP430（决策 1288）：「AI 来源」里自己配的那几条——**按顺序接**，可拖动排序。
 *
 * 这次选的用不了（额度用完 / 连不上 / 登录或 key 失效）时，按这里的顺序往下接，最后才是工坊积分（开关开着才有）。
 * 没测过 / 测没过的 key 灰着（不会被自动接上），问号里说为什么。
 *
 * 只是数据与排序这一小块：视觉由设置 → 模型的整页重做（WP426）接上——接口是
 * `<AiSourceOrder own={view.own} busy onReorder={(ids) => setModelDefaults({ source_order: ids })} />`。
 * 拖法与右栏卡片同一套（dnd-kit；键盘落到手柄上按空格拿起、方向键挪、再按空格放下）。
 */
import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { GripVertical } from 'lucide-react'
import type { ReactNode } from 'react'
import { Hint } from '@/components/ui/hint'
import type { ModelAiSourceView } from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { cn } from '@/lib/utils'

type OwnSource = ModelAiSourceView['own'][number]

export function AiSourceOrder({
  own,
  busy,
  onReorder,
}: {
  own: readonly OwnSource[]
  busy: boolean
  /** 拖完之后的新顺序（provider id）。 */
  onReorder: (ids: string[]) => void
}): ReactNode {
  const { t } = useApp()
  const sensors = useSensors(
    // 按下挪 6px 才算拖（点一下手柄不至于误拖）
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )
  const ids = own.map((o) => o.provider_id)
  const nameOf = (id: string | number): string =>
    own.find((o) => o.provider_id === id)?.label ?? String(id)
  const onDragEnd = (e: DragEndEvent): void => {
    const over = e.over?.id
    if (busy || over === undefined || over === e.active.id) return
    const from = ids.indexOf(String(e.active.id))
    const to = ids.indexOf(String(over))
    if (from < 0 || to < 0) return
    onReorder(arrayMove(ids, from, to))
  }
  const moved = (active: string | number, over: string | number): string =>
    t('models.ai_source.moved', { name: nameOf(active), n: ids.indexOf(String(over)) + 1 })
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={onDragEnd}
      accessibility={{
        announcements: {
          onDragStart: ({ active }) => t('models.ai_source.drag', { name: nameOf(active.id) }),
          onDragOver: ({ active, over }) => (over === null ? '' : moved(active.id, over.id)),
          onDragEnd: ({ active, over }) => (over === null ? '' : moved(active.id, over.id)),
          onDragCancel: () => '',
        },
        screenReaderInstructions: { draggable: t('models.ai_source.drag', { name: '' }) },
      }}
    >
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        <ol
          className="flex flex-col gap-1"
          data-testid="model-ai-source-own"
          data-order={ids.join(',')}
        >
          {own.map((o, i) => (
            <OwnRow key={o.provider_id} source={o} index={i} />
          ))}
        </ol>
      </SortableContext>
    </DndContext>
  )
}

function OwnRow({ source, index }: { source: OwnSource; index: number }): ReactNode {
  const { t } = useApp()
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: source.provider_id })
  // 老服务端没有 `ready` 这一格：当作能接
  const ready = source.ready !== false
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        'flex items-center gap-1.5 rounded-md border bg-background px-1.5 py-1 text-xs',
        isDragging && 'z-10 shadow-sm',
      )}
      data-testid={`model-ai-source-row-${source.provider_id}`}
      data-ready={ready ? 'true' : 'false'}
    >
      <button
        type="button"
        ref={setActivatorNodeRef}
        {...attributes}
        {...listeners}
        aria-label={t('models.ai_source.drag', { name: source.label })}
        className="shrink-0 cursor-grab rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing"
        data-testid={`model-ai-source-handle-${source.provider_id}`}
      >
        <GripVertical className="size-3.5" aria-hidden />
      </button>
      <span className="w-3 shrink-0 text-right tabular-nums text-muted-foreground">
        {index + 1}
      </span>
      <span className={cn('min-w-0 flex-1 truncate', !ready && 'text-muted-foreground')}>
        {source.label}
      </span>
      {ready ? null : <Hint text={t('models.ai_source.not_ready')} />}
    </li>
  )
}
