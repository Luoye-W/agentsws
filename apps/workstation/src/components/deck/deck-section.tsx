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
 *
 * WP288（决策 326）：**标题、筛选、翻页一行**——调用方把标题（「要你处理 N」）交进来，
 * 右侧是筛选图标 +「全部列出」+「‹ 1/N ›」；筛选 / 语言平时收在图标里，正在筛选时标题下才出
 * 一排已选条件。原来的筛选行与翻页行不再单独占行。
 */
import type { BattleReport, DeckCard, DeckContentMode, DeckFilters, DeckKind } from '@agentsws/deck'
import { sortCards } from '@agentsws/deck'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from 'react'
import { DeckBattleReport } from '@/components/deck/deck-battle-report'
import { DeckList, DeckPager } from '@/components/deck/deck-browser'
import {
  DeckCardView,
  type DeckDecideRequest,
  type DeckExitDirection,
} from '@/components/deck/deck-card'
import {
  DEFAULT_CONTENT_MODE,
  DeckActiveFilters,
  DeckFilterPop,
  type PositionOption,
} from '@/components/deck/deck-filters'
import {
  directionForDeckAction,
  directionForDeckKey,
  isTypingTarget,
} from '@/components/deck/deck-gestures'
import { deckKeyHints, deckKeys } from '@/components/deck/deck-keys'
import { DECK_EXIT_MS, DECK_MAX_WIDTH_CLASS } from '@/components/deck/deck-layout'
import { ReportBlocks } from '@/components/deck/panel-blocks'
import { Skeleton } from '@/components/ui/skeleton'
import { type CardsData, type DecideInput, decide, getHome, getPositionCards } from '@/lib/api'
import { useMode } from '@/lib/mode'

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
  /**
   * WP241（docs/54 §7）：从别处「翻到这张」——岗位页「工作」行尾「N 张卡等你」点过来的。
   * `nonce` 每点一次变一次（同一张点两次也要再翻）。那张卡被筛掉了就先清筛选再翻。
   * 只是翻页，不决定、不改卡的长相。
   */
  focus?: { card_id: string; nonce: number }
  /**
   * WP278（决策 284）：只有一个岗位的人首页就是岗位页——牌堆再收发给他、挂在底座职责（`common.*`）上的卡
   * （「知道了 / 撤回」、有人申请加入…）。只在岗位页、只有一个岗位时给。
   */
  withBase?: boolean
  /**
   * WP288：这副牌的标题（「要你处理 N」）。给了就与筛选图标、翻页同一行；不给那一行只有右侧控件。
   */
  title?: ReactNode
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
  // WP278：底座那几张可能被两条职责的请求都带回来——同一张只留一份
  const seen = new Set<string>()
  const cards = parts
    .flatMap((p) => p.cards)
    .filter((c) => {
      if (seen.has(c.id)) return false
      seen.add(c.id)
      return true
    })
  return {
    cards: sortCards(cards),
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
  withBase = false,
): Promise<DeckData> {
  if (ids !== undefined && ids.length > 0) {
    // WP278：底座卡只让第一条职责的请求带回来（服务端按人收，不按职责）
    return mergeDecks(
      await Promise.all(
        ids.map((id, i) =>
          withBase && i === 0 ? getPositionCards(id, filters, true) : getPositionCards(id, filters),
        ),
      ),
    )
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
  focus,
  withBase = false,
  title,
}: DeckSectionProps): React.ReactNode {
  // WP275：回执与快捷键那几句按模式换词（① ② 是「通过」系，不是「批准」系）
  const { t } = useMode()
  const client = useQueryClient()
  const deckRef = useRef<HTMLElement | null>(null)

  const [active, setActive] = useState<DeckFilters>(filters ?? {})
  const [mode, setMode] = useState<DeckContentMode>(DEFAULT_CONTENT_MODE)
  const [listOpen, setListOpen] = useState(false)
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
    queryKey: ['deck', idsKey, active, withBase],
    queryFn: () => fetchDeck(ids, active, withBase),
    // WP288：换筛选时留着上一副牌（筛选弹层不因为整块变骨架而被收掉）
    placeholderData: keepPreviousData,
  })
  /*
   * WP141：「卡型」下拉的选项从**没筛过的全部牌**算。原来从筛过的牌算，于是选了
   * 一种之后下拉里只剩这一种，要换就得先退回「所有卡型」。不带筛选时这就是同一把缓存。
   */
  const all = useQuery<DeckData>({
    queryKey: ['deck', idsKey, {}, withBase],
    queryFn: () => fetchDeck(ids, {}, withBase),
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

  // WP241：外面要翻到哪张——在这副牌里就直接翻；被筛掉了就回到全部牌再翻
  const focusId = focus?.card_id
  const focusNonce = focus?.nonce
  const allIds = (all.data?.cards ?? []).map((c) => c.id).join(',')
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只在「点了一次」与牌到齐时翻，不跟着筛选来回跳
  useEffect(() => {
    if (focusId === undefined) return
    const inView = cards.some((c) => c.id === focusId)
    if (!inView && allIds.split(',').includes(focusId) && Object.keys(active).length > 0) {
      setActive({})
    }
    setCursor(focusId)
    setError('')
    deckRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' })
    deckRef.current?.focus({ preventScroll: true })
  }, [focusId, focusNonce, allIds])
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
    // WP287：键盘跟着卡上真有的按钮走（与提示行同一张表）；没有对应按钮的方向键不做事
    const key = deckKeys(card, t).find((k) => k.direction === direction)
    if (key === undefined) return
    event.preventDefault()
    if (key.click === true) {
      deckRef.current
        ?.querySelector<HTMLButtonElement>(`button[data-action="${key.action}"]`)
        ?.click()
      return
    }
    dispatch({
      action: key.action,
      version: card.version,
      ...(key.option === undefined ? {} : { selected_option_id: key.option }),
    })
  }

  // 还没取到 / 取失败：标题照样在（它是调用方交进来的），下面是骨架或那一句错
  if (query.isPending || query.error !== null)
    return (
      <div className={`flex flex-col gap-3 ${DECK_MAX_WIDTH_CLASS}`}>
        {title === undefined ? null : <div className="flex items-center gap-2">{title}</div>}
        {query.error === null ? (
          <Skeleton className="h-64 w-full" />
        ) : (
          <p role="alert" className="text-sm text-destructive">
            {t('error.generic')}：{query.error.message}
          </p>
        )}
      </div>
    )

  // 下拉里一直是全部牌里真有的那几种；已选中的那一种就算被决定光了也留着，免得选中值悬空
  const kinds = [
    ...new Set([
      ...(all.data?.cards ?? cards).map((c) => c.kind),
      ...(active.kind === undefined ? [] : [active.kind]),
    ]),
  ] as DeckKind[]
  // WP287：提示行就是卡上那几个按钮（与方向键同一张表）
  const hints = card === undefined ? [] : deckKeyHints(card, t)

  const changeFilters = (next: DeckFilters): void => {
    setActive(next)
    setCursor(undefined)
    setFallback(0)
  }
  const positions = query.data?.positions ?? []

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
      {/* WP288：标题 · 筛选图标 · 全部列出 · ‹ 1/N › 一行 */}
      <div className="flex items-center gap-2" data-testid="deck-head">
        <div className="flex min-w-0 flex-1 items-center gap-2">{title}</div>
        <DeckFilterPop
          filters={active}
          counts={
            query.data?.counts ?? {
              total: 0,
              customer_waiting: 0,
              nobody_waiting: 0,
              matched: 0,
            }
          }
          positions={positions}
          kinds={kinds}
          mode={mode}
          onChange={changeFilters}
          onMode={setMode}
        />
        {card === undefined ? null : (
          <DeckPager
            cards={cards}
            index={index}
            disabled={exiting !== null}
            onJump={jump}
            listOpen={listOpen}
            onToggleList={() => {
              setListOpen(!listOpen)
            }}
          />
        )}
      </div>
      <DeckActiveFilters
        filters={active}
        positions={positions}
        mode={mode}
        pinnedCount={query.data?.pinned_p0.length ?? 0}
        onChange={changeFilters}
        onMode={setMode}
      />

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
            changeFilters({})
          }}
        />
      ) : (
        <>
          {listOpen && cards.length > 1 ? (
            <DeckList
              cards={cards}
              index={index}
              onJump={(i) => {
                jump(i)
                setListOpen(false)
              }}
            />
          ) : null}
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
