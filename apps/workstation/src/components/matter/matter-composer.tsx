/**
 * WP264：底部输入卡（决策 180 / 181 / 183 / 179，docs/design/matter/README §4）。
 *
 * - 明显的圆角卡（一圈正文色 14% 的边 + 阴影），两行高，打字自动长高到约 10 行。
 * - 发送是卡内右下角的圆形箭头：空时灰、有字主色；运行中变成「停」，有字时又是箭头（排在这一轮后面）。
 *   悬停「发送（Enter）」；Enter 发送、Shift+Enter 换行，提示只在聚焦或有字时出。
 * - 左下「私聊 AI」开关（替代原来那块「问 AI」）：打开后整张卡变蓝、顶上一行「只你看得见」。
 * - 左下「+」：WP268 起能加图（点选 / 拖进来 / 粘贴），图先进品牌素材库，发出去的话里带上素材 id。
 *   WP357：同一个「+」 / 拖进来 / 粘贴也收资料（.txt / .md / .docx / .pdf / .xlsx / .csv，与助理同一套，
 *   `isDocFile`）——给了 `onAttachDocs` 才收；收进来是框里一排小签（名字），发出去由调用方带上 `files`。
 *   认不出的文件说一句只收哪几种，不静默。WP357：去掉了置灰的「@」和「即将推出」那类占位字（Luoye 10-16）；
 *   「+」只在私聊 AI 时置灰（那一问不跑岗位、不收附件），悬停说清楚为什么。
 *   WP283：现在的改图型号认遮罩时，每张图左下多一个笔刷「圈出要改的地方」（不认的型号不给这个入口）。
 * - 建议输入：框空着、又有合适的下一步时浅灰字直接显示在框里 + 小 Tab 键帽；按 Tab 收下变正文，
 *   打别的字就消失。涉及花钱 / 对外的也只是填进框，仍要人按发送。
 */
