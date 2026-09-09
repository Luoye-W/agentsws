/**
 * 四段式的第 ④ 段：动作行（37 §1 第 6 行）。
 *
 * 与 WP15 的差别有三处，都是硬性的：
 * - **没有「更多」菜单**。溢出菜单是把一堆没想清楚的选项藏起来的地方；多出来的选择
 *   一律折进「指导」——那里至少还逼人先说清楚这句话管到哪里。
 * - **没有「详情 ▾」按钮**。详情靠点卡面展开（37 §1 第 6 行）。
 * - 右侧是**安静区**：「需要补素材」与「稍后」。它们不是对这张卡的判断，而是承认
 *   现在判断不了，所以和三个快捷决定同排但同样安静——三个决定的位置一个没动。
 */
import type { DeckAction, DeckCard } from '@agentsws/deck'
import { Button } from '@/components/ui/button'
import { useApp } from '@/lib/app-context'

export const MAX_QUICK_ACTIONS = 3

/** 快捷行 = 去掉「打开」「稍后」后的前三个（稍后在安静区，不占快捷位）。 */
export function quickActions(card: DeckCard): DeckAction[] {
  return card.available_actions
    .filter((a) => a !== 'open' && a !== 'snooze')
    .slice(0, MAX_QUICK_ACTIONS)
}

const VARIANT: Partial<Record<DeckAction, 'default' | 'outline' | 'ghost'>> = {
  approve: 'default',
  reject: 'outline',
  instruct: 'outline',
}

export function DeckActionBar({
  card,
  disabled,
  optionMissing,
  onAction,
  onSupplement,
}: {
  card: DeckCard
  disabled?: boolean
  /** 选择题卡还没选 → approve 按不动（36 §2.1：裸 approve 服务端会拒） */
  optionMissing?: boolean
  onAction: (action: DeckAction) => void
  onSupplement: () => void
}): React.ReactNode {
  const { t } = useApp()
  const quick = quickActions(card)
  const canSnooze = card.available_actions.includes('snooze')
  const labelOf = (a: DeckAction): string => card.action_labels?.[a] ?? t(`action.${a}`)

  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="deck-action-bar">
      {quick.map((action) => (
        <Button
          key={action}
          size="sm"
          variant={VARIANT[action] ?? 'outline'}
          disabled={disabled === true || (action === 'approve' && optionMissing === true)}
          data-action={action}
          onClick={() => {
            onAction(action)
          }}
        >
          {labelOf(action)}
        </Button>
      ))}
      {optionMissing === true ? (
        <span className="text-xs text-muted-foreground">{t('deck.option_required')}</span>
      ) : null}
      <Button
        className="ml-auto"
        size="sm"
        variant="ghost"
        disabled={disabled === true}
        data-action="supplement"
        onClick={onSupplement}
      >
        {t('deck.needs_media')}
      </Button>
      {canSnooze ? (
        <Button
          size="sm"
          variant="ghost"
          disabled={disabled === true}
          data-action="snooze"
          onClick={() => {
            onAction('snooze')
          }}
        >
          {labelOf('snooze')}
        </Button>
      ) : null}
    </div>
  )
}
