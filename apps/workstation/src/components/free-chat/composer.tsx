/**
 * WP188：随便聊底部的输入框。回车发、Shift+回车换行；能看图的模型可以贴图 / 拖图；
 * 两个开关（默认关）：联网搜索、用公司资料回答。答的时候发送键变成停止键。
 *
 * WP343：打 `@` 弹出岗位 / 职责（↑↓ 选、回车定、Esc 收）——选了输入框上面一个小胶囊，这句话直接交给它。
 *
 * WP350：能附文本类资料（会议记录、文档：.txt / .md / .docx / .pdf，WP357 加 .xlsx / .csv；回形针那个钮；拖进来也行）；
 * 粘贴一大段字（超过 {@link PASTE_AS_FILE_CHARS} 字）收成一份「粘贴的文字」附件，不塞满输入框。
 *
 * WP456-T8（WP456 §3.7）：长相并进岗位页那一个完整对话框（`MatterComposer`，WP437）——这里只剩助理自己的状态
 * （图、资料、`@` 选的岗位、两个开关）。附资料、加图进左下「+」点开的小菜单，联网 / 公司资料是菜单里的两个开关，
 * 开着时在框里显示成一颗小标（点 × 关掉）；发送 / 停、模型钮、拖进来 / 粘贴都和岗位页一样。
 */
