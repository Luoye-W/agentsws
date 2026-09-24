/**
 * 四段式的第 ④ 段：动作行（37 §1 第 6 行）。
 *
 * **WP100（09-18 画布收口）：按钮上的字按 `card.layout` 走**（`@agentsws/deck` 的
 * `LAYOUT_VERBS`）。WP96 之后十一种卡的按钮行一律是"批准 / 驳回 / 指导 / 需要补素材 /
 * 稍后"——而画布上它们各说各的话：出站文案卡写**发送**，变体卡写**就这张**，
 * 接管卡写**打开浏览器**。按钮上的字是人按下去之前唯一读的东西，十一种卡共用
 * 三个动词等于把"这一下会发生什么"从界面上抹掉。
 *
 * 换的只有**文案与摆放**：`approve` 还是 `approve`，动作矩阵、路由、审批状态机
 * 一个字没动（36 §2.1 五动作没有第六个）。
 *
 * 摆放三档：
 * - **主动词**：左起第一个，实心。一张卡只有一个；
 * - **次动词**：跟在后面，描边。`outbound` / `change` / `publish` / `money` / `handoff`
 *   各有两个（含"改一下"那一路），其余只有一个；
 * - **`···` 更多**：主次都排不上的那些——多半是「指导」、以及「需要补素材」与
 *   「稍后」。WP15 那条"没有更多菜单"的老规矩这次松了一格，理由是它当初要防的事
 *   （把一堆没想清楚的选项藏起来）与现在做的事正相反：这里收进去的是**三个固定
 *   的安静动作**，让出来的位置给了"这一下会发生什么"。
 */
import type { DeckAction, DeckCard } from '@agentsws/deck'
import { LAYOUT_VERBS, verbKey, verbRank } from '@agentsws/deck'
import { MoreHorizontal } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useApp } from '@/lib/app-context'

export const MAX_QUICK_ACTIONS = 3

/**
 * 按钮行上的那几个：主动词 + 次动词，按 `LAYOUT_VERBS` 排，最多三个。
 *
 * 只出这张卡**真有**的动作（`available_actions` 是服务端按 kind × state 给的，
 * 这里一个都不添）。
 */
export function quickActions(card: DeckCard): DeckAction[] {
  const verbs = LAYOUT_VERBS[card.layout]
  // 排序按**表**走，不按 `available_actions` 的原序：画布上"发送 / 改一下 / 不发"
  // 的顺序是设计的一部分（最常按的那个在最左），而服务端那个数组是按 kind 给的
  const rank = (a: DeckAction): number =>
    a === verbs.primary ? 0 : 1 + (verbs.secondary as readonly DeckAction[]).indexOf(a)
  return card.available_actions
    .filter((a) => a !== 'open' && verbRank(card.layout, a) !== 'more')
    .sort((a, b) => rank(a) - rank(b))
    .slice(0, MAX_QUICK_ACTIONS)
}

/**
 * 这个动作在这张卡上写什么字（按钮行、`···` 菜单、键盘提示行共用一份）。
 *
 * 顺序是有意的：**排版的动词赢过服务端给的 `action_labels`**——后者是 WP15 那版
 * 按 kind 给的中文（只有中文），而排版这一张表是中英齐的，且与画布逐条对得上。
 * 两张表都没有的（`open`）才退回服务端那份与通用动词。
 */
export function deckActionLabel(card: DeckCard, a: DeckAction, t: (key: string) => string): string {
  const key = verbKey(card.layout, a, card.change_kind ?? card.kind)
  if (key !== undefined) return t(key)
  return card.action_labels?.[a] ?? t(`action.${a}`)
}

/** `···` 里的那几个：主次都排不上的动作（多半是「指导」与「稍后」）。 */
export function moreActions(card: DeckCard): DeckAction[] {
  return card.available_actions.filter((a) => a !== 'open' && verbRank(card.layout, a) === 'more')
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
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLSpanElement>(null)
  const quick = quickActions(card)
  const more = moreActions(card)

  // 换卡就把菜单收回去（与折叠区同一条理由：上一张卡的状态不该出现在下一张上）
  // biome-ignore lint/correctness/useExhaustiveDependencies: 依赖就是"换了一张卡"这件事
  useEffect(() => {
    setOpen(false)
  }, [card.id])

  /** 点菜单外面收起来（朴素下拉的那一条必备行为，与岗位卡的 `···` 同一个做法）。 */
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (box.current?.contains(e.target as Node) === true) return
      setOpen(false)
    }
    globalThis.addEventListener?.('mousedown', onDown)
    return () => {
      globalThis.removeEventListener?.('mousedown', onDown)
    }
  }, [open])

  const labelOf = (a: DeckAction): string => deckActionLabel(card, a, t)

  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="deck-action-bar">
      {quick.map((action) => (
        <Button
          key={action}
          size="sm"
          variant={verbRank(card.layout, action) === 'primary' ? 'default' : 'outline'}
          disabled={disabled === true || (action === 'approve' && optionMissing === true)}
          data-action={action}
          data-rank={verbRank(card.layout, action)}
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
      {/*
        安静区收进这一个 `···`：指导（这张卡没把它排进次动词时）、需要补素材、稍后。
        它们不是对这张卡的判断，而是承认现在判断不了——所以不占前面那三个位置。
      */}
      <span className="relative ml-auto inline-flex" ref={box}>
        <button
          type="button"
          aria-expanded={open}
          aria-haspopup="menu"
          aria-label={t('deck.more')}
          title={t('deck.more')}
          data-testid="deck-more"
          disabled={disabled === true}
          className="inline-flex size-7 items-center justify-center rounded-md text-ws-muted-fg hover:bg-ws-surface hover:text-ws-ink disabled:opacity-50"
          onClick={() => {
            setOpen(!open)
          }}
        >
          <MoreHorizontal className="size-4" aria-hidden />
        </button>
        {open ? (
          // 与岗位卡的 `···`、账号块、品牌切换器同一种朴素下拉：一个按钮 + 一张列表
          <div
            role="menu"
            data-testid="deck-more-menu"
            className="absolute right-0 bottom-full z-50 mb-1 flex w-44 flex-col rounded-md border bg-popover p-1 shadow-md"
          >
            {more.map((action) => (
              <button
                key={action}
                type="button"
                role="menuitem"
                data-action={action}
                className="rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent"
                onClick={() => {
                  setOpen(false)
                  onAction(action)
                }}
              >
                {labelOf(action)}
              </button>
            ))}
            <button
              type="button"
              role="menuitem"
              data-action="supplement"
              className="rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent"
              onClick={() => {
                setOpen(false)
                onSupplement()
              }}
            >
              {t('deck.needs_media')}
            </button>
          </div>
        ) : null}
      </span>
    </div>
  )
}
