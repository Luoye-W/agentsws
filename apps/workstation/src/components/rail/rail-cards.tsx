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
 *
 * WP456-T3（规范 §2.6 第 14 条、§3.9，决策 1448）：
 * - 卡无边框、圆角 16、卡阴影（深色带细边）；卡头 13/600 + 灰色计数，**右边只放一个图标**：
 *   有动作的放动作（对话「+」新对话、报表「+」做一份），没有的放「›」= 在第三栏开完整一格；
 *   标题后面不再跟「⌄ / ›」；收着时右边写一句摘要。点卡头照旧展开 / 收起。
 * - 只有一行标题的那几张（产出 / 连接 / 设定 / 工坊服务，注册时标 `list`）合成最底下一张**清单卡**：
 *   每行「名字 + 右边一句状态（红点在数字前）+ ›」，点了在第三栏开它的完整一格。清单卡不参与拖动。
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
import { ChevronRight, GripVertical } from 'lucide-react'
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
  // WP504（决策 1778 A）：只在某些岗位出的卡（库卡）按这一页的岗位筛
  const all = listRailCards(rail.order).filter((c) => c.available?.(props) ?? true)
  // WP456-T3（决策 1448）：有内容的各占一张（可拖）；只有一行标题的合进最底下那张清单卡
  const cards = all.filter((c) => c.list !== true)
  const listed = all.filter((c) => c.list === true)
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
    rail.setOrder([...arrayMove(ids, from, to), ...listed.map((c) => c.id)])
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
        <div
          className="flex flex-col gap-2.5"
          data-testid="rail-cards"
          data-order={[...ids, ...listed.map((c) => c.id)].join(',')}
        >
          {cards.map((card) => (
            <SortableCard key={card.id} card={card} body={props} />
          ))}
          {listed.length === 0 ? null : <RailListCard cards={listed} body={props} />}
        </div>
      </SortableContext>
    </DndContext>
  )
}

