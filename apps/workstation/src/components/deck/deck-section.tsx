/**
 * 一副牌（37 §1 第 1 行）：**一次一张**、780px 居中、背后两张歪斜的景深假卡、
 * 「第 N / M 张」、键盘 → 批准 / ← 拒绝 / ↑ 稍后 / ↓ 指导。
 *
 * 首页与岗位页各自只写一行 `<DeckSection …/>`：筛选、语言、翻页、决定、飞出、空态
 * 全在这里，两个页面不再各抄一份卡片列表。
 *
 * WP141（docs/78 §1 #4）：一次一张之外多了「上一张 / 下一张」与紧凑列表（`deck-browser`），
 * 不决定前一张也能直接找到后面的卡；卡型下拉从全部牌算；提示行按这张卡的动作给；
 * 「第 x / N 张」与页头、筛选按同一个口径（合并前的张数）。
 */
import type { BattleReport, DeckCard, DeckContentMode, DeckFilters, DeckKind } from '@agentsws/deck'
import { CONTENT_MODES, sortCards } from '@agentsws/deck'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { type KeyboardEvent, useRef, useState } from 'react'
import { deckActionLabel } from '@/components/deck/deck-action-bar'
import { DeckBattleReport } from '@/components/deck/deck-battle-report'
import { DeckBrowser } from '@/components/deck/deck-browser'
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
  keyboardHints,
} from '@/components/deck/deck-gestures'
import { DECK_EXIT_MS, DECK_MAX_WIDTH_CLASS } from '@/components/deck/deck-layout'
import { ReportBlocks } from '@/components/deck/panel-blocks'
import { Skeleton } from '@/components/ui/skeleton'
import { type CardsData, type DecideInput, decide, getHome, getPositionCards } from '@/lib/api'
import { useApp } from '@/lib/app-context'

export interface DeckSectionProps {
  /** 给了就只看这个岗位（岗位页）；不给就是首页的跨岗位队列 */
  positionId?: string
  /**
   * WP141：岗位页上**本人在这个岗位下的每一条职责**（含 `positionId` 那条）。
   *
   * 岗位页页头的「N 张待审」是按岗位聚合的（54 §4），牌堆原来只取地址栏那一条职责，
   * 于是客服页头写「3 张待审」、牌堆却是「队列清空了」。给了这一串，牌堆就把几条
   * 职责的卡合成一副，与页头同一个口径。
   */
  positionIds?: readonly string[]
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
  /** 只有岗位路由给：看完即过的报表块（首页的报表块在首页自己那一段） */
  reports?: DeckCard[]
}

/** 几条职责的牌合成一副：卡按同一个比较器重排，计数逐项相加。 */
function mergeDecks(parts: CardsData[]): DeckData {
  const first = parts[0]
  const sum = (k: keyof DeckData['counts']): number => parts.reduce((n, p) => n + p.counts[k], 0)
  return {
    cards: sortCards(parts.flatMap((p) => p.cards)),
    counts: {
      total: sum('total'),
      customer_waiting: sum('customer_waiting'),
      nobody_waiting: sum('nobody_waiting'),
      matched: sum('matched'),
    },
    pinned_p0: sortCards(parts.flatMap((p) => p.pinned_p0)),
    reports: parts.flatMap((p) => p.reports ?? []),
    // 岗位页只算一个岗位：不出岗位 chip（职责层在页头折叠里，不在筛选行上）
    positions:
      first === undefined
        ? []
        : [{ position_id: first.position.position_id, role_name: first.position.role_name }],
  }
}

async function fetchDeck(
  ids: readonly string[] | undefined,
  filters: DeckFilters,
): Promise<DeckData> {
  if (ids !== undefined && ids.length > 0) {
    return mergeDecks(await Promise.all(ids.map((id) => getPositionCards(id, filters))))
  }
  const home = await getHome('yesterday', filters)
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
}

/** 决定之后给的那一句回执（WP141：「改一下」提交后原来一个字都没有，卡直接没了）。 */
function receiptKey(body: DecideInput, card: DeckCard): string | undefined {
  if (body.action === 'instruct')
    return `deck.receipt.instruct.${body.instruction?.scope ?? 'single_reply'}`
  if (body.action === 'reject') return 'deck.receipt.reject'
  if (body.action === 'snooze') return 'deck.receipt.snooze'
  if (body.action === 'approve' && body.selected_option_id !== undefined)
    return 'deck.receipt.choice'
  if (body.action === 'approve' && card.layout === 'policy') return 'deck.receipt.choice'
  return undefined
}

