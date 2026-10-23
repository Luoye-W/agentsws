/**
 * WP437（Luoye 10-21）：**简易对话框**——首页用。
 *
 * 「对话框像一个插件一样的简略存在，用户可能在这个页面上会问一些简单的问题」：
 * 底部居中、半透明悬浮（毛玻璃，`ws-composer-glass`），左边「+」附资料，右边发送，占位「有什么要我做的？」。
 * 没有模型 / 思考档 / 快捷按钮（那些在岗位 / 职责 / 事项页的完整对话框里）。
 *
 * 回车 = 交给「我的助理」：这句话（和附上的资料）带过去，助理页接着问——问答、派活照助理原来的逻辑走。
 */
import { ArrowUp, FileText, Plus, X } from 'lucide-react'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { setPendingAsk } from '@/components/free-chat/pending-ask'
import { useAttachedDocs } from '@/components/matter/use-attached-docs'
import { useApp } from '@/lib/app-context'
import { DOC_EXTENSIONS, isDocFile } from '@/lib/free-chat'
import { cn } from '@/lib/utils'

/** 助理页地址（与 `pages/free-chat.tsx` 的 `ASSISTANT_PATH` 同一个；这里不为它把整页拉进来）。 */
const ASSISTANT = '/assistant'
const MAX_HEIGHT = 140

export function SimpleComposer({ testId = 'simple-composer' }: { testId?: string }): ReactNode {
  const { t } = useApp()
  const navigate = useNavigate()
  const [text, setText] = useState('')
  const attached = useAttachedDocs()
  const area = useRef<HTMLTextAreaElement>(null)
  const picker = useRef<HTMLInputElement>(null)
  const has = text.trim() !== '' || attached.docs.length > 0

  // 打字自动长高（最多五六行，再多在框里滚）
  // biome-ignore lint/correctness/useExhaustiveDependencies: 跟着内容变高
  useEffect(() => {
    const el = area.current
    if (el === null) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`
  }, [text])

  const submit = (): void => {
    if (!has) return
    const typed = text.trim()
    const docs = attached.take()
    const said =
      typed !== ''
        ? typed
        : t('matter.file.only', { names: docs.map((d) => `「${d.name}」`).join('') })
    setPendingAsk({ text: said, files: docs })
    setText('')
    navigate(ASSISTANT)
  }

  const take = (list: FileList | null | undefined): void => {
    const files = [...(list ?? [])].filter((f) => isDocFile(f.name))
    if (files.length > 0) attached.add(files)
  }

  return (
    <form
      data-testid={testId}
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
      onDragOver={(e) => {
        if ([...e.dataTransfer.types].includes('Files')) e.preventDefault()
      }}
      onDrop={(e) => {
        if (e.dataTransfer.files.length === 0) return
        e.preventDefault()
        take(e.dataTransfer.files)
      }}
      className={cn(
        'ws-composer-glass flex flex-col rounded-full transition-[box-shadow,background-color]',
      )}
    >
      {attached.docs.length > 0 ? (
        <div className="flex flex-wrap gap-1.5 px-4 pt-3" data-testid="simple-composer-docs">
          {attached.docs.map((d, i) => (
            <span
              key={`${d.name}:${String(i)}`}
              className="inline-flex max-w-[240px] items-center gap-1 rounded-full border bg-ws-surface py-0.5 pr-1 pl-2 text-[12px] text-ws-body"
            >
              <FileText aria-hidden className="size-3.5 shrink-0 text-ws-muted-fg" />
              <span className="truncate">{d.name}</span>
              <button
                type="button"
                aria-label={t('matter.cmp.doc.remove')}
                className="grid size-4 place-items-center rounded-full hover:bg-muted"
                onClick={() => {
                  attached.remove(i)
                }}
              >
                <X aria-hidden className="size-3" />
              </button>
            </span>
          ))}
        </div>
      ) : null}
      {attached.problem ? (
        <p className="px-4 pt-2 text-[12px] text-ws-warn">{t('assistant.doc.bad')}</p>
      ) : null}
      <div className="flex items-end gap-1 p-2">
        <button
          type="button"
          data-testid="simple-composer-attach"
          aria-label={t('home.composer.attach')}
          title={t('home.composer.attach')}
          className="grid size-9 shrink-0 place-items-center rounded-full text-ws-body hover:bg-foreground/[0.06]"
          onClick={() => {
            picker.current?.click()
          }}
        >
          <Plus aria-hidden className="size-[18px]" />
        </button>
        <input
          ref={picker}
          type="file"
          multiple
          accept={DOC_EXTENSIONS.map((x) => `.${x}`).join(',')}
          className="hidden"
          onChange={(e) => {
            take(e.target.files)
            e.target.value = ''
          }}
        />
        <textarea
          ref={area}
          rows={1}
          value={text}
          aria-label={t('home.composer.label')}
          data-testid="simple-composer-input"
          placeholder={t('home.composer.placeholder')}
          onChange={(e) => {
            setText(e.target.value)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              submit()
            }
          }}
          className="block max-h-[140px] min-h-9 flex-1 resize-none overflow-y-auto bg-transparent px-1 py-[7px] text-[14px] leading-[1.45] text-ws-ink outline-none placeholder:text-ws-muted-fg"
        />
        <button
          type="submit"
          data-testid="simple-composer-send"
          aria-label={t('home.composer.send')}
          title={t('home.composer.send')}
          disabled={!has}
          className={cn(
            'grid size-9 shrink-0 place-items-center rounded-full transition-[background-color,color,transform] active:scale-[.94]',
            has
              ? 'bg-ws-brand text-ws-brand-fg hover:bg-[color-mix(in_srgb,var(--ws-brand)_85%,var(--ws-ink))]'
              : 'bg-foreground/[0.06] text-ws-muted-fg/70',
          )}
        >
          <ArrowUp aria-hidden className="size-[17px] stroke-[2.4]" />
        </button>
      </div>
    </form>
  )
}
