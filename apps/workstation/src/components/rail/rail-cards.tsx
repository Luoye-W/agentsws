/**
 * WP372（决策 1004 / 1005 / 1019，Luoye 10-17，学 Claude 桌面版右侧那一栏）：右侧面板的**卡片堆**。
 *
 * - 六张卡纵向排：标题行（图标、名字、状态点；收起时右边一句摘要）点一下展开 / 收起，按作用域记住；
 * - 展开后最多 5 条（WP433：原来 4 条），多于 5 条时卡底才有「显示更多」，开完整列表（卡的 `panel`）或那一页（`moreHref`）；
 * - **拖动排序**（决策 1005）：鼠标移到卡片右上角出六点手柄 ⠿，按住拖；键盘落到手柄上按空格拿起、
 *   方向键挪、再按空格放下（dnd-kit 自带的键盘传感器与读屏播报）。顺序按人记住、全部岗位一份；
 * - 被点名的那张（右上角图标、连接卡弹出）滚到可见处。
 *
 * WP375（决策 1035）：标题行照 Claude 桌面版——标题后面紧贴展开箭头与状态点，最右靠右是摘要（展开 / 收起都在）；
 * 鼠标移到卡上，最右那一截换成六点手柄（摘要让位）。不带图标。
 *
 * 卡身体是 `lazy()`：收着的卡一个字节都不下载，标题行只调注册表那个轻的 `useStatus`。
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
import { ChevronDown, ChevronRight, GripVertical } from 'lucide-react'
import { type ReactNode, Suspense, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ErrorBoundary } from '@/components/error-boundary'
import { cardOpen, useRailState } from '@/components/rail/rail-state'
import {
  CARD_LIMIT,
  type CardStatus,
  listRailCards,
  type RailCardDefinition,
  type RailPanelBodyProps,
  railCardBody,
} from '@/components/rail/registry'
import { useApp } from '@/lib/app-context'
import { cn } from '@/lib/utils'

const noStatus = (_p: RailPanelBodyProps, _d: boolean): CardStatus | undefined => undefined

/** 标题行与图标上那个点（红 = 坏了要修，黄 = 等你看）。 */
export function StatusDot({
  status,
  testId,
}: {
  status: CardStatus | undefined
  testId: string
}): ReactNode {
  if (status?.dot === undefined) return null
  return (
    <i
      role="img"
      aria-label={status.dotLabel ?? ''}
      title={status.dotLabel}
      data-testid={testId}
      data-dot={status.dot}
      className={cn(
        'size-1.5 shrink-0 rounded-full',
        status.dot === 'alert' ? 'bg-ws-bad' : 'bg-ws-warn',
      )}
    />
  )
}

export function RailCards(props: RailPanelBodyProps): ReactNode {
  const rail = useRailState()
  const { t } = useApp()
  const cards = listRailCards(rail.order)
  const sensors = useSensors(
    // 按下挪 6px 才算拖（点一下手柄不至于误拖）
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )
  const ids = cards.map((c) => c.id)
  const nameOf = (id: string | number): string => {
    const c = cards.find((x) => x.id === id)
    return c === undefined ? String(id) : t(c.label)
  }
  const onDragEnd = (e: DragEndEvent): void => {
    const over = e.over?.id
    if (over === undefined || over === e.active.id) return
    const from = ids.indexOf(String(e.active.id))
    const to = ids.indexOf(String(over))
    if (from < 0 || to < 0) return
    rail.setOrder(arrayMove(ids, from, to))
  }
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={onDragEnd}
      accessibility={{
        announcements: {
          onDragStart: ({ active }) => t('rail.card.drag', { name: nameOf(active.id) }),
          onDragOver: ({ active, over }) =>
            over === null
              ? ''
              : t('rail.card.moved', {
                  name: nameOf(active.id),
                  n: ids.indexOf(String(over.id)) + 1,
                }),
          onDragEnd: ({ active, over }) =>
            over === null
              ? ''
              : t('rail.card.moved', {
                  name: nameOf(active.id),
                  n: ids.indexOf(String(over.id)) + 1,
                }),
          onDragCancel: () => '',
        },
        screenReaderInstructions: { draggable: t('rail.card.drag', { name: '' }) },
      }}
    >
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        <div className="flex flex-col gap-2" data-testid="rail-cards" data-order={ids.join(',')}>
          {cards.map((card) => (
            <SortableCard key={card.id} card={card} body={props} />
          ))}
        </div>
      </SortableContext>
    </DndContext>
  )
}

