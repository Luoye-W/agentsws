/**
 * WP504（决策 1775 A / 1776 A）：**✦ 问 AI** 的按钮与那一下飞入。
 *
 * - {@link AskAiButton}：任何卡 / 数据块右上角，平时不占地方，鼠标移到卡上（或键盘落到它）才出（父元素带 `group/ask`）；
 * - {@link askAi}：把卡放进中栏输入框——卡缩成一枚小卡，约 0.3 秒沿一条弧线飞到输入框，输入框聚焦；
 *   系统或工坊「减少动态」时不飞，直接出现（1776 A）。第三栏不关。
 * - 页面上没有输入框（不在岗位 / 职责 / 事项页）时，先去那个岗位的页面，小卡已经在框里等着。
 *
 * 输入框那一侧认 `[data-ask-ai-target]`（`MatterComposer` 给了 `refs` 时挂上）。
 */
import { Sparkles } from 'lucide-react'
import type { MouseEvent, ReactNode } from 'react'
import { readMotionPref } from '@/components/design/motion-pref'
import { useApp } from '@/lib/app-context'
import { cn } from '@/lib/utils'
import { addRefs, type ContextRef } from './ask-ai-store'

/** 飞多久（毫秒，决策 1776 A）。 */
export const FLY_MS = 300

/** 这一刻该不该动：工坊设成「关」不动；「跟随系统」时看系统的「减少动态」。 */
export function motionAllowed(): boolean {
  const pref = readMotionPref()
  if (pref === 'off') return false
  if (pref === 'on') return true
  return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches !== true
}

/** 页面上那个能收引用的输入框。 */
export function askTarget(): HTMLElement | null {
  return globalThis.document?.querySelector<HTMLElement>('[data-ask-ai-target]') ?? null
}

/**
 * 一条弧线的几帧（纯函数，测试用）：从 `from` 中心到 `to` 左上那一块，中点往上抬
 * （抬多少按两点距离的 1/4，最少 40px）。
 */
export function arcFrames(
  from: { x: number; y: number },
  to: { x: number; y: number },
): { x: number; y: number; scale: number }[] {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const lift = Math.max(40, Math.hypot(dx, dy) / 4)
  return [
    { x: 0, y: 0, scale: 1 },
    { x: dx / 2, y: dy / 2 - lift, scale: 0.85 },
    { x: dx, y: dy, scale: 0.7 },
  ]
}

function flyChip(source: Element, target: HTMLElement, label: string): Promise<void> {
  const doc = globalThis.document
  const a = source.getBoundingClientRect()
  const b = target.getBoundingClientRect()
  const chip = doc.createElement('div')
  chip.textContent = label
  chip.setAttribute('aria-hidden', 'true')
  chip.dataset.testid = 'ask-ai-flying'
  chip.className =
    'pointer-events-none fixed z-[70] max-w-56 truncate rounded-full border border-ws-line bg-ws-card px-3 py-1 text-xs font-medium text-ws-ink shadow-ws-hover'
  const start = { x: a.left + a.width / 2 - 60, y: a.top + Math.min(a.height / 2, 40) - 12 }
  const end = { x: b.left + 16, y: b.top + 10 }
  chip.style.left = `${start.x}px`
  chip.style.top = `${start.y}px`
  doc.body.appendChild(chip)
  const frames = arcFrames(start, end).map((f) => ({
    transform: `translate(${f.x}px, ${f.y}px) scale(${f.scale})`,
  }))
  const done = (): void => {
    chip.remove()
  }
  if (typeof chip.animate !== 'function') {
    done()
    return Promise.resolve()
  }
  const anim = chip.animate(frames, { duration: FLY_MS, easing: 'cubic-bezier(.3,.7,.4,1)' })
  return anim.finished.then(done, done)
}

/**
 * 问 AI：把这几张卡放进中栏输入框。
 *
 * @param from 点的是哪个元素（飞的起点；不给就不飞）
 * @param fallback 页面上没有输入框时去哪（那个岗位的页面）；不给就只放进去
 * @returns 有没有落进页面上的输入框
 */
export function askAi(
  refs: readonly ContextRef[],
  options: { from?: Element | null; fallback?: () => void } = {},
): boolean {
  if (refs.length === 0) return false
  const target = askTarget()
  if (target === null) {
    addRefs(refs)
    options.fallback?.()
    return false
  }
  const land = (): void => {
    addRefs(refs)
  }
  const first = refs[0]
  if (options.from != null && motionAllowed() && first !== undefined) {
    const label = refs.length > 1 ? `${first.label} +${refs.length - 1}` : first.label
    void flyChip(options.from, target, label).then(land)
  } else land()
  return true
}

/**
 * 卡 / 数据块右上角的 ✦（1775：悬停才出）。父元素要带 `group/ask` 与 `relative`。
 * `inline` = 不浮在角上（详情头上那一颗「✦ 问 AI」带字）。
 */
export function AskAiButton({
  refs,
  fallback,
  inline = false,
  className,
  testId = 'ask-ai',
}: {
  refs: () => readonly ContextRef[]
  fallback?: () => void
  inline?: boolean
  className?: string
  testId?: string
}): ReactNode {
  const { t } = useApp()
  const onClick = (e: MouseEvent<HTMLButtonElement>): void => {
    e.stopPropagation()
    e.preventDefault()
    const source =
      (e.currentTarget.closest('[data-ask-ai-source]') as Element | null) ?? e.currentTarget
    askAi(refs(), { from: source, ...(fallback === undefined ? {} : { fallback }) })
  }
  if (inline)
    return (
      <button
        type="button"
        data-testid={testId}
        className={cn(
          'inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs font-medium text-ws-brand hover:bg-ws-tint focus-visible:outline-2 focus-visible:outline-ring',
          className,
        )}
        onClick={onClick}
      >
        <Sparkles aria-hidden className="size-3.5" />
        {t('ask_ai.label')}
      </button>
    )
  return (
    <button
      type="button"
      aria-label={t('ask_ai.label')}
      title={t('ask_ai.label')}
      data-testid={testId}
      className={cn(
        'absolute -top-2 -right-2 z-10 grid size-6 place-items-center rounded-full border border-ws-line bg-ws-card text-ws-brand opacity-0 shadow-ws transition-opacity group-hover/ask:opacity-100 focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-ring',
        className,
      )}
      onClick={onClick}
    >
      <Sparkles aria-hidden className="size-3.5" />
    </button>
  )
}
