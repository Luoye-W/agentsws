/**
 * WP188：随便聊底部的输入框。回车发、Shift+回车换行；能看图的模型可以贴图 / 拖图；
 * 两个开关（默认关）：联网搜索、用公司资料回答。答的时候发送键变成停止键。
 */
import { ArrowUp, Globe, ImagePlus, Library, Square, X } from 'lucide-react'
import { useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Hint } from '@/components/ui/hint'
import { useApp } from '@/lib/app-context'
import { type FreeChatImage, readImage } from '@/lib/free-chat'
import { cn } from '@/lib/utils'

const MAX_IMAGES = 4
const MAX_BYTES = 5 * 1024 * 1024
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

export interface ComposerToggles {
  web_search: boolean
  knowledge: boolean
}

function Toggle({
  on,
  icon: Icon,
  label,
  disabled,
  hint,
  testId,
  onChange,
}: {
  on: boolean
  icon: typeof Globe
  label: string
  disabled?: boolean
  hint?: string
  testId: string
  onChange: (on: boolean) => void
}): React.ReactNode {
  return (
    <span className="inline-flex items-center gap-1">
      <button
        type="button"
        aria-pressed={on}
        disabled={disabled}
        data-testid={testId}
        className={cn(
          'inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs transition-colors disabled:opacity-50',
          on
            ? 'border-ws-brand bg-ws-tint text-ws-brand-ink'
            : 'text-muted-foreground hover:text-foreground',
        )}
        onClick={() => {
          onChange(!on)
        }}
      >
        <Icon aria-hidden className="size-3.5" />
        {label}
      </button>
      {hint === undefined ? null : <Hint text={hint} />}
    </span>
  )
}

export function Composer({
  busy,
  canSeeImages,
  toggles,
  webReason,
  knowledgeAvailable,
  onToggles,
  onSend,
  onStop,
}: {
  busy: boolean
  canSeeImages: boolean
  toggles: ComposerToggles
  /** 联网搜不了时的那句人话（开关变灰，原因进问号）。 */
  webReason?: string
  knowledgeAvailable: boolean
  onToggles: (next: ComposerToggles) => void
  onSend: (text: string, images: FreeChatImage[]) => void
  onStop: () => void
}): React.ReactNode {
  const { t } = useApp()
  const [text, setText] = useState('')
  const [images, setImages] = useState<FreeChatImage[]>([])
  const [problem, setProblem] = useState<string | undefined>(undefined)
  const file = useRef<HTMLInputElement>(null)

  const add = async (files: File[]): Promise<void> => {
    if (files.length === 0) return
    if (!canSeeImages) {
      setProblem(t('free_chat.image.no_vision'))
      return
    }
    const ok = files.filter((f) => IMAGE_TYPES.includes(f.type) && f.size <= MAX_BYTES)
    if (ok.length < files.length) setProblem(t('free_chat.image.too_big'))
    const read = await Promise.all(ok.map((f) => readImage(f)))
    setImages((prev) => [...prev, ...read].slice(0, MAX_IMAGES))
  }

  const send = (): void => {
    if (busy || (text.trim() === '' && images.length === 0)) return
    onSend(text.trim(), images)
    setText('')
    setImages([])
    setProblem(undefined)
  }

  return (
    <fieldset
      className="flex min-w-0 flex-col gap-2 rounded-2xl border bg-ws-card p-3 shadow-ws"
      data-testid="free-chat-composer"
      aria-label={t('free_chat.placeholder')}
      onDragOver={(e) => {
        e.preventDefault()
      }}
      onDrop={(e) => {
        e.preventDefault()
        void add([...e.dataTransfer.files])
      }}
    >
      {images.length === 0 ? null : (
        <div className="flex flex-wrap gap-1.5" data-testid="free-chat-attachments">
          {images.map((img, i) => (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: 还没发出去的图没有 id
              key={i}
              className="relative"
            >
              <img
                src={`data:${img.mime};base64,${img.data}`}
                alt=""
                className="size-14 rounded-md border object-cover"
              />
              <button
                type="button"
                aria-label={t('free_chat.image.remove')}
                className="absolute -top-1.5 -right-1.5 rounded-full border bg-background p-0.5"
                onClick={() => {
                  setImages((prev) => prev.filter((_, j) => j !== i))
                }}
              >
                <X aria-hidden className="size-3" />
              </button>
            </span>
          ))}
        </div>
      )}
      <textarea
        value={text}
        rows={2}
        placeholder={t('free_chat.placeholder')}
        aria-label={t('free_chat.placeholder')}
        data-testid="free-chat-input"
        className="max-h-60 min-h-12 w-full resize-none bg-transparent text-[14px] outline-none placeholder:text-muted-foreground"
        onChange={(e) => {
          setText(e.target.value)
        }}
        onPaste={(e) => {
          const files = [...e.clipboardData.files]
          if (files.length > 0) {
            e.preventDefault()
            void add(files)
          }
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            send()
          }
        }}
      />
      {problem === undefined ? null : <p className="text-xs text-destructive">{problem}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <Toggle
          on={toggles.web_search}
          icon={Globe}
          label={t('free_chat.web_search')}
          disabled={webReason !== undefined}
          testId="free-chat-web-toggle"
          {...(webReason === undefined ? {} : { hint: webReason })}
          onChange={(on) => {
            onToggles({ ...toggles, web_search: on })
          }}
        />
        <Toggle
          on={toggles.knowledge}
          icon={Library}
          label={t('free_chat.knowledge')}
          disabled={!knowledgeAvailable}
          testId="free-chat-knowledge-toggle"
          onChange={(on) => {
            onToggles({ ...toggles, knowledge: on })
          }}
        />
        <span className="ml-auto flex items-center gap-1.5">
          <input
            ref={file}
            type="file"
            accept={IMAGE_TYPES.join(',')}
            multiple
            hidden
            onChange={(e) => {
              void add([...(e.target.files ?? [])])
              e.target.value = ''
            }}
          />
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={t('free_chat.image.add')}
            title={canSeeImages ? t('free_chat.image.add') : t('free_chat.image.no_vision')}
            disabled={!canSeeImages}
            data-testid="free-chat-attach"
            onClick={() => file.current?.click()}
          >
            <ImagePlus aria-hidden />
          </Button>
          {busy ? (
            <Button
              size="icon-sm"
              aria-label={t('free_chat.stop')}
              data-testid="free-chat-stop"
              onClick={onStop}
            >
              <Square aria-hidden className="fill-current" />
            </Button>
          ) : (
            <Button
              size="icon-sm"
              aria-label={t('free_chat.send')}
              data-testid="free-chat-send"
              disabled={text.trim() === '' && images.length === 0}
              onClick={send}
            >
              <ArrowUp aria-hidden />
            </Button>
          )}
        </span>
      </div>
    </fieldset>
  )
}
