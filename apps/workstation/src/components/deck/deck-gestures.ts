/**
 * 方向 ↔ 动作的那张表（37 §1 第 1 行的键盘、末行的手机手势）。
 *
 * 键盘和（二阶段的）滑动手势必须**共用同一张表**：右 = 批准、左 = 拒绝、上 = 稍后、
 * 下 = 指导。两处各写一份，迟早会出现「手机上右滑是批准、键盘上右键是拒绝」这种
 * 让人一次点错就发出去的分歧。
 */
import type { DeckAction } from '@agentsws/deck'

export type DeckDirection = 'left' | 'right' | 'up' | 'down'

const BY_DIRECTION: Record<DeckDirection, Exclude<DeckAction, 'open'>> = {
  right: 'approve',
  left: 'reject',
  up: 'snooze',
  down: 'instruct',
}

const BY_KEY: Record<string, DeckDirection> = {
  ArrowRight: 'right',
  ArrowLeft: 'left',
  ArrowUp: 'up',
  ArrowDown: 'down',
}

export function directionForDeckKey(key: string): DeckDirection | undefined {
  return BY_KEY[key]
}

export function deckActionForDirection(direction: DeckDirection): Exclude<DeckAction, 'open'> {
  return BY_DIRECTION[direction]
}

export function directionForDeckAction(action: Exclude<DeckAction, 'open'>): DeckDirection {
  const found = (Object.keys(BY_DIRECTION) as DeckDirection[]).find(
    (d) => BY_DIRECTION[d] === action,
  )
  return found ?? 'up'
}

/**
 * 正在打字的地方，键盘归它。
 *
 * 指导框就在这副牌里面，它的 keydown 会冒泡上来；不挡住的话，人写到一半按个左箭头
 * 想挪光标，卡就飞走了。
 */
export function isTypingTarget(el: HTMLElement | null): boolean {
  if (el === null) return false
  const tag = el.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  return el.isContentEditable
}

export type CountdownFace =
  | { kind: 'expired' }
  /** mm:ss，每秒变一次 */
  | { kind: 'clock'; clock: string }
  | { kind: 'hours'; n: number }
  | { kind: 'days'; n: number }

/** 一小时以内才滴答；再长就换粒度。 */
const HOUR_SECONDS = 3600
const DAY_SECONDS = 24 * HOUR_SECONDS

/**
 * 倒计时的脸。
 *
 * KefuAgent 的 mm:ss 是给「客户此刻坐在对面等一分钟」设计的；我们的卡还有到期在
 * 三天后的，直接套 mm:ss 会印出「剩 6789:08」——那不是倒计时，是一个没人读得懂的
 * 大数。所以一小时以内走 mm:ss 并每秒滴答（37 §1 第 2 行的那一条），超过就换成
 * 小时 / 天，宁可粗一点也要一眼看得懂。
 *
 * 过期是自己的一张脸（`expired`），不是 `0:00`：0:00 会让人以为还有一瞬间。
 */
export function countdownFace(secondsLeft: number): CountdownFace {
  if (!Number.isFinite(secondsLeft) || secondsLeft <= 0) return { kind: 'expired' }
  const total = Math.ceil(secondsLeft)
  if (total < HOUR_SECONDS) {
    const minutes = Math.floor(total / 60)
    const seconds = total % 60
    return { kind: 'clock', clock: `${minutes}:${String(seconds).padStart(2, '0')}` }
  }
  if (total < DAY_SECONDS) return { kind: 'hours', n: Math.floor(total / HOUR_SECONDS) }
  return { kind: 'days', n: Math.floor(total / DAY_SECONDS) }
}

/** mm:ss 倒计时；已过期或超过一小时回 null（那时走 `countdownFace` 的粗粒度）。 */
export function formatCountdown(secondsLeft: number): string | null {
  const face = countdownFace(secondsLeft)
  return face.kind === 'clock' ? face.clock : null
}

/** 距离 `expires_at` 还有多少秒；没有期限回 null（连徽章都不出）。 */
export function secondsLeft(expiresAt: string | undefined, nowMs: number): number | null {
  if (expiresAt === undefined) return null
  const at = Date.parse(expiresAt)
  if (!Number.isFinite(at)) return null
  return (at - nowMs) / 1000
}
