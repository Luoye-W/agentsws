/**
 * 一副牌（37 §1 第 1 行）：**一次一张**、780px 居中、背后两张歪斜的景深假卡、
 * 「第 N / M 张」、键盘 → 批准 / ← 拒绝 / ↑ 稍后 / ↓ 指导。
 *
 * 首页与岗位页各自只写一行 `<DeckSection …/>`：筛选、语言、翻页、决定、飞出、空态
 * 全在这里，两个页面不再各抄一份卡片列表。
 */
import type { BattleReport, DeckCard, DeckContentMode, DeckFilters, DeckKind } from '@agentsws/deck'
import { CONTENT_MODES } from '@agentsws/deck'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { type KeyboardEvent, useEffect, useRef, useState } from 'react'
import { DeckBattleReport } from '@/components/deck/deck-battle-report'
import {
  DeckCardView,
  type DeckDecideRequest,
  type DeckExitDirection,
} from '@/components/deck/deck-card'
import { DeckFilterRow, type PositionOption } from '@/components/deck/deck-filters'
import {
  deckActionForDirection,
  directionForDeckAction,
  directionForDeckKey,
  isTypingTarget,
} from '@/components/deck/deck-gestures'
import { DECK_EXIT_MS, DECK_MAX_WIDTH_CLASS } from '@/components/deck/deck-layout'
import { Skeleton } from '@/components/ui/skeleton'
import { type DecideInput, decide, getHome, getPositionCards } from '@/lib/api'
import { useApp } from '@/lib/app-context'

export interface DeckSectionProps {
  /** 给了就只看这个岗位（岗位页）；不给就是首页的跨岗位队列 */
  positionId?: string
  /** 初始筛选条件；之后由筛选行自己管 */
  filters?: DeckFilters
  /** 37 §2.2b：`open` = 进入事项。事项页由 WP22 做，这里只把卡交出去 */
  onOpen: (card: DeckCard) => void
}

interface DeckData {
  cards: DeckCard[]
  counts: { total: number; customer_waiting: number; nobody_waiting: number; matched: number }
  pinned_p0: DeckCard[]
  positions: PositionOption[]
  battle_report?: BattleReport
}

