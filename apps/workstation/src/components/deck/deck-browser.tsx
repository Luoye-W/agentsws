/**
 * WP141（docs/78 §1 #4）：**不决定前一张，也能直接去后面的卡**。
 *
 * 一次一张（37 §1）是对的，但它原来没有第二条路：想先批第二张议价卡，就得先把
 * 挡在前面的 campaign 名单卡决定掉。这里补两样——「上一张 / 下一张」与一张紧凑
 * 列表（每张一行：类别 · 标题，点一行就翻到那张）。翻牌不是决定：它不发任何请求，
 * 卡还在原处等着。
 *
 * 「第 x / N 张」按**张数**算（合并前，与页头「N 张卡等你决定」、筛选「全部 N」同一个
 * 口径）：一张代表了 3 张同类的合并卡，翻到它时写「第 2–4 / 9 张」。
 *
 * WP288（决策 326）：翻页不再单独占一行——「‹ 1/N ›」与「全部列出」图标挪进「要你处理 N」那一行右侧
 * （`DeckPager`），点开的紧凑列表照旧在牌的上面（`DeckList`）。屏上只写「1/3」，读屏与悬停仍是「第 1 / 3 张」。
 */
import type { DeckCard } from '@agentsws/deck'
import { ChevronLeft, ChevronRight, List } from 'lucide-react'
import { categoryOf } from '@/components/deck/deck-card'
import { useApp } from '@/lib/app-context'

/** 一张卡算几张：合并卡按成员数，其余 1。 */
const weight = (c: DeckCard): number => Math.max(1, c.merge_count || 1)

/** 这副牌一共几张（合并前）。 */
export function deckTotal(cards: readonly DeckCard[]): number {
  return cards.reduce((n, c) => n + weight(c), 0)
}

/** 第 `index` 张（组）在合并前的张数里占第几到第几张。 */
export function deckSpan(cards: readonly DeckCard[], index: number): { from: number; to: number } {
  const from = cards.slice(0, index).reduce((n, c) => n + weight(c), 0) + 1
  const card = cards[index]
  return { from, to: card === undefined ? from : from + weight(card) - 1 }
}

/** 「‹ 1/N ›」+「全部列出」图标：放在「要你处理 N」那一行的右侧。 */
export function DeckPager({
  cards,
  index,
  disabled,
  onJump,
  listOpen,
  onToggleList,
}: {
  cards: readonly DeckCard[]
  index: number
  disabled?: boolean
  onJump: (index: number) => void
  listOpen: boolean
  onToggleList: () => void
}): React.ReactNode {
  const { t } = useApp()
  const total = deckTotal(cards)
  const span = deckSpan(cards, index)
  const full =
    span.from === span.to
      ? t('deck.progress', { index: span.from, total })
      : t('deck.progress.range', { from: span.from, to: span.to, total })
  const btn =
    'inline-flex size-7 items-center justify-center rounded-md text-ws-muted-fg hover:bg-ws-surface hover:text-ws-ink disabled:pointer-events-none disabled:opacity-40'
  return (
    <div className="flex items-center" data-testid="deck-nav">
      {cards.length > 1 ? (
        <button
          type="button"
          className={`${btn} mr-1 ${listOpen ? 'bg-ws-surface text-ws-ink' : ''}`}
          data-testid="deck-list-toggle"
          aria-expanded={listOpen}
          aria-label={listOpen ? t('deck.nav.list.close') : t('deck.nav.list')}
          title={listOpen ? t('deck.nav.list.close') : t('deck.nav.list')}
          onClick={onToggleList}
        >
          <List className="size-4" aria-hidden />
        </button>
      ) : null}
      <button
        type="button"
        className={btn}
        data-testid="deck-prev"
        aria-label={t('deck.nav.prev')}
        title={t('deck.nav.prev')}
        disabled={disabled === true || index <= 0}
        onClick={() => {
          onJump(index - 1)
        }}
      >
        <ChevronLeft className="size-4" aria-hidden />
      </button>
      <p
        className="ws-num min-w-[2.5em] text-center text-xs text-muted-foreground"
        data-testid="deck-progress"
        title={full}
      >
        <span aria-hidden>
          {span.from === span.to ? `${span.from}/${total}` : `${span.from}–${span.to}/${total}`}
        </span>
        <span className="sr-only">{full}</span>
      </p>
      <button
        type="button"
        className={btn}
        data-testid="deck-next"
        aria-label={t('deck.nav.next')}
        title={t('deck.nav.next')}
        disabled={disabled === true || index >= cards.length - 1}
        onClick={() => {
          onJump(index + 1)
        }}
      >
        <ChevronRight className="size-4" aria-hidden />
      </button>
    </div>
  )
}

/** 点了「全部列出」才出的紧凑列表：每张一行，点一行就翻到那张。 */
export function DeckList({
  cards,
  index,
  onJump,
}: {
  cards: readonly DeckCard[]
  index: number
  onJump: (index: number) => void
}): React.ReactNode {
  const { t } = useApp()
  return (
    <ol className="flex flex-col rounded-xl bg-ws-card p-1 shadow-sm" data-testid="deck-list">
      {cards.map((c, i) => (
        <li key={c.id}>
          <button
            type="button"
            data-testid="deck-list-item"
            data-kind={c.kind}
            aria-current={i === index ? 'true' : undefined}
            className={`flex w-full items-baseline gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] hover:bg-ws-surface ${
              i === index ? 'bg-ws-tint' : ''
            }`}
            onClick={() => {
              onJump(i)
            }}
          >
            <span className="shrink-0 text-xs text-ws-muted-fg">{categoryOf(c, t)}</span>
            <span className="min-w-0 flex-1 truncate">{c.title}</span>
            {weight(c) > 1 ? (
              <span className="shrink-0 text-xs text-ws-muted-fg">
                {t('deck.merge', { n: weight(c) })}
              </span>
            ) : null}
          </button>
        </li>
      ))}
    </ol>
  )
}
