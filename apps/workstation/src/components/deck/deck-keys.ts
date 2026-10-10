/**
 * WP287（Luoye 10-09 真机：复盘卡底下写「→ 就这条 · ← 都不是 · ↑ 稍后」，和卡上的按钮对不上）：
 * **键盘跟着卡上真有的按钮走**——提示行与方向键共用这一张表，表从「这张卡画出来是哪几个按钮」推出来
 * （与 `DeckCardView` 的分支一一对应）。没有对应按钮的方向键不出提示、按了也不做事。
 *
 * - 「知道了」型通知卡（WP277）：→ 第一个选项、← 第二个（「我要退出」不给键盘）；
 * - 交给你的卡（WP276）：只有一个岗位时 → 是那个按钮（字就是按钮上的字），← 是「不接」；
 * - 选项就是按钮的卡（「走哪条职责」）：方向键都不做事（按钮就是答案，键盘不替人挑）；
 * - 其余（动作行）：→ / ← / ↓ 要那个按钮**露在动作行上**（点它才有面板可开），↑「稍后」在 `···` 里也算；
 *   有选项要先选的问句，→ 不做事（裸批准服务端会拒）。
 */
import type { DeckAction, DeckCard } from '@agentsws/deck'
import { deckActionLabel, moreActions, quickActions } from '@/components/deck/deck-action-bar'
import type { DeckDirection } from '@/components/deck/deck-gestures'
import { isHandoffOfferCard, isPeerNoticeCard, noticeKeys } from '@/components/peers/handoff-strip'

const ARROW: Record<DeckDirection, string> = { right: '→', left: '←', up: '↑', down: '↓' }
const ORDER: readonly DeckDirection[] = ['right', 'left', 'up', 'down']
const BY_DIRECTION: Record<DeckDirection, Exclude<DeckAction, 'open'>> = {
  right: 'approve',
  left: 'reject',
  up: 'snooze',
  down: 'instruct',
}

export interface DeckKey {
  direction: DeckDirection
  action: Exclude<DeckAction, 'open'>
  /** 按钮上的字（提示行写的就是它） */
  label: string
  /** 带着这个选项批（通知卡 / 交给你的卡） */
  option?: string
  /** 不直接决定，去点那个按钮（开面板 / 要再确认一次的）：`button[data-action=…]` */
  click?: true
}

/** 这张卡上的方向键（按 → ← ↑ ↓ 排）。 */
export function deckKeys(card: DeckCard, t: (key: string) => string): DeckKey[] {
  const notice = noticeKeys(card)
  if (notice !== undefined) {
    const out: DeckKey[] = []
    if (notice.right !== undefined)
      out.push({
        direction: 'right',
        action: 'approve',
        label: notice.right.label,
        option: notice.right.id,
      })
    if (notice.left !== undefined)
      out.push({
        direction: 'left',
        action: 'approve',
        label: notice.left.label,
        option: notice.left.id,
      })
    return out
  }
  const options = card.options ?? []
  if (isHandoffOfferCard(card)) {
    const out: DeckKey[] = []
    const only = options.length === 1 ? options[0] : undefined
    if (only !== undefined && card.available_actions.includes('approve'))
      out.push({ direction: 'right', action: 'approve', label: only.label, option: only.id })
    if (card.available_actions.includes('reject'))
      out.push({ direction: 'left', action: 'reject', label: t('handoff.decline'), click: true })
    return out
  }
  // 选项就是按钮（「走哪条职责」、② 的通知）——键盘不替人挑
  if ((card.kind === 'claim' && options.length > 0) || isPeerNoticeCard(card)) return []
  const shown = quickActions(card)
  const tucked = moreActions(card)
  const out: DeckKey[] = []
  for (const direction of ORDER) {
    const action = BY_DIRECTION[direction]
    const visible = shown.includes(action)
    if (action === 'snooze' ? !visible && !tucked.includes(action) : !visible) continue
    // 有选项要先选的问句：没选中不存在「同意」，键盘也不是后门
    if (action === 'approve' && options.length > 0) continue
    out.push({
      direction,
      action,
      label: deckActionLabel(card, action, t),
      ...(action === 'reject' ||
      action === 'instruct' ||
      (action === 'approve' && card.reconfirm === true)
        ? { click: true as const }
        : {}),
    })
  }
  return out
}

/** 提示行：「→ 按建议排明天 · ← 我来排 · ↑ 稍后」。 */
export function deckKeyHints(card: DeckCard, t: (key: string) => string): string[] {
  return deckKeys(card, t).map((k) => `${ARROW[k.direction]} ${k.label}`)
}
