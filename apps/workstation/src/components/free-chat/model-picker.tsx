/**
 * 输入框左下角的 **AI 钮**（WP188 随便聊顶上的模型下拉 → WP342 决策 853：所有输入框共用这一个）。
 *
 * - 列所有已接的模型（工坊账号的、DeepSeek 登录态、各家 key），默认是「设置 → 模型」里的默认模型。
 * - 钮上：工坊账号的模型**只画工坊标记**（名字太长，无障碍名称「工坊」）；自接的画服务商图标 + 短名（型号）。
 * - 选了只改**这一次对话 / 这件事**（调用方存在会话 / 事项上）；「设为默认」一项改品牌默认（只有所有者有）。
 * - 一个都没接：钮换成「还没接 AI」，点了在第三栏开「接模型」连接卡（WP334，不跳设置页）。
 *
 * 一个轻量的下拉，不用弹层库：它只有一列按钮。键盘：↑↓ 换、回车选、Esc 收起并回到钮上。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, ChevronDown, Eye, EyeOff, TriangleAlert } from 'lucide-react'
import { type KeyboardEvent, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { BrandIcon } from '@/components/brand-icons'
import { BrandMark } from '@/components/design'
import { useOpenConnect } from '@/components/setup/use-open-connect'
import { getPositions, setModelDefaults } from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { type FreeChatModelChoice, getFreeChatModels } from '@/lib/free-chat'
import { cn } from '@/lib/utils'

/** `provider_id/model` 的模型名那一半。 */
export const modelNameOf = (id: string): string => id.slice(id.indexOf('/') + 1)

/** 随便聊与各输入框共用的那一份已接模型清单（查询键与随便聊页同一个）。 */
export const MODEL_CHOICES_KEY = ['free-chat', 'models'] as const

export function ChoiceIcon({
  choice,
  size = 16,
}: {
  choice: Pick<FreeChatModelChoice, 'id' | 'official'>
  size?: number
}): React.ReactNode {
  if (choice.official) return <BrandMark size={size} playOnHover />
  return <BrandIcon provider={choice.id.slice(0, choice.id.indexOf('/'))} size={size} />
}

