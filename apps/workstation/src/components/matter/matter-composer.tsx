/**
 * WP264：底部输入卡（决策 180 / 181 / 183 / 179，docs/design/matter/README §4）。
 *
 * - 明显的圆角卡（一圈正文色 14% 的边 + 阴影），两行高，打字自动长高到约 10 行。
 * - 发送是卡内右下角的圆形箭头：空时灰、有字主色；运行中变成「停」，有字时又是箭头（排在这一轮后面）。
 *   悬停「发送（Enter）」；Enter 发送、Shift+Enter 换行，提示只在聚焦或有字时出。
 * - 左下「私聊 AI」开关（替代原来那块「问 AI」）：打开后整张卡变蓝、顶上一行「只你看得见」。
 * - 左下「+」：WP268 起能加图（点选 / 拖进来 / 粘贴），图先进品牌素材库，发出去的话里带上素材 id；「@」仍置灰。
 * - 建议输入：框空着、又有合适的下一步时浅灰字直接显示在框里 + 小 Tab 键帽；按 Tab 收下变正文，
 *   打别的字就消失。涉及花钱 / 对外的也只是填进框，仍要人按发送。
 */
import { cn } from 'cn'
import { ArrowUp, AtSign, Lock, Plus, Square, X } from 'lucide-react'
import { type ReactNode, useEffect, useId, useRef } from 'react'
import { AuthedImage } from '@/components/images/authed-image'
import { BRAND_ASSET_ACCEPT } from '@/lib/api'
import { useApp } from '@/lib/app-context'

const MAX_HEIGHT = 240

