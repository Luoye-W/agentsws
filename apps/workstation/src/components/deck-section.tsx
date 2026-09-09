/**
 * **临时垫片**：首页第三段的卡片区。
 *
 * WP21（卡片重做）会在 `@/components/deck` 里交付真正的 `<DeckSection positionId? filters? onOpen />`
 * ——一次一张的 deck、岗位 / 等待 / 卡型筛选、飞出动画、空态战报。它交付后，
 * `pages/home.tsx` 里那一行只要把 import 从 `@/components/deck-section` 换成 `@/components/deck`，
 * 别的都不用动（props 与 WP21 的签名一致）。
 *
 * 在那之前这里用现有的 `DeckCardView` 平铺顶着，好让首页第三稿能整屏跑起来；
 * 「进入事项」在垫片里是每张卡下面的一枚小按钮（真 deck 里是动作行的 `open`）。
 */
import type { DeckCard } from '@agentsws/deck'
import { DeckCardView } from '@/components/deck/deck-card'
import { Button } from '@/components/ui/button'
import type { DecideInput } from '@/lib/api'
import { useApp } from '@/lib/app-context'

export interface DeckSectionProps {
  /** 只看某个岗位的队列；不给就是跨岗位合并 */
  positionId?: string
  /** WP21 的筛选（岗位 / 等待 / 卡型 / 来源）；垫片只认 positionId */
  filters?: Record<string, string | undefined>
  cards: DeckCard[]
  onDecide: (card: DeckCard, input: DecideInput) => void
  /** 「打开」= 进入事项并定位到那次运行（37 §2.2b） */
  onOpen?: (card: DeckCard) => void
  busyId?: string | null
  errors?: Record<string, string>
}

export function DeckSection({
  positionId,
  cards,
  onDecide,
  onOpen,
  busyId,
  errors = {},
}: DeckSectionProps): React.ReactNode {
  const { t } = useApp()
  const visible =
    positionId === undefined ? cards : cards.filter((c) => c.position_id === positionId)
  if (visible.length === 0)
    return <p className="text-sm text-muted-foreground">{t('home.queue.empty')}</p>
  return (
    <div className="flex flex-col gap-3" data-testid="deck-section">
      {visible.map((card) => (
        <div key={card.id} className="flex flex-col gap-1">
          <DeckCardView
            card={card}
            busy={busyId === card.id}
            {...(errors[card.id] === undefined ? {} : { error: errors[card.id] })}
            onDecide={(req) => {
              onDecide(card, {
                action: req.action,
                version: req.version,
                ...(req.selected_option_id === undefined
                  ? {}
                  : { selected_option_id: req.selected_option_id }),
                ...(req.instruction === undefined ? {} : { instruction: req.instruction }),
              })
            }}
          />
          {onOpen === undefined ? null : (
            <Button
              variant="ghost"
              size="xs"
              className="self-start"
              data-testid="deck-open"
              onClick={() => {
                onOpen(card)
              }}
            >
              {t('nav.matters')} →
            </Button>
          )}
        </div>
      ))}
    </div>
  )
}