function SortableCard({
  card,
  body,
}: {
  card: RailCardDefinition
  body: RailPanelBodyProps
}): ReactNode {
  const { t } = useApp()
  const rail = useRailState()
  const navigate = useNavigate()
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: card.id })
  const useStatus = card.useStatus ?? noStatus
  const status = useStatus(body, true)
  const open = cardOpen(rail.cards, card.id)
  const Body = railCardBody(card.id)
  const name = t(card.label)
  const box = useRef<HTMLElement | null>(null)
  const focused = rail.focus === card.id
  useEffect(() => {
    if (focused) box.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' })
  }, [focused])
  const Chevron = open ? ChevronDown : ChevronRight
  // WP433（问题 7）：卡身体报上来的总条数；多于 CARD_LIMIT 才出「显示更多」
  const [total, setTotal] = useState<number | undefined>(undefined)
  const hasMore = total !== undefined && total > CARD_LIMIT
  const more = (): void => {
    if (card.panel !== undefined) rail.show(card.panel)
    else if (card.moreHref !== undefined) void navigate(card.moreHref)
  }
  return (
    <section
      ref={(el) => {
        setNodeRef(el)
        box.current = el
      }}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        'group/card relative rounded-[12px] border border-ws-line bg-ws-card transition-shadow hover:shadow-ws',
        isDragging && 'z-10 shadow-ws-hover',
        focused && 'ring-1 ring-ws-brand/40',
      )}
      data-testid={`rail-card-${card.id}`}
      data-open={open ? 'true' : 'false'}
    >
      {/*
        WP375（决策 1035，照 Claude 桌面版）：标题行 = 标题 + 紧贴着的展开箭头 + 状态点，最右靠右是摘要。
        整行点一下展开 / 收起；鼠标移到卡上时最右那一截换成拖动手柄（摘要让位）。
      */}
      <button
        type="button"
        aria-expanded={open}
        aria-label={t(open ? 'rail.card.collapse' : 'rail.card.expand', { name })}
        data-testid={`rail-card-toggle-${card.id}`}
        className="flex w-full min-w-0 items-center gap-1 rounded-[12px] py-2.5 pr-3 pl-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={() => {
          rail.setCardOpen(card.id, !open)
        }}
      >
        <span
          className="shrink-0 text-[13px] font-medium text-ws-ink"
          data-testid="rail-card-title"
        >
          {name}
        </span>
        <Chevron
          aria-hidden
          data-testid={`rail-card-chevron-${card.id}`}
          className="size-3.5 shrink-0 text-ws-muted-fg"
        />
        <StatusDot status={status} testId={`rail-card-dot-${card.id}`} />
        <span
          className="ml-auto min-w-0 truncate pl-2 text-[12px] text-ws-muted-fg transition-opacity group-focus-within/card:opacity-0 group-hover/card:opacity-0"
          data-testid={`rail-card-summary-${card.id}`}
        >
          {status?.summary ?? ''}
        </span>
      </button>
      {/* 决策 1005 / 1035：六点手柄只在鼠标移到卡上（或键盘落到它）时出现在最右；Tab 照样落得到 */}
      <button
        type="button"
        ref={setActivatorNodeRef}
        aria-label={t('rail.card.drag', { name })}
        title={t('rail.card.drag', { name })}
        data-testid={`rail-card-handle-${card.id}`}
        className="absolute top-2 right-2 flex size-6 cursor-grab touch-none items-center justify-center rounded-md text-ws-muted-fg opacity-0 transition-opacity group-hover/card:opacity-100 hover:bg-sidebar-accent focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-ring active:cursor-grabbing"
        {...attributes}
        {...listeners}
      >
        <GripVertical aria-hidden className="size-3.5" />
      </button>
      {open ? (
        <div
          className="flex flex-col gap-1 px-1.5 pb-2.5"
          data-testid={`rail-card-body-${card.id}`}
        >
          {Body === undefined ? null : (
            <ErrorBoundary scope="panel" label={`card:${card.id}`} resetKey={card.id}>
              <Suspense fallback={null}>
                <Body {...body} limit={CARD_LIMIT} onMore={more} onTotal={setTotal} />
              </Suspense>
            </ErrorBoundary>
          )}
          {!hasMore || (card.panel === undefined && card.moreHref === undefined) ? null : (
            <button
              type="button"
              data-testid={`rail-card-more-${card.id}`}
              className="ws-link-muted self-start px-1.5 py-0.5 text-[12px]"
              onClick={more}
            >
              {t('rail.card.more')}
            </button>
          )}
        </div>
      ) : null}
    </section>
  )
}