/** 卡头右边那一颗图标钮的样子（「+」「›」、拖动手柄同一种）。 */
const HEAD_ICON =
  'flex size-6 items-center justify-center rounded-md text-ws-muted-fg hover:bg-ws-hover hover:text-ws-ink focus-visible:outline-2 focus-visible:outline-ring'

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
  // WP433（问题 7）：卡身体报上来的总条数；多于 CARD_LIMIT 才出「显示更多」
  const [total, setTotal] = useState<number | undefined>(undefined)
  const hasMore = total !== undefined && total > CARD_LIMIT
  const more = (): void => {
    if (card.panel !== undefined) rail.show(card.panel)
    else if (card.moreHref !== undefined) void navigate(card.moreHref)
  }
  // WP456-T3：卡头右边只放一个图标——有动作放动作，没有就放「›」（在第三栏开完整一格）
  const action = card.action
  const canOpen = card.panel !== undefined || card.moreHref !== undefined
  return (
    <section
      ref={(el) => {
        setNodeRef(el)
        box.current = el
      }}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        'group/card relative rounded-xl bg-ws-card py-1 shadow-ws',
        isDragging && 'z-10 shadow-ws-hover',
        focused && 'ring-1 ring-ws-brand/40',
      )}
      data-testid={`rail-card-${card.id}`}
      data-open={open ? 'true' : 'false'}
    >
      {/*
        WP456-T3（§2.6 第 14 条）：卡头 = 标题 13/600 + 灰色计数 + 状态点；最右一颗图标钮。
        点标题那一截展开 / 收起；收着时右边一句摘要。鼠标移到卡上时最右那一颗换成拖动手柄。
      */}
      <div className="flex h-9 min-w-0 items-center gap-1 pr-2 pl-4">
        <button
          type="button"
          aria-expanded={open}
          aria-label={t(open ? 'rail.card.collapse' : 'rail.card.expand', { name })}
          data-testid={`rail-card-toggle-${card.id}`}
          className="flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => {
            rail.setCardOpen(card.id, !open)
          }}
        >
          <span
            className="shrink-0 text-[13px] font-semibold text-ws-ink"
            data-testid="rail-card-title"
          >
            {name}
          </span>
          {status?.count === undefined || status.count === 0 ? null : (
            <span
              className="ws-num shrink-0 text-[13px] font-medium text-ws-faint"
              data-testid={`rail-card-count-${card.id}`}
            >
              {status.count}
            </span>
          )}
          <StatusDot status={status} testId={`rail-card-dot-${card.id}`} />
          <span
            className={cn(
              'ml-auto min-w-0 truncate pl-2 text-[12px] text-ws-muted-fg',
              open && 'sr-only',
            )}
            data-testid={`rail-card-summary-${card.id}`}
          >
            {status?.summary ?? ''}
          </span>
        </button>
        <span className="relative flex size-6 shrink-0 items-center justify-center">
          {action === undefined ? (
            canOpen ? (
              <button
                type="button"
                aria-label={t('rail.card.open', { name })}
                title={t('rail.card.open', { name })}
                data-testid={`rail-card-open-${card.id}`}
                className={cn(
                  HEAD_ICON,
                  'transition-opacity group-hover/card:opacity-0 group-focus-within/card:opacity-0 focus-visible:opacity-100',
                )}
                onClick={more}
              >
                <ChevronRight aria-hidden className="size-4" />
              </button>
            ) : null
          ) : (
            <button
              type="button"
              aria-label={t(action.label)}
              title={t(action.label)}
              data-testid={`rail-card-action-${card.id}`}
              className={cn(
                HEAD_ICON,
                'transition-opacity group-hover/card:opacity-0 group-focus-within/card:opacity-0 focus-visible:opacity-100',
              )}
              onClick={() => {
                if (action.onClick !== undefined) action.onClick(body)
                else
                  rail.openCard(
                    card.id,
                    action.intent === undefined ? {} : { intent: action.intent },
                  )
              }}
            >
              <action.icon aria-hidden className="size-4" />
            </button>
          )}
        </span>
        {/* 决策 1005 / 1035：六点手柄只在鼠标移到卡上（或键盘落到它）时出现在最右；Tab 照样落得到 */}
        <button
          type="button"
          ref={setActivatorNodeRef}
          aria-label={t('rail.card.drag', { name })}
          title={t('rail.card.drag', { name })}
          data-testid={`rail-card-handle-${card.id}`}
          className={cn(
            HEAD_ICON,
            'absolute top-1.5 right-2 cursor-grab touch-none opacity-0 transition-opacity group-hover/card:opacity-100 focus-visible:opacity-100 active:cursor-grabbing',
            (action !== undefined || canOpen) && 'right-9',
          )}
          {...attributes}
          {...listeners}
        >
          <GripVertical aria-hidden className="size-3.5" />
        </button>
      </div>
      {open ? (
        <div className="flex flex-col gap-1 px-2 pb-1.5" data-testid={`rail-card-body-${card.id}`}>
          {Body === undefined ? null : (
            <ErrorBoundary scope="panel" label={`card:${card.id}`} resetKey={card.id}>
              <Suspense fallback={null}>
                <Body {...body} limit={CARD_LIMIT} onMore={more} onTotal={setTotal} />
              </Suspense>
            </ErrorBoundary>
          )}
          {!hasMore || !canOpen ? null : (
            <button
              type="button"
              data-testid={`rail-card-more-${card.id}`}
              className="ws-link-muted self-start px-2 py-0.5 text-[12px]"
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

/**
 * WP456-T3（决策 1448）：看板最底下那张**清单卡**——产出 / 连接 / 设定 / 工坊服务各一行，
 * 每行「名字 + 右边一句状态（红点在数字前）+ ›」，行间一条细线；点一行在第三栏开它的完整一格。
 */
function RailListCard({
  cards,
  body,
}: {
  cards: readonly RailCardDefinition[]
  body: RailPanelBodyProps
}): ReactNode {
  const { t } = useApp()
  return (
    <section
      className="overflow-hidden rounded-xl bg-ws-card py-1 shadow-ws"
      aria-label={t('rail.list.label')}
      data-testid="rail-list-card"
    >
      <ul className="flex flex-col">
        {cards.map((card) => (
          <ListRow key={card.id} card={card} body={body} />
        ))}
      </ul>
    </section>
  )
}

function ListRow({
  card,
  body,
}: {
  card: RailCardDefinition
  body: RailPanelBodyProps
}): ReactNode {
  const { t } = useApp()
  const rail = useRailState()
  const navigate = useNavigate()
  const useStatus = card.useStatus ?? noStatus
  const status = useStatus(body, true)
  const focused = rail.focus === card.id
  const name = t(card.label)
  return (
    <li
      className="[&+&]:shadow-[inset_0_1px_0_var(--ws-line)]"
      data-testid={`rail-card-${card.id}`}
    >
      <button
        type="button"
        data-testid={`rail-list-row-${card.id}`}
        aria-label={status?.summary === undefined ? name : `${name} · ${status.summary}`}
        className={cn(
          'flex h-10 w-full min-w-0 items-center gap-2 px-4 text-left transition-colors hover:bg-ws-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring',
          focused && 'bg-ws-hover',
        )}
        onClick={() => {
          if (card.panel !== undefined) rail.show(card.panel)
          else if (card.moreHref !== undefined) void navigate(card.moreHref)
        }}
      >
        <span
          className="shrink-0 text-[13px] font-semibold text-ws-ink"
          data-testid="rail-card-title"
        >
          {name}
        </span>
        <span className="ml-auto flex min-w-0 items-center gap-1.5 text-[12px] text-ws-faint">
          <StatusDot status={status} testId={`rail-card-dot-${card.id}`} />
          <span className="min-w-0 truncate" data-testid={`rail-card-summary-${card.id}`}>
            {status?.summary ?? ''}
          </span>
          <ChevronRight aria-hidden className="size-4 shrink-0" />
        </span>
      </button>
    </li>
  )
}