export function MatterComposer({
  value,
  onChange,
  onSend,
  onStop,
  running,
  closed,
  privateMode,
  onTogglePrivate,
  suggestion,
  sending,
  disabled = false,
  attachments,
  onAttach,
  onDetach,
  attaching = false,
}: {
  value: string
  onChange: (v: string) => void
  onSend: () => void
  onStop: () => void
  /** 这件事正在跑（发送位变「停」；还能打字，发出去排在这一轮后面）。 */
  running: boolean
  closed: boolean
  privateMode: boolean
  onTogglePrivate: () => void
  /** 建议输入（没有就是 `undefined`，不硬给）。 */
  suggestion?: string | undefined
  sending: boolean
  disabled?: boolean
  /** WP268：已经加进来的图（素材库 id + 取图地址）。不给 = 「+」照旧置灰。 */
  attachments?: { id: string; url: string }[] | undefined
  onAttach?: ((files: File[]) => void) | undefined
  onDetach?: ((id: string) => void) | undefined
  attaching?: boolean
}): ReactNode {
  const { t } = useApp()
  const area = useRef<HTMLTextAreaElement>(null)
  const hintId = useId()
  const picker = useRef<HTMLInputElement>(null)
  const canAttach = onAttach !== undefined && !privateMode
  const has = value.trim() !== '' || (canAttach && (attachments ?? []).length > 0)
  const imagesOf = (list: FileList | null | undefined): File[] =>
    [...(list ?? [])].filter((f) => f.type.startsWith('image/'))
  const ghost = !privateMode && value === '' && suggestion !== undefined ? suggestion : undefined
  const stopMode = running && !has && !privateMode

  // 自动长高（最多约 10 行，再多在框里滚）
  // biome-ignore lint/correctness/useExhaustiveDependencies: 跟着内容变高
  useEffect(() => {
    const el = area.current
    if (el === null) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`
  }, [value])

  const placeholder = privateMode
    ? t('matter.cmp.placeholder.private')
    : closed
      ? t('matter.cmp.placeholder.closed')
      : running
        ? t('matter.cmp.placeholder.running')
        : t('matter.cmp.placeholder')

  const submit = (): void => {
    if (!has || sending || disabled) return
    onSend()
  }

  return (
    <div
      className="sticky bottom-0 z-20 bg-gradient-to-b from-transparent to-ws-paper to-[22px] pt-2.5 pb-1"
      data-testid="matter-dock"
    >
      <form
        data-testid="matter-say"
        data-mode={privateMode ? 'private' : 'agent'}
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
        onDragOver={(e) => {
          if (canAttach && [...e.dataTransfer.types].includes('Files')) e.preventDefault()
        }}
        onDrop={(e) => {
          if (!canAttach) return
          const files = imagesOf(e.dataTransfer.files)
          if (files.length === 0) return
          e.preventDefault()
          onAttach?.(files)
        }}
        onPaste={(e) => {
          if (!canAttach) return
          const files = imagesOf(e.clipboardData.files)
          if (files.length > 0) onAttach?.(files)
        }}
        className={cn(
          'ws-composer group/cmp relative rounded-[20px] bg-ws-card transition-[box-shadow,background-color]',
          privateMode && 'ws-composer-private',
          has && 'is-has',
        )}
      >
        {privateMode ? (
          <div
            className="flex items-center gap-1.5 px-4 pt-2.5 text-[12px] font-medium text-ws-info"
            data-testid="matter-private-tag"
          >
            <Lock aria-hidden className="size-3" />
            {t('matter.cmp.private.tag')}
          </div>
        ) : null}
        {canAttach && (attachments ?? []).length > 0 ? (
          <div className="flex flex-wrap gap-1.5 px-4 pt-3" data-testid="matter-attachments">
            {(attachments ?? []).map((a) => (
              <div
                key={a.id}
                className="relative size-14 overflow-hidden rounded-[10px] ring-1 ring-ws-line"
              >
                <AuthedImage src={a.url} alt={a.id} className="size-full" />
                <button
                  type="button"
                  aria-label={t('matter.cmp.attach.remove')}
                  className="absolute top-0.5 right-0.5 grid size-5 place-items-center rounded-full bg-black/60 text-white"
                  onClick={() => {
                    onDetach?.(a.id)
                  }}
                >
                  <X aria-hidden className="size-3" />
                </button>
              </div>
            ))}
          </div>
        ) : null}
        <div className="relative">
          <textarea
            ref={area}
            rows={2}
            value={value}
            disabled={disabled}
            aria-label={privateMode ? t('matter.cmp.placeholder.private') : t('matter.say')}
            aria-describedby={ghost === undefined ? undefined : hintId}
            placeholder={ghost === undefined ? placeholder : ''}
            onChange={(e) => {
              onChange(e.target.value)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Tab' && !e.shiftKey && ghost !== undefined) {
                e.preventDefault()
                onChange(ghost)
                return
              }
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                submit()
              }
            }}
            className={cn(
              'block max-h-[240px] min-h-14 w-full resize-none overflow-y-auto bg-transparent px-4 pb-1 text-[15px] leading-[1.55] text-ws-ink outline-none placeholder:text-ws-muted-fg',
              privateMode ? 'pt-1.5' : 'pt-3.5',
            )}
          />
          {ghost === undefined ? null : (
            <div
              aria-hidden
              data-testid="matter-suggest"
              className={cn(
                'pointer-events-none absolute inset-x-0 top-0 flex items-baseline gap-2 overflow-hidden px-4 pb-1 text-[15px] leading-[1.55] whitespace-nowrap text-ws-muted-fg/80',
                privateMode ? 'pt-1.5' : 'pt-3.5',
              )}
            >
              <span className="truncate">{ghost}</span>
              <span className="inline-flex h-[18px] shrink-0 items-center rounded-[5px] bg-ws-surface px-[5px] font-sans text-[10.5px] font-semibold tracking-[0.02em] text-ws-muted-fg shadow-[inset_0_0_0_1px_var(--ws-line),0_1px_0_var(--ws-line)]">
                Tab
              </span>
            </div>
          )}
          {ghost === undefined ? null : (
            <span id={hintId} className="sr-only">
              {t('matter.cmp.suggest', { text: ghost })}
            </span>
          )}
        </div>
        <div className="flex items-center gap-0.5 px-2 pt-1 pb-2">
          <button
            type="button"
            disabled={!canAttach || attaching}
            data-testid="matter-attach"
            aria-label={canAttach ? t('matter.cmp.attach.image') : t('matter.cmp.attach')}
            title={canAttach ? t('matter.cmp.attach.image') : t('matter.cmp.attach')}
            onClick={() => {
              picker.current?.click()
            }}
            className={cn(
              'grid size-8 place-items-center rounded-[10px]',
              canAttach ? 'text-ws-body hover:bg-muted' : 'text-ws-muted-fg/70',
            )}
          >
            <Plus aria-hidden className="size-[18px]" />
          </button>
          {canAttach ? (
            <input
              ref={picker}
              type="file"
              multiple
              accept={BRAND_ASSET_ACCEPT}
              className="hidden"
              onChange={(e) => {
                const files = imagesOf(e.target.files)
                if (files.length > 0) onAttach?.(files)
                e.target.value = ''
              }}
            />
          ) : null}
          <button
            type="button"
            disabled
            aria-label={t('matter.cmp.mention')}
            title={t('matter.cmp.mention')}
            className="grid size-8 place-items-center rounded-[10px] text-ws-muted-fg/70"
          >
            <AtSign aria-hidden className="size-[18px]" />
          </button>
          <button
            type="button"
            role="switch"
            aria-checked={privateMode}
            data-testid="matter-private-toggle"
            title={t('matter.cmp.private.tip')}
            onClick={() => {
              onTogglePrivate()
              area.current?.focus()
            }}
            className={cn(
              'ml-1 inline-flex h-[30px] items-center gap-1.5 rounded-full pr-2.5 pl-2 text-[12.5px] font-medium shadow-[inset_0_0_0_1px_var(--ws-line)]',
              privateMode
                ? 'bg-ws-info-bg text-ws-info shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--ws-info)_40%,transparent)]'
                : 'text-ws-muted-fg hover:bg-muted hover:text-ws-ink',
            )}
          >
            <Lock aria-hidden className="size-3.5" />
            {t('matter.cmp.private')}
            <span
              aria-hidden
              className={cn(
                'relative h-3.5 w-6 rounded-full transition-colors after:absolute after:top-0.5 after:size-2.5 after:rounded-full after:bg-white after:transition-[left]',
                privateMode ? 'bg-ws-info after:left-3' : 'bg-ws-line after:left-0.5',
              )}
            />
          </button>
          <span
            aria-hidden
            className="mr-2 ml-auto text-[11.5px] whitespace-nowrap text-ws-muted-fg opacity-0 transition-opacity group-focus-within/cmp:opacity-100 group-[.is-has]/cmp:opacity-100"
          >
            {t('matter.cmp.hint')}
          </span>
          {stopMode ? (
            <button
              type="button"
              data-testid="matter-stop"
              aria-label={t('matter.cmp.stop')}
              title={t('matter.cmp.stop')}
              onClick={onStop}
              className="grid size-8 shrink-0 place-items-center rounded-full bg-ws-ink text-ws-paper"
            >
              <Square aria-hidden className="size-[13px] fill-current" />
            </button>
          ) : (
            <button
              type="submit"
              data-testid="matter-send"
              aria-label={t('matter.cmp.send')}
              title={t('matter.cmp.send')}
              disabled={!has || sending || disabled}
              className={cn(
                'grid size-8 shrink-0 place-items-center rounded-full transition-[background-color,color,transform] active:scale-[.94]',
                !has
                  ? 'bg-muted text-ws-muted-fg/70 dark:bg-input'
                  : privateMode
                    ? 'bg-ws-info text-white dark:text-ws-paper'
                    : 'bg-ws-brand text-ws-brand-fg hover:bg-[color-mix(in_srgb,var(--ws-brand)_85%,var(--ws-ink))]',
              )}
            >
              <ArrowUp aria-hidden className="size-[17px] stroke-[2.4]" />
            </button>
          )}
        </div>
      </form>
    </div>
  )
}

/** 私聊 AI 的一问一答：只你看得见、不进这件事的记录，关掉就没了（决策 178）；有用的「转给 Agent」。 */
export function PrivatePair({
  question,
  answer,
  error,
  onClose,
  onForward,
}: {
  question: string
  answer?: string | undefined
  error?: string | undefined
  onClose: () => void
  onForward: () => void
}): ReactNode {
  const { t } = useApp()
  return (
    <div
      className="flex flex-col gap-2 rounded-[14px] border border-dashed border-ws-info/50 bg-ws-info-bg/55 px-3 pt-2.5 pb-3"
      data-testid="matter-private-pair"
    >
      <div className="flex items-center gap-1.5 text-[12px] font-medium text-ws-info">
        <Lock aria-hidden className="size-3" />
        {t('matter.private.head')}
        <button
          type="button"
          onClick={onClose}
          aria-label={t('matter.private.close')}
          title={t('matter.private.close')}
          className="ml-auto grid size-6 place-items-center rounded-md text-ws-muted-fg hover:bg-muted hover:text-ws-ink"
          data-testid="matter-private-close"
        >
          ×
        </button>
      </div>
      <p className="self-end rounded-[14px_14px_4px_14px] bg-ws-card px-3 py-[7px] text-[13.5px] whitespace-pre-wrap">
        {question}
      </p>
      {error !== undefined ? (
        <p className="text-[13px] text-ws-bad" role="alert">
          {error}
        </p>
      ) : answer === undefined ? (
        <p className="text-[13px] text-ws-muted-fg">{t('matter.private.asking')}</p>
      ) : (
        <>
          <p
            className="text-[13.5px] leading-[1.65] whitespace-pre-wrap text-ws-ink"
            data-testid="ask-ai-answer"
          >
            {answer}
          </p>
          <button
            type="button"
            onClick={onForward}
            data-testid="matter-private-forward"
            className="self-start text-[12.5px] font-medium text-ws-info hover:underline"
          >
            {t('matter.private.forward')}
          </button>
        </>
      )}
    </div>
  )
}