import { AtSign, FileText, Globe, ImagePlus, Library, X } from 'lucide-react'
import { useRef, useState } from 'react'
import { MentionMenu, mentionOptions, mentionQuery } from '@/components/free-chat/assistant-bits'
import { MatterComposer } from '@/components/matter/matter-composer'
import {
  DropdownMenuCheckboxItem,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu'
import { useApp } from '@/lib/app-context'
import {
  type AssistantState,
  type AssistantTarget,
  DOC_EXTENSIONS,
  type FreeChatFile,
  type FreeChatImage,
  isDocFile,
  PASTE_AS_FILE_CHARS,
  readDoc,
  readImage,
  textToBase64,
} from '@/lib/free-chat'

const MAX_IMAGES = 4
const MAX_BYTES = 5 * 1024 * 1024
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']
/** WP350：一次最多附几份资料。 */
const MAX_DOCS = 3

export interface ComposerToggles {
  web_search: boolean
  knowledge: boolean
}

/** 框里的一颗小标（`@` 选的岗位、开着的开关），× 去掉。 */
function Chip({
  icon: Icon,
  label,
  removeLabel,
  onRemove,
  testId,
  kind,
}: {
  icon: typeof Globe
  label: string
  removeLabel: string
  onRemove: () => void
  testId: string
  kind?: string
}): React.ReactNode {
  return (
    <span
      className="inline-flex h-6 items-center gap-1 rounded-full bg-ws-tint pr-0.5 pl-2 text-xs text-ws-brand-ink"
      data-testid={testId}
      {...(kind === undefined ? {} : { 'data-kind': kind })}
    >
      <Icon aria-hidden className="size-3.5" />
      {label}
      <button
        type="button"
        aria-label={removeLabel}
        title={removeLabel}
        className="grid size-5 place-items-center rounded-full hover:bg-ws-hover"
        onClick={onRemove}
      >
        <X aria-hidden className="size-3" />
      </button>
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
  targets,
  placeholder,
  modelSlot,
}: {
  busy: boolean
  canSeeImages: boolean
  toggles: ComposerToggles
  /** 联网搜不了时的那句人话（开关变灰，原因写在菜单那一行下面）。 */
  webReason?: string
  knowledgeAvailable: boolean
  onToggles: (next: ComposerToggles) => void
  onSend: (
    text: string,
    images: FreeChatImage[],
    target?: AssistantTarget,
    files?: FreeChatFile[],
  ) => void
  onStop: () => void
  /** WP343：`@` 能选的岗位；不给就没有 `@`。 */
  targets?: AssistantState['targets']
  placeholder?: string
  /** WP342：左下角的 AI 钮（`ComposerModelPicker`；不给就不画）。 */
  modelSlot?: React.ReactNode
}): React.ReactNode {
  const { t } = useApp()
  const hint = placeholder ?? t('free_chat.placeholder')
  const [text, setText] = useState('')
  const [target, setTarget] = useState<AssistantTarget | undefined>(undefined)
  const [query, setQuery] = useState<string | undefined>(undefined)
  const [active, setActive] = useState(0)
  const area = useRef<HTMLTextAreaElement>(null)
  const options = targets === undefined || query === undefined ? [] : mentionOptions(targets, query)
  const menuOpen = targets !== undefined && query !== undefined

  /** 选了一个：把打到一半的 `@…` 从字里拿掉，换成框里的小标。 */
  const pick = (o: AssistantTarget): void => {
    const caret = area.current?.selectionStart ?? text.length
    const before = text.slice(0, caret)
    const at = before.lastIndexOf('@')
    setText(`${text.slice(0, Math.max(0, at))}${text.slice(caret)}`.replace(/^\s+/u, ''))
    setTarget({
      position_id: o.position_id,
      ...(o.role_id === undefined ? {} : { role_id: o.role_id }),
      label: o.label,
    })
    setQuery(undefined)
    setActive(0)
    area.current?.focus()
  }
  const [images, setImages] = useState<FreeChatImage[]>([])
  const [docs, setDocs] = useState<FreeChatFile[]>([])
  const [problem, setProblem] = useState<string | undefined>(undefined)
  const file = useRef<HTMLInputElement>(null)
  const docInput = useRef<HTMLInputElement>(null)

  /** WP350：附资料（不认的扩展名、超过 5 MB 的说一句）。 */
  const addDocs = async (files: File[]): Promise<void> => {
    if (files.length === 0) return
    const ok = files.filter((f) => isDocFile(f.name) && f.size <= MAX_BYTES)
    setProblem(ok.length < files.length ? t('assistant.doc.bad') : undefined)
    const read = await Promise.all(ok.map((f) => readDoc(f)))
    setDocs((prev) => [...prev, ...read].slice(0, MAX_DOCS))
  }

  const addImages = async (files: File[]): Promise<void> => {
    if (files.length === 0) return
    if (!canSeeImages) {
      setProblem(t('free_chat.image.no_vision'))
      return
    }
    const ok = files.filter((f) => IMAGE_TYPES.includes(f.type) && f.size <= MAX_BYTES)
    setProblem(ok.length < files.length ? t('free_chat.image.too_big') : undefined)
    const read = await Promise.all(ok.map((f) => readImage(f)))
    setImages((prev) => [...prev, ...read].slice(0, MAX_IMAGES))
  }

  const send = (): void => {
    if (busy || (text.trim() === '' && images.length === 0 && docs.length === 0)) return
    onSend(text.trim(), images, target, docs.length === 0 ? undefined : docs)
    setText('')
    setImages([])
    setDocs([])
    setTarget(undefined)
    setQuery(undefined)
    setProblem(undefined)
  }

  const webName = t('free_chat.web_search')
  const knowledgeName = t('free_chat.knowledge')
  const chips = [
    ...(target === undefined
      ? []
      : [
          <Chip
            key="target"
            icon={AtSign}
            label={target.label}
            removeLabel={t('assistant.mention.remove')}
            testId="assistant-mention-chip"
            onRemove={() => setTarget(undefined)}
          />,
        ]),
    ...(toggles.web_search
      ? [
          <Chip
            key="web"
            kind="web"
            icon={Globe}
            label={webName}
            removeLabel={t('assistant.toggle.off', { name: webName })}
            testId="assistant-toggle-chip"
            onRemove={() => onToggles({ ...toggles, web_search: false })}
          />,
        ]
      : []),
    ...(toggles.knowledge
      ? [
          <Chip
            key="knowledge"
            kind="knowledge"
            icon={Library}
            label={knowledgeName}
            removeLabel={t('assistant.toggle.off', { name: knowledgeName })}
            testId="assistant-toggle-chip"
            onRemove={() => onToggles({ ...toggles, knowledge: false })}
          />,
        ]
      : []),
  ]

  // 「+」点开：附资料、加图；下面两个开关（开着时框里一颗小标）
  const plusMenu = (
    <>
      <DropdownMenuItem
        data-testid="composer-plus-doc"
        onSelect={() => {
          docInput.current?.click()
        }}
      >
        <FileText aria-hidden />
        {t('assistant.doc.add')}
      </DropdownMenuItem>
      <DropdownMenuItem
        data-testid="composer-plus-image"
        disabled={!canSeeImages}
        {...(canSeeImages ? {} : { title: t('free_chat.image.no_vision') })}
        onSelect={() => {
          file.current?.click()
        }}
      >
        <ImagePlus aria-hidden />
        {t('free_chat.image.add')}
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuCheckboxItem
        data-testid="composer-plus-web"
        checked={toggles.web_search}
        disabled={webReason !== undefined}
        onCheckedChange={(on) => {
          onToggles({ ...toggles, web_search: on === true })
        }}
      >
        <Globe aria-hidden />
        <span className="flex min-w-0 flex-col">
          {webName}
          {webReason === undefined ? null : (
            <span className="text-xs text-ws-muted-fg">{webReason}</span>
          )}
        </span>
      </DropdownMenuCheckboxItem>
      <DropdownMenuCheckboxItem
        data-testid="composer-plus-knowledge"
        checked={toggles.knowledge}
        disabled={!knowledgeAvailable}
        onCheckedChange={(on) => {
          onToggles({ ...toggles, knowledge: on === true })
        }}
      >
        <Library aria-hidden />
        {knowledgeName}
      </DropdownMenuCheckboxItem>
    </>
  )

  return (
    <div className="relative" data-testid="free-chat-composer">
      <input
        ref={file}
        type="file"
        accept={IMAGE_TYPES.join(',')}
        multiple
        hidden
        data-testid="free-chat-image-input"
        onChange={(e) => {
          void addImages([...(e.target.files ?? [])])
          e.target.value = ''
        }}
      />
      <input
        ref={docInput}
        type="file"
        accept={DOC_EXTENSIONS.map((x) => `.${x}`).join(',')}
        multiple
        hidden
        data-testid="free-chat-doc-input"
        onChange={(e) => {
          void addDocs([...(e.target.files ?? [])])
          e.target.value = ''
        }}
      />
      <MatterComposer
        value={text}
        onChange={(v) => {
          setText(v)
          if (targets !== undefined) {
            const caret = area.current?.selectionStart ?? v.length
            const q = mentionQuery(v, caret)
            setQuery(q)
            if (q === undefined) setActive(0)
          }
        }}
        onSend={send}
        onStop={onStop}
        running={busy}
        closed={false}
        sending={busy}
        docked={false}
        placeholderText={hint}
        label={hint}
        testId="free-chat-input"
        areaRef={area}
        modelSlot={modelSlot}
        attachments={images.map((img, i) => ({
          id: String(i),
          url: `data:${img.mime};base64,${img.data}`,
        }))}
        onAttach={(files) => {
          void addImages(files)
        }}
        onDetach={(id) => {
          setImages((prev) => prev.filter((_, j) => String(j) !== id))
        }}
        docs={docs}
        onAttachDocs={(files) => {
          void addDocs(files)
        }}
        onDetachDoc={(i) => {
          setDocs((prev) => prev.filter((_, j) => j !== i))
        }}
        notice={problem}
        plusMenu={plusMenu}
        chips={chips.length === 0 ? undefined : chips}
        overlay={
          menuOpen ? <MentionMenu options={options} active={active} onPick={pick} /> : undefined
        }
        onKeyDownFirst={(e) => {
          if (!menuOpen || e.nativeEvent.isComposing) return false
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault()
            const n = Math.max(1, options.length)
            setActive((i) => (i + (e.key === 'ArrowDown' ? 1 : n - 1)) % n)
            return true
          }
          if (e.key === 'Escape') {
            e.preventDefault()
            setQuery(undefined)
            return true
          }
          if ((e.key === 'Enter' || e.key === 'Tab') && options[active] !== undefined) {
            e.preventDefault()
            pick(options[active] as AssistantTarget)
            return true
          }
          return false
        }}
        // WP350：一大段字（会议记录、聊天记录）收成一份附件
        onPasteText={(pasted) => {
          if (pasted.length <= PASTE_AS_FILE_CHARS || docs.length >= MAX_DOCS) return false
          setDocs((prev) => [
            ...prev,
            {
              name: t('assistant.doc.pasted', { n: prev.length + 1 }),
              data: textToBase64(pasted),
              size: pasted.length,
            },
          ])
          return true
        }}
      />
    </div>
  )
}
