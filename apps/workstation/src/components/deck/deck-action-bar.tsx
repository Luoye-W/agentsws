/**
 * 36 §2.1 五动作矩阵的按钮行。
 *
 * 快捷行**最多 3 个按钮**（KefuAgent FR-015）：多出来的塞进「更多」菜单，
 * 「打开」永远在菜单里，不占快捷位。动词来自服务端的 `action_labels`，前端不硬编码。
 */
import type { DeckAction, DeckCard } from '@agentsws/deck'
import { MoreHorizontal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

export const MAX_QUICK_ACTIONS = 3

/** 快捷行 = 去掉「打开」后的前三个。 */
export function quickActions(card: DeckCard): DeckAction[] {
  return card.available_actions.filter((a) => a !== 'open').slice(0, MAX_QUICK_ACTIONS)
}

export function overflowActions(card: DeckCard): DeckAction[] {
  const quick = new Set(quickActions(card))
  return card.available_actions.filter((a) => !quick.has(a))
}

const VARIANT: Partial<Record<DeckAction, 'default' | 'outline' | 'ghost' | 'destructive'>> = {
  approve: 'default',
  reject: 'destructive',
  instruct: 'outline',
  snooze: 'ghost',
  open: 'ghost',
}

export function DeckActionBar({
  card,
  disabled,
  onAction,
  labelOf,
}: {
  card: DeckCard
  disabled?: boolean
  onAction: (action: DeckAction) => void
  labelOf: (action: DeckAction) => string
}): React.ReactNode {
  const quick = quickActions(card)
  const rest = overflowActions(card)
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="deck-action-bar">
      {quick.map((action) => (
        <Button
          key={action}
          size="sm"
          variant={VARIANT[action] ?? 'outline'}
          disabled={disabled === true}
          data-action={action}
          onClick={() => {
            onAction(action)
          }}
        >
          {labelOf(action)}
        </Button>
      ))}
      {rest.length === 0 ? null : (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="ghost" aria-label="更多动作" disabled={disabled === true}>
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {rest.map((action) => (
              <DropdownMenuItem
                key={action}
                data-action={action}
                onSelect={() => {
                  onAction(action)
                }}
              >
                {labelOf(action)}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  )
}
