/**
 * WP188：随便聊顶上的模型下拉。列所有已配好的来源（DeepSeek 账号、各家 key、Agents 工坊（用积分）），
 * 默认是「设置 → 模型」里的默认模型。积分那一条用我们的品牌标记（Luoye 09-29 定），其余用各家图标。
 */
import { Check, ChevronDown, Eye, EyeOff } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { BrandIcon } from '@/components/brand-icons'
import { BrandMark } from '@/components/design'
import { Button } from '@/components/ui/button'
import { useApp } from '@/lib/app-context'
import type { FreeChatModelChoice } from '@/lib/free-chat'

/** `provider_id/model` 的模型名那一半。 */
export const modelNameOf = (id: string): string => id.slice(id.indexOf('/') + 1)

export function ChoiceIcon({
  choice,
}: {
  choice: Pick<FreeChatModelChoice, 'id' | 'official'>
}): React.ReactNode {
  if (choice.official) return <BrandMark size={16} playOnHover />
  return <BrandIcon provider={choice.id.slice(0, choice.id.indexOf('/'))} size={16} />
}

export function ModelPicker({
  choices,
  value,
  onChange,
}: {
  choices: FreeChatModelChoice[]
  value: string | undefined
  onChange: (id: string) => void
}): React.ReactNode {
  const { t } = useApp()
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  // 点外面 / 按 Esc 收起（一个轻量的下拉，不用弹层库：它只有一列按钮）
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (box.current !== null && !box.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    globalThis.document?.addEventListener('mousedown', onDown)
    globalThis.document?.addEventListener('keydown', onKey)
    return () => {
      globalThis.document?.removeEventListener('mousedown', onDown)
      globalThis.document?.removeEventListener('keydown', onKey)
    }
  }, [open])

  const current = choices.find((c) => c.id === value) ?? choices[0]
  if (current === undefined) {
    return (
      <Button size="sm" variant="outline" asChild data-testid="free-chat-no-model">
        <Link to="/settings">{t('free_chat.no_model')}</Link>
      </Button>
    )
  }
  return (
    <div ref={box} className="relative">
      <Button
        size="sm"
        variant="ghost"
        className="max-w-[360px] gap-2"
        aria-haspopup="listbox"
        aria-expanded={open}
        data-testid="free-chat-model"
        data-model={current.id}
        onClick={() => {
          setOpen((o) => !o)
        }}
      >
        <ChoiceIcon choice={current} />
        <span className="truncate">{current.label}</span>
        <span className="truncate text-xs text-muted-foreground">{modelNameOf(current.id)}</span>
        <ChevronDown aria-hidden className="size-3.5 opacity-60" />
      </Button>
      {open ? (
        <div
          role="listbox"
          aria-label={t('free_chat.model.pick')}
          data-testid="free-chat-model-menu"
          className="absolute top-full left-0 z-50 mt-1 flex min-w-[300px] flex-col gap-0.5 rounded-lg border bg-popover p-1 text-popover-foreground shadow-md"
        >
          <p className="px-2 py-1 text-xs text-muted-foreground">{t('free_chat.model.pick')}</p>
          {choices.map((c) => (
            <button
              key={c.id}
              type="button"
              role="option"
              aria-selected={c.id === current.id}
              data-testid="free-chat-model-option"
              data-model={c.id}
              className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
              onClick={() => {
                onChange(c.id)
                setOpen(false)
              }}
            >
              <ChoiceIcon choice={c} />
              <span className="flex min-w-0 flex-col">
                <span className="truncate">{c.label}</span>
                <span className="truncate text-[11px] text-muted-foreground">
                  {modelNameOf(c.id)}
                  {c.official ? ` · ${t('free_chat.model.credits')}` : ''}
                </span>
              </span>
              <span className="ml-auto flex items-center gap-1.5 text-muted-foreground">
                {c.vision === 'no' ? (
                  <EyeOff aria-label={t('free_chat.model.no_vision')} className="size-3.5" />
                ) : (
                  <Eye aria-label={t('free_chat.model.vision')} className="size-3.5" />
                )}
                {c.id === current.id ? <Check aria-hidden className="size-3.5" /> : null}
              </span>
            </button>
          ))}
          <div className="my-0.5 h-px bg-border" />
          <Link
            to="/settings"
            className="rounded-md px-2 py-1.5 text-xs text-muted-foreground hover:bg-accent"
          >
            {t('free_chat.model.manage')}
          </Link>
        </div>
      ) : null}
    </div>
  )
}