import { cn } from 'cn'
import { ArrowUp, Brush, FileText, Lock, Plus, Square, X } from 'lucide-react'
import { type ReactNode, useEffect, useId, useRef, useState } from 'react'
import { AuthedImage } from '@/components/images/authed-image'
import { BRAND_ASSET_ACCEPT } from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { DOC_EXTENSIONS, isDocFile } from '@/lib/free-chat'

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
  onMask,
  attaching = false,
  docked = true,
  showPrivate = true,
  placeholderText,
  label,
  testId,
  modelSlot,
  docs,
  onAttachDocs,
  onDetachDoc,
  docProblem = false,
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
  attachments?: { id: string; url: string; masked?: boolean }[] | undefined
  onAttach?: ((files: File[]) => void) | undefined
  onDetach?: ((id: string) => void) | undefined
  /** WP283：在这张图上圈区域（不给 = 现在的改图型号不认遮罩，入口不出现）。 */
  onMask?: ((id: string) => void) | undefined
  attaching?: boolean
  /** WP287：贴在页面底部（事项页）；岗位页的输入框不贴底，放在原位 */
  docked?: boolean
  /** WP287：「私聊 AI」开关（岗位页没有——那里发出去就是开一段会话） */
  showPrivate?: boolean
  /** WP287：占位字换一句（岗位页「问点什么，或交一件事…」那类） */
  placeholderText?: string | undefined
  /** WP287：输入框的无障碍名字（不给 = 事项页那句） */
  label?: string | undefined
  /** WP287：输入框的 `data-testid`（不给就不写） */
  testId?: string | undefined
  /** WP342（决策 853）：左下角的 AI 钮（`ComposerModelPicker`；不给就不画）。私聊 AI 时不出（那一问不跑运行）。 */
  modelSlot?: ReactNode
  /** WP357：已经附上的资料（名字）。 */
  docs?: { name: string }[] | undefined
  /** WP357：收资料（拖进来 / 点「+」/ 粘贴文件）。不给 = 不收资料。私聊 AI 时不收。 */
  onAttachDocs?: ((files: File[]) => void) | undefined
  onDetachDoc?: ((index: number) => void) | undefined
  /** WP357：有资料没收下（太大 / 太多 / 读不了）——框里说一句只收哪几种。 */
  docProblem?: boolean
}): ReactNode {
  const { t } = useApp()
  const area = useRef<HTMLTextAreaElement>(null)
  const hintId = useId()
  const picker = useRef<HTMLInputElement>(null)
  const canImages = onAttach !== undefined && !privateMode
  const canDocs = onAttachDocs !== undefined && !privateMode
  const canAttach = canImages || canDocs
  const has =
    value.trim() !== '' ||
    (canImages && (attachments ?? []).length > 0) ||
    (canDocs && (docs ?? []).length > 0)
  /** WP357：认不出的文件说一句（不静默）。 */
  const [rejected, setRejected] = useState(false)
  /** 一把文件分成图 / 资料两路；认不出的记一下。回有没有收下任何一个。 */
  const take = (list: FileList | null | undefined): boolean => {
    const all = [...(list ?? [])]
    if (all.length === 0) return false
    const images = canImages ? all.filter((f) => f.type.startsWith('image/')) : []
    const files = canDocs
      ? all.filter((f) => !f.type.startsWith('image/') && isDocFile(f.name))
      : []
    setRejected(images.length + files.length < all.length)
    if (images.length > 0) onAttach?.(images)
    if (files.length > 0) onAttachDocs?.(files)
    return images.length + files.length > 0
  }
  const accept = [
    ...(canImages ? [BRAND_ASSET_ACCEPT] : []),
    ...(canDocs ? DOC_EXTENSIONS.map((x) => `.${x}`) : []),
  ].join(',')
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
    : placeholderText !== undefined
      ? placeholderText
      : closed
        ? t('matter.cmp.placeholder.closed')
        : running
          ? t('matter.cmp.placeholder.running')
          : t('matter.cmp.placeholder')

  const submit = (): void => {
    if (!has || sending || disabled) return
    setRejected(false)
    onSend()
  }
  const attachLabel = !canAttach
    ? t('matter.cmp.attach')
    : canImages && canDocs
      ? t('matter.cmp.attach.any')
      : canDocs
        ? t('matter.cmp.attach.doc')
        : t('matter.cmp.attach.image')

  return (
    <div
      className={
        docked
          ? 'sticky bottom-0 z-20 bg-gradient-to-b from-transparent to-ws-paper to-[22px] pt-2.5 pb-1'
          : undefined
      }
      data-testid={docked ? 'matter-dock' : undefined}
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
          if (!canAttach || e.dataTransfer.files.length === 0) return
          // 拖进来的文件一律接住（不让浏览器把它当页面打开）；收不下的说一句
          e.preventDefault()
          take(e.dataTransfer.files)
        }}
        onPaste={(e) => {
          if (!canAttach || e.clipboardData.files.length === 0) return
          if (take(e.clipboardData.files)) e.preventDefault()
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
        {canImages && (attachments ?? []).length > 0 ? (
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
                {onMask === undefined ? null : (
                  <button
                    type="button"
                    aria-label={t(
                      a.masked === true ? 'matter.cmp.attach.masked' : 'matter.cmp.attach.mask',
                    )}
                    title={t(
                      a.masked === true ? 'matter.cmp.attach.masked' : 'matter.cmp.attach.mask',
                    )}
                    data-testid="matter-attach-mask"
                    data-masked={a.masked === true ? 'true' : undefined}
                    className={cn(
                      'absolute bottom-0.5 left-0.5 grid size-5 place-items-center rounded-full text-white',
                      a.masked === true ? 'bg-ws-info' : 'bg-black/60',
                    )}
                    onClick={() => {
                      onMask(a.id)
                    }}
                  >
                    <Brush aria-hidden className="size-3" />
                  </button>
                )}
              </div>
            ))}
          </div>
        ) : null}
        {canDocs && (docs ?? []).length > 0 ? (
          <div className="flex flex-wrap gap-1.5 px-4 pt-3" data-testid="matter-docs">
            {(docs ?? []).map((d, i) => (
              <span
                key={`${d.name}:${String(i)}`}
                className="inline-flex max-w-[240px] items-center gap-1 rounded-full border bg-ws-surface py-0.5 pr-1 pl-2 text-[12px] text-ws-body"
                data-testid="matter-doc"
              >
                <FileText aria-hidden className="size-3.5 shrink-0 text-ws-muted-fg" />
                <span className="truncate">{d.name}</span>
                <button
                  type="button"
                  aria-label={t('matter.cmp.doc.remove')}
                  className="grid size-4 place-items-center rounded-full hover:bg-muted"
                  onClick={() => {
                    onDetachDoc?.(i)
                  }}
                >
                  <X aria-hidden className="size-3" />
                </button>
              </span>
            ))}
          </div>
        ) : null}
        {(rejected || docProblem) && canAttach ? (
          <p className="px-4 pt-2 text-[12px] text-ws-warn" data-testid="matter-attach-rejected">
            {t('assistant.doc.bad')}
          </p>
        ) : null}
        <div className="relative">
          <textarea
            ref={area}
            rows={2}
            value={value}
            disabled={disabled}
            aria-label={
              privateMode ? t('matter.cmp.placeholder.private') : (label ?? t('matter.say'))
            }
            data-testid={testId}
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
            aria-label={attachLabel}
            title={attachLabel}
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
              accept={accept}
              className="hidden"
              data-testid="matter-attach-input"
              onChange={(e) => {
                take(e.target.files)
                e.target.value = ''
              }}
            />
          ) : null}
          {privateMode ? null : modelSlot}
          {!showPrivate ? null : (
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
          )}
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
