/**
 * 空态 = 今日战报（37 §1 第 9 行）。
 *
 * 队列清空时给的不是「暂无卡片」，而是**今天发生了什么**的四个数——四个数都来自
 * 事件日志（服务端算好，见 `@agentsws/deck` 的 `battleReport`），一个不估。
 *
 * 高度用与卡片同一个下限：清掉最后一张卡时，界面不该往上跳半屏。
 */
import type { BattleReport } from '@agentsws/deck'
import { DECK_CARD_MIN_HEIGHT_CLASS } from '@/components/deck/deck-layout'
import { Button } from '@/components/ui/button'
import { useApp } from '@/lib/app-context'

const ROWS = ['ai_handled', 'handled', 'auto_sent', 'intercepted'] as const

export function DeckBattleReport({
  report,
  filtered,
  onBackToAll,
}: {
  report?: BattleReport
  /** 是不是被筛选筛空的——那时要给一条「回到全部」的路 */
  filtered: boolean
  onBackToAll: () => void
}): React.ReactNode {
  const { t } = useApp()
  return (
    <div
      data-testid="deck-battle-report"
      className={`flex flex-col items-center justify-center rounded-2xl border bg-card p-6 text-center shadow-sm ${DECK_CARD_MIN_HEIGHT_CLASS}`}
    >
      <p className="text-sm font-medium">{t('deck.empty.title')}</p>
      <p className="mt-1 text-xs text-muted-foreground">{t('deck.recap.hint')}</p>
      <dl className="mx-auto mt-4 grid max-w-md grid-cols-2 gap-3 sm:grid-cols-4">
        {ROWS.map((key) => (
          <div key={key} className="rounded-lg border bg-background px-3 py-2">
            <dt className="text-xs text-muted-foreground">{t(`deck.recap.${key}`)}</dt>
            <dd className="text-lg font-semibold" data-testid={`recap-${key}`}>
              {report?.[key] ?? 0}
            </dd>
          </div>
        ))}
      </dl>
      {filtered ? (
        <Button size="sm" variant="ghost" className="mt-4" onClick={onBackToAll}>
          {t('deck.back_to_all')}
        </Button>
      ) : null}
    </div>
  )
}