export function DeckSection({ positionId, filters, onOpen }: DeckSectionProps): React.ReactNode {
  const { t } = useApp()
  const client = useQueryClient()
  const deckRef = useRef<HTMLElement | null>(null)

  const [active, setActive] = useState<DeckFilters>(filters ?? {})
  const [mode, setMode] = useState<DeckContentMode>('zh_summary')
  const [index, setIndex] = useState(0)
  const [exiting, setExiting] = useState<DeckExitDirection | null>(null)
  const [error, setError] = useState<string>('')

  const query = useQuery<DeckData>({
    queryKey: ['deck', positionId ?? null, active],
    queryFn: async () => {
      if (positionId !== undefined) {
        const data = await getPositionCards(positionId, active)
        return {
          cards: data.cards,
          counts: data.counts,
          pinned_p0: data.pinned_p0,
          positions: [
            { position_id: data.position.position_id, role_name: data.position.role_name },
          ],
        }
      }
      const home = await getHome('yesterday', active)
      return {
        cards: home.queue,
        counts: home.counts,
        pinned_p0: home.pinned_p0,
        positions: home.tiles.map((b) => ({
          position_id: b.position_id,
          role_name: b.role_name,
        })),
        battle_report: home.battle_report,
      }
    },
  })

  const mutation = useMutation({
    mutationFn: (input: { card: DeckCard; body: DecideInput }) =>
      decide(input.card.id, input.body, input.card.position_id),
    onError: (err) => {
      setError(err.message)
      setExiting(null)
    },
    onSuccess: () => {
      setError('')
    },
    onSettled: () => {
      void client.invalidateQueries({ queryKey: ['deck'] })
      void client.invalidateQueries({ queryKey: ['home'] })
    },
  })

  const cards = query.data?.cards ?? []
  const total = cards.length
  // 队列变短（决定完刷新回来）时把游标收回范围内，否则会停在一张不存在的卡上。
  useEffect(() => {
    setIndex((i) => (i >= total && total > 0 ? total - 1 : i))
  }, [total])

  const card = cards[Math.min(index, Math.max(total - 1, 0))]
  const filtered = Object.keys(active).length > 0

  /**
   * 已处理不留队列：飞出 300ms → 下一张（37 §1 第 8 行）。
   *
   * 决定先发出去，动画和「下一张」在同一个 timeout 里；失败时 `onError` 会把
   * `exiting` 收回来，卡留在原地并带上错误——不能让一张没发成功的卡飞走。
   */
  const dispatch = (request: DeckDecideRequest): void => {
    if (card === undefined || exiting !== null) return
    setExiting(directionForDeckAction(request.action))
    mutation.mutate({
      card,
      body: {
        action: request.action,
        version: request.version,
        ...(request.selected_option_id === undefined
          ? {}
          : { selected_option_id: request.selected_option_id }),
        ...(request.instruction === undefined ? {} : { instruction: request.instruction }),
        ...(request.reason === undefined ? {} : { reason: request.reason }),
      },
    })
    setTimeout(() => {
      setExiting(null)
      setIndex((i) => i + 1)
    }, DECK_EXIT_MS)
  }

  /**
   * 箭头键绑在这副牌上，**不绑 window**。
   *
   * 这副牌待在一个有自己滚动与 Tab 的页面里；全局监听会把整页的箭头键都吃掉。
   * 打字永远优先：指导框就在这个容器里，它的 keydown 会冒泡上来。
   */
  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (isTypingTarget(event.target as HTMLElement | null)) return
    if (card === undefined || exiting !== null) return
    const direction = directionForDeckKey(event.key)
    if (direction === undefined) return
    const action = deckActionForDirection(direction)
    if (!card.available_actions.includes(action)) return
    event.preventDefault()
    if (action === 'approve') {
      // 一道选择题没选中就不存在「同意」，键盘也不是后门。
      if (card.options !== undefined && card.options.length > 0) return
      dispatch({ action: 'approve', version: card.version })
      return
    }
    // 拒绝 / 指导先就地开面板；稍后直接走。
    if (action === 'snooze') {
      dispatch({ action: 'snooze', version: card.version })
      return
    }
    deckRef.current?.querySelector<HTMLButtonElement>(`button[data-action="${action}"]`)?.click()
  }

  if (query.isPending) return <Skeleton className="h-64 w-full" />
  if (query.error !== null)
    return (
      <p role="alert" className="text-sm text-destructive">
        {t('error.generic')}：{query.error.message}
      </p>
    )

  const kinds = [...new Set(cards.map((c) => c.kind))] as DeckKind[]

  return (
    <section
      ref={deckRef}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: 这副牌本身就是交互面，必须可聚焦；否则只能上全局监听
      tabIndex={0}
      data-testid="deck-section"
      aria-label={t('deck.progress', { index: Math.min(index + 1, total), total })}
      aria-keyshortcuts="ArrowRight ArrowLeft ArrowUp ArrowDown"
      onKeyDown={onKeyDown}
      className={`flex flex-col gap-3 rounded-2xl outline-none focus-visible:ring-2 ${DECK_MAX_WIDTH_CLASS}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <DeckFilterRow
          filters={active}
          counts={
            query.data?.counts ?? {
              total: 0,
              customer_waiting: 0,
              nobody_waiting: 0,
              matched: 0,
            }
          }
          positions={query.data?.positions ?? []}
          kinds={kinds}
          pinnedCount={query.data?.pinned_p0.length ?? 0}
          onChange={(next) => {
            setActive(next)
            setIndex(0)
          }}
        />
        {/* 语言是**队列级**的，不是每张卡各选一次（37 §1 第 4 行） */}
        <div className="inline-flex rounded-full border p-0.5 text-xs" data-testid="deck-modes">
          {CONTENT_MODES.map((m) => (
            <button
              key={m}
              type="button"
              aria-pressed={m === mode}
              className={
                m === mode
                  ? 'rounded-full bg-primary px-2.5 py-0.5 text-primary-foreground'
                  : 'rounded-full px-2.5 py-0.5 text-muted-foreground hover:text-foreground'
              }
              onClick={() => {
                setMode(m)
              }}
            >
              {t(`deck.content.${m}`)}
            </button>
          ))}
        </div>
      </div>

      {card === undefined ? (
        <DeckBattleReport
          {...(query.data?.battle_report === undefined ? {} : { report: query.data.battle_report })}
          filtered={filtered}
          onBackToAll={() => {
            setActive({})
            setIndex(0)
          }}
        />
      ) : (
        <>
          <p className="text-xs text-muted-foreground" data-testid="deck-progress">
            {t('deck.progress', { index: Math.min(index + 1, total), total })}
          </p>
          <div className="relative mb-4">
            {/* 景深：背后两张歪斜的假卡，让「还有几张」有体感 */}
            {index + 1 < total ? (
              <div
                data-testid="deck-ghost"
                className="absolute inset-x-3 top-2 h-full rotate-1 rounded-2xl border bg-card/70 shadow-sm"
              />
            ) : null}
            {index + 2 < total ? (
              <div
                data-testid="deck-ghost"
                className="absolute inset-x-6 top-4 h-full -rotate-1 rounded-2xl border bg-card/40"
              />
            ) : null}
            <DeckCardView
              key={card.id}
              card={card}
              mode={mode}
              busy={mutation.isPending}
              exiting={exiting}
              {...(error === '' ? {} : { error })}
              onDecide={dispatch}
              onOpen={onOpen}
            />
          </div>
          <p className="text-xs text-muted-foreground">{t('deck.keyboard')}</p>
        </>
      )}
    </section>
  )
}
