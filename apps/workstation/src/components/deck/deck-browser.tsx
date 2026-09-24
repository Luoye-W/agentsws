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
 */
import type { DeckCard } from '@agentsws/deck'
import { ChevronLeft, ChevronRight, List } from 'lucide-react'
import { useState } from 'react'
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

export function DeckBrowser({
  cards,
  index,
  disabled,
  onJump,
}: {
  cards: readonly DeckCard[]
  index: number
  disabled?: boolean
  onJump: (index: number) => void
}): React.ReactNode {
  const { t } = useApp()
  const [open, setOpen] = useState(false)
  const total = deckTotal(cards)
  const span = deckSpan(cards, index)
  const btn =
    'inline-flex h-6 items-center gap-0.5 rounded-md px-1.5 text-xs text-ws-muted-fg hover:bg-ws-surface hover:text-ws-ink disabled:pointer-events-none disabled:opacity-40'
  return (
    <div className="flex flex-col gap-1.5" data-testid="deck-nav">
      <div className="flex flex-wrap items-center gap-1">
        <button
          type="button"
          className={btn}
          data-testid="deck-prev"
          disabled={disabled === true || index <= 0}
          onClick={() => {
            onJump(index - 1)
          }}
        >
          <ChevronLeft className="size-3.5" aria-hidden />
          {t('deck.nav.prev')}
        </button>
        <p className="px-1 text-xs text-muted-foreground" data-testid="deck-progress">
          {span.from === span.to
            ? t('deck.progress', { index: span.from, total })
            : t('deck.progress.range', { from: span.from, to: span.to, total })}
        </p>
        <button
          type="button"
          className={btn}
          data-testid="deck-next"
          disabled={disabled === true || index >= cards.length - 1}
          onClick={() => {
            onJump(index + 1)
          }}
        >
          {t('deck.nav.next')}
          <ChevronRight className="size-3.5" aria-hidden />
        </button>
        {cards.length > 1 ? (
          <button
            type="button"
            className={`${btn} ml-1`}
            data-testid="deck-list-toggle"
            aria-expanded={open}
            onClick={() => {
              setOpen(!open)
            }}
          >
            <List className="size-3.5" aria-hidden />
            {open ? t('deck.nav.list.close') : t('deck.nav.list')}
          </button>
        ) : null}
      </div>
      {open ? (
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
                  setOpen(false)
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
      ) : null}
    </div>
  )
}
