/**
 * WP373（Luoye 10-17）：输入框里 AI 钮右边那个**思考程度**小钮（学 Claude Code 输入框右下「Opus · High」、
 * Codex 的推理强度）。原来藏在 AI 钮菜单最底下一行（WP370），挪出来单独一个钮：
 *
 * - 三档的模型：钮上直接写当前这一档（快 / 标准 / 深度），点一下往上（或往下）弹三档，选了就收；
 * - 官方只声明了开 / 关的模型（`thinking.toggle`）：画成一个开关，点一下就切；
 * - 模型没声明档位：调用方不画这个钮（官方同款：没声明就不出）。
 *
 * 档位映射与默认「标准」照 WP370 不变（服务端 `model-thinking.ts` 给的 `options` / `default`）。
 * 键盘：钮上 ↑↓ 打开，菜单里 ↑↓ 换、回车选、Esc 收起回到钮上。
 */
import { Brain, Check, ChevronDown } from 'lucide-react'
import { type KeyboardEvent, useEffect, useRef, useState } from 'react'
import { Switch } from '@/components/ui/switch'
import { useApp } from '@/lib/app-context'
import type { FreeChatModelThinking, ReasoningEffort, ThinkingLevel } from '@/lib/free-chat'
import { cn } from '@/lib/utils'

/** WP370：思考程度三档的白话词（i18n 键）。 */
export const thinkingKey = (level: ThinkingLevel): string => `model.pick.thinking.${level}`

/** 这一次选的档在不在这个模型里（不在 = 按模型默认）。 */
export function effectiveEffort(
  thinking: FreeChatModelThinking,
  effort: ReasoningEffort | undefined,
): ReasoningEffort {
  if (effort === undefined) return thinking.default
  if (thinking.toggle === true && effort === 'off') return 'off'
  return thinking.options.some((o) => o.effort === effort) ? effort : thinking.default
}

export function ThinkingControl({
  testId,
  thinking,
  effort,
  placement = 'up',
  onPick,
}: {
  testId: string
  thinking: FreeChatModelThinking
  /** 这一次 / 这件事选的（不给 = 模型默认）。 */
  effort: ReasoningEffort | undefined
  placement?: 'up' | 'down'
  onPick: (effort: ReasoningEffort) => void
}): React.ReactNode {
  const { t } = useApp()
  const now = effectiveEffort(thinking, effort)
  if (thinking.toggle === true) {
    const on = thinking.options[0]?.effort
    if (on === undefined) return null
    const checked = now !== 'off'
    return (
      // biome-ignore lint/a11y/noLabelWithoutControl: Switch（radix）就是里面那个控件
      <label
        title={t('model.pick.thinking.toggle.tip')}
        data-testid={`${testId}-thinking`}
        data-toggle
        data-effort={now}
        className="inline-flex h-[30px] shrink-0 cursor-pointer items-center gap-1.5 rounded-full px-2 text-[13px] text-ws-muted-fg hover:bg-muted hover:text-ws-ink"
      >
        <Brain aria-hidden className="size-3.5" />
        <span>{t('model.pick.thinking')}</span>
        <Switch
          size="sm"
          checked={checked}
          aria-label={t('model.pick.thinking')}
          data-testid={`${testId}-thinking-switch`}
          onCheckedChange={(next) => {
            onPick(next ? on : 'off')
          }}
        />
      </label>
    )
  }
  return (
    <LevelsControl
      testId={testId}
      thinking={thinking}
      now={now}
      placement={placement}
      onPick={onPick}
    />
  )
}

function LevelsControl({
  testId,
  thinking,
  now,
  placement,
  onPick,
}: {
  testId: string
  thinking: FreeChatModelThinking
  now: ReasoningEffort
  placement: 'up' | 'down'
  onPick: (effort: ReasoningEffort) => void
}): React.ReactNode {
  const { t } = useApp()
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const current = thinking.options.find((o) => o.effort === now) ?? thinking.options[0]

  // 点外面收起
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (box.current !== null && !box.current.contains(e.target as Node)) setOpen(false)
    }
    globalThis.document?.addEventListener('mousedown', onDown)
    return () => {
      globalThis.document?.removeEventListener('mousedown', onDown)
    }
  }, [open])
  // 开了把焦点放到当前那一档
  useEffect(() => {
    if (!open) return
    const items = [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? [])]
    ;(items.find((el) => el.getAttribute('aria-checked') === 'true') ?? items[0])?.focus()
  }, [open])

  if (current === undefined) return null
  const label = t(thinkingKey(current.level))
  const close = (): void => {
    setOpen(false)
    trigger.current?.focus()
  }
  const onMenuKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      close()
      return
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    e.preventDefault()
    const items = [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? [])]
    const at = items.indexOf(globalThis.document?.activeElement as HTMLElement)
    const next = (at + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
    items[next]?.focus()
  }

  return (
    <div ref={box} className="relative shrink-0">
      <button
        ref={trigger}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('model.pick.thinking.aria', { level: label })}
        title={t('model.pick.thinking.tip')}
        data-testid={`${testId}-thinking`}
        data-level={current.level}
        data-effort={current.effort}
        className="inline-flex h-[30px] items-center gap-1 rounded-full px-2 text-[13px] text-ws-muted-fg hover:bg-muted hover:text-ws-ink"
        onClick={() => {
          setOpen((o) => !o)
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault()
            setOpen(true)
          }
        }}
      >
        <Brain aria-hidden className="size-3.5" />
        <span>{label}</span>
        <ChevronDown aria-hidden className="size-3 opacity-60" />
      </button>
      {open ? (
        <div
          ref={menu}
          role="menu"
          aria-label={t('model.pick.thinking')}
          data-testid={`${testId}-thinking-menu`}
          onKeyDown={onMenuKey}
          className={cn(
            'absolute left-0 z-50 flex w-[148px] flex-col rounded-lg border bg-popover p-1 text-popover-foreground shadow-md',
            placement === 'up' ? 'bottom-full mb-1' : 'top-full mt-1',
          )}
        >
          {thinking.options.map((o) => (
            <button
              key={o.level}
              type="button"
              role="menuitemradio"
              aria-checked={o.effort === current.effort}
              data-testid={`${testId}-thinking-${o.level}`}
              data-effort={o.effort}
              title={t(`${thinkingKey(o.level)}.tip`)}
              className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
              onClick={() => {
                onPick(o.effort)
                close()
              }}
            >
              <span className="flex-1">{t(thinkingKey(o.level))}</span>
              <span className="inline-flex w-3.5 justify-center">
                {o.effort === current.effort ? (
                  <Check aria-hidden className="size-3.5 text-ws-ink" />
                ) : null}
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}