export function DeckSection({
  positionId,
  positionIds,
  filters,
  onOpen,
}: DeckSectionProps): React.ReactNode {
  const { t } = useApp()
  const client = useQueryClient()
  const deckRef = useRef<HTMLElement | null>(null)

  const [active, setActive] = useState<DeckFilters>(filters ?? {})
  const [mode, setMode] = useState<DeckContentMode>('zh_summary')
  /*
   * 游标记的是**卡**，不是下标（WP141）。决定完一张、队列刷新回来，那张卡就不在了；
   * 按下标 +1 会跳过紧挨着的那张。`cursor` 找不到时退回 `fallback` 那个位置——
   * 被决定的卡一拿掉，排在它后面那张正好落在这个位置上。
   */
  const [cursor, setCursor] = useState<string | undefined>(undefined)
  const [fallback, setFallback] = useState(0)
  const [exiting, setExiting] = useState<DeckExitDirection | null>(null)
  const [error, setError] = useState<string>('')
  const [receipt, setReceipt] = useState<string>('')

  const ids =
    positionIds !== undefined && positionIds.length > 0
      ? positionIds
      : positionId === undefined
        ? undefined
        : [positionId]
  const idsKey = ids === undefined ? null : ids.join(',')

  const query = useQuery<DeckData>({
    queryKey: ['deck', idsKey, active],
    queryFn: () => fetchDeck(ids, active),
  })
  /*
   * WP141：「卡型」下拉的选项从**没筛过的全部牌**算。原来从筛过的牌算，于是选了
   * 一种之后下拉里只剩这一种，要换就得先退回「所有卡型」。不带筛选时这就是同一把缓存。
   */
  const all = useQuery<DeckData>({
    queryKey: ['deck', idsKey, {}],
    queryFn: () => fetchDeck(ids, {}),
  })

  const mutation = useMutation({
    mutationFn: (input: { card: DeckCard; body: DecideInput }) =>
      decide(input.card.id, input.body, input.card.position_id),
    onError: (err) => {
      setError(err.message)
      setReceipt('')
      setExiting(null)
    },
    onSuccess: (_out, input) => {
      setError('')
      const key = receiptKey(input.body, input.card)
      setReceipt(key === undefined ? '' : t(key))
    },
    onSettled: () => {
      void client.invalidateQueries({ queryKey: ['deck'] })
      void client.invalidateQueries({ queryKey: ['home'] })
      // 页头「N 张待审」与左栏岗位旁的数字也跟着变（同一屏的卡数对得上）
      void client.invalidateQueries({ queryKey: ['positions'] })
      void client.invalidateQueries({ queryKey: ['position-instance'] })
    },
  })

  const cards = query.data?.cards ?? []
  const total = cards.length
  const found = cursor === undefined ? -1 : cards.findIndex((c) => c.id === cursor)
  const index = found >= 0 ? found : Math.max(0, Math.min(fallback, total - 1))
  const card = cards[index]
  const filtered = Object.keys(active).length > 0

  /** 翻到第 i 张（不是决定：不发请求，卡还在原处等着）。 */
  const jump = (i: number): void => {
    const target = cards[i]
    if (target === undefined || exiting !== null) return
    setCursor(target.id)
    setFallback(i)
    setError('')
  }

  /**
   * 已处理不留队列：飞出 300ms → 下一张（37 §1 第 8 行）。
   *
   * 决定先发出去，动画和「下一张」在同一个 timeout 里；失败时 `onError` 会把
   * `exiting` 收回来，卡留在原地并带上错误——不能让一张没发成功的卡飞走。
   */
  const dispatch = (request: DeckDecideRequest): void => {
    if (card === undefined || exiting !== null) return
    setExiting(directionForDeckAction(request.action))
    setReceipt('')
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
    const next = cards[index + 1]
    setTimeout(() => {
      setExiting(null)
      setCursor(next?.id)
      setFallback(index)
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

  // 下拉里一直是全部牌里真有的那几种；已选中的那一种就算被决定光了也留着，免得选中值悬空
  const kinds = [
    ...new Set([
      ...(all.data?.cards ?? cards).map((c) => c.kind),
      ...(active.kind === undefined ? [] : [active.kind]),
    ]),
  ] as DeckKind[]
  const hints =
    card === undefined
      ? []
      : keyboardHints(card.available_actions, (a) => deckActionLabel(card, a, t))

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
            setCursor(undefined)
            setFallback(0)
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

      {/* WP141：岗位页的报表块（日报 / 上线检查单）不再混在牌堆里当一张卡 */}
      <ReportBlocks reports={all.data?.reports ?? []} onOpen={onOpen} />

      {/* WP141：决定之后的一句回执（「记下了」），下一次决定时换掉 */}
      {receipt === '' ? null : (
        <p role="status" className="text-xs text-ws-good" data-testid="deck-receipt">
          {receipt}
        </p>
      )}

      {card === undefined ? (
        <DeckBattleReport
          {...(query.data?.battle_report === undefined ? {} : { report: query.data.battle_report })}
          filtered={filtered}
          onBackToAll={() => {
            setActive({})
            setCursor(undefined)
            setFallback(0)
          }}
        />
      ) : (
        <>
          <DeckBrowser cards={cards} index={index} disabled={exiting !== null} onJump={jump} />
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
          {/* WP141：提示行按这张卡真有的动作生成（没有「稍后」就不写 ↑ 稍后） */}
          {hints.length === 0 ? null : (
            <p className="text-xs text-muted-foreground" data-testid="deck-keyboard">
              {hints.join(' · ')}
            </p>
          )}
        </>
      )}
    </section>
  )
}