export function ModelPicker({
  choices,
  value,
  onChange,
  defaultId,
  onSetDefault,
  placement = 'up',
  testId = 'model-pick',
}: {
  choices: FreeChatModelChoice[]
  /** 这一次 / 这件事选的（不给 = 跟默认走）。 */
  value: string | undefined
  onChange: (id: string) => void
  /** 品牌默认那一个（菜单里标「默认」；与当前相同就不出「设为默认」）。 */
  defaultId?: string | undefined
  /** 「设为默认」（不给 = 不出这一项：不是所有者改不了品牌默认）。 */
  onSetDefault?: ((id: string) => void) | undefined
  /** 菜单往上开（输入框在页面底部）还是往下开。 */
  placement?: 'up' | 'down'
  testId?: string
}): React.ReactNode {
  const { t } = useApp()
  const openConnect = useOpenConnect()
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)

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

  // 开了就把焦点放到选中的那一项（键盘可达）
  useEffect(() => {
    if (!open) return
    const items = [...(menu.current?.querySelectorAll<HTMLElement>('[data-menu-item]') ?? [])]
    const selected = items.find((el) => el.getAttribute('aria-selected') === 'true') ?? items[0]
    selected?.focus()
  }, [open])

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
    const items = [...(menu.current?.querySelectorAll<HTMLElement>('[data-menu-item]') ?? [])]
    const at = items.indexOf(globalThis.document?.activeElement as HTMLElement)
    const next = (at + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
    items[next]?.focus()
  }

  const current =
    choices.find((c) => c.id === value) ?? choices.find((c) => c.id === defaultId) ?? choices[0]
  if (current === undefined) {
    return (
      // WP334（决策 726）/ WP342（857）：还没接模型——在第三栏就地接（与开工向导第 ① 步同一个件），不跳设置页
      <button
        type="button"
        title={t('model.pick.none.tip')}
        data-testid={`${testId}-none`}
        data-connect="model"
        className="inline-flex h-[30px] items-center gap-1 rounded-full bg-ws-warn-bg px-2.5 text-[12px] font-medium whitespace-nowrap text-ws-warn"
        onClick={() => {
          openConnect('model')
        }}
      >
        <TriangleAlert aria-hidden className="size-3.5" />
        {t('model.pick.none')}
      </button>
    )
  }
  const name = current.official ? t('model.pick.workshop') : modelNameOf(current.id)
  return (
    <div ref={box} className="relative">
      <button
        ref={trigger}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={t('model.pick.aria', { name })}
        title={t('model.pick.tip', { name: current.official ? name : current.label })}
        data-testid={testId}
        data-model={current.id}
        className="inline-flex h-[30px] max-w-[220px] items-center gap-1.5 rounded-full px-2 text-[12.5px] text-ws-muted-fg hover:bg-muted hover:text-ws-ink"
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
        <ChoiceIcon choice={current} />
        {current.official ? null : <span className="truncate">{name}</span>}
        <ChevronDown aria-hidden className="size-3 shrink-0 opacity-60" />
      </button>
      {open ? (
        <div
          ref={menu}
          role="listbox"
          aria-label={t('free_chat.model.pick')}
          data-testid={`${testId}-menu`}
          onKeyDown={onMenuKey}
          className={cn(
            'absolute left-0 z-50 flex min-w-[280px] flex-col gap-0.5 rounded-lg border bg-popover p-1 text-popover-foreground shadow-md',
            placement === 'up' ? 'bottom-full mb-1' : 'top-full mt-1',
          )}
        >
          <p className="px-2 py-1 text-xs text-muted-foreground">{t('free_chat.model.pick')}</p>
          {choices.map((c) => (
            <button
              key={c.id}
              type="button"
              role="option"
              data-menu-item
              aria-selected={c.id === current.id}
              data-testid={`${testId}-option`}
              data-model={c.id}
              className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
              onClick={() => {
                onChange(c.id)
                close()
              }}
            >
              <ChoiceIcon choice={c} />
              <span className="flex min-w-0 flex-col">
                <span className="truncate">{c.label}</span>
                <span className="truncate text-[11px] text-muted-foreground">
                  {modelNameOf(c.id)}
                  {c.official ? ` · ${t('free_chat.model.credits')}` : ''}
                  {c.id === defaultId ? ` · ${t('model.pick.is_default')}` : ''}
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
          {onSetDefault === undefined || current.id === defaultId ? null : (
            <button
              type="button"
              data-menu-item
              title={t('model.pick.default.tip')}
              data-testid={`${testId}-set-default`}
              className="rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
              onClick={() => {
                onSetDefault(current.id)
                close()
              }}
            >
              {t('model.pick.default')}
            </button>
          )}
          <Link
            to="/settings?tab=models"
            data-menu-item
            className="rounded-md px-2 py-1.5 text-xs text-muted-foreground hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
          >
            {t('free_chat.model.manage')}
          </Link>
        </div>
      ) : null}
    </div>
  )
}

/**
 * 输入框里用的那一颗：自己取已接的模型与品牌默认；所有者多一项「设为默认」。
 * `value` / `onChange` 是这一次 / 这件事的选择，由调用方存（会话 / 事项上）。
 */
export function ComposerModelPicker({
  value,
  onChange,
  placement = 'up',
  testId,
}: {
  value: string | undefined
  onChange: (id: string) => void
  placement?: 'up' | 'down'
  testId?: string
}): React.ReactNode {
  const client = useQueryClient()
  const models = useQuery({ queryKey: MODEL_CHOICES_KEY, queryFn: getFreeChatModels, retry: false })
  const positions = useQuery({ queryKey: ['positions'], queryFn: getPositions, retry: false })
  const owner = positions.data?.positions.find((p) => p.role_id === 'common.owner')?.position_id
  const makeDefault = useMutation({
    mutationFn: (id: string) => setModelDefaults({ default: id }, owner),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: MODEL_CHOICES_KEY })
      void client.invalidateQueries({ queryKey: ['models'] })
    },
  })
  // 清单回来之前不画（不然会先闪一下「还没接 AI」）
  if (models.data === undefined) return null
  return (
    <ModelPicker
      choices={models.data.choices}
      value={value}
      onChange={onChange}
      defaultId={models.data.default}
      placement={placement}
      {...(owner === undefined
        ? {}
        : {
            onSetDefault: (id: string) => {
              makeDefault.mutate(id)
            },
          })}
      {...(testId === undefined ? {} : { testId })}
    />
  )
}
