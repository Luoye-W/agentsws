/**
 * WP264：底部输入卡（决策 180 / 181 / 183 / 179，docs/design/matter/README §4）。
 *
 * - 明显的圆角卡（一圈正文色 14% 的边 + 阴影），两行高，打字自动长高到约 10 行。
 * - 发送是卡内右下角的圆形箭头：空时灰、有字主色；运行中变成「停」，有字时又是箭头（排在这一轮后面）。
 *   悬停「发送（Enter）」；Enter 发送、Shift+Enter 换行，提示只在聚焦或有字时出。
 * - WP412（决策 1221，Luoye 10-19 推翻 178 / 181）：左下「私聊 AI」开关去掉——输入框本来就能当场回答，
 *   有用的问答就该记进这件事。
 * - 左下「+」：WP268 起能加图（点选 / 拖进来 / 粘贴），图先进品牌素材库，发出去的话里带上素材 id。
 *   WP357：同一个「+」 / 拖进来 / 粘贴也收资料（.txt / .md / .docx / .pdf / .xlsx / .csv，与助理同一套，
 *   `isDocFile`）——给了 `onAttachDocs` 才收；收进来是框里一排小签（名字），发出去由调用方带上 `files`。
 *   认不出的文件说一句只收哪几种，不静默。WP357：去掉了置灰的「@」和「即将推出」那类占位字（Luoye 10-16）；
 *   「+」只在调用方不收图也不收资料时置灰。
 *   WP283：现在的改图型号认遮罩时，每张图左下多一个笔刷「圈出要改的地方」（不认的型号不给这个入口）。
 * - 建议输入：框空着、又有合适的下一步时浅灰字直接显示在框里 + 小 Tab 键帽；按 Tab 收下变正文，
 *   打别的字就消失。涉及花钱 / 对外的也只是填进框，仍要人按发送。
 * - **WP456-T8（§3.7）**：「我的助理」也用这一个框（不再是另一种长相）。为它多开的几个口子都是可选的：
 *   `plusMenu`（「+」点开是一个小菜单：附资料、加图，联网 / 公司资料两个开关）、`chips`（框里输入区上面一排小标：
 *   `@` 选的岗位、开着的开关）、`overlay`（框上方的 `@` 菜单）、`onKeyDownFirst` / `onPasteText` / `areaRef`
 *   （`@` 选人、一大段字收成附件）、`notice`（框里说一句）。图可以是素材库的地址，也可以是页面内的 `data:` 图。
 */
import { cn } from 'cn'
import { ArrowUp, Brush, FileText, Plus, Square, X } from 'lucide-react'
import {
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react'
import { type ContextRef, REF_MIME } from '@/components/ask-ai/ask-ai-store'
import { AuthedImage } from '@/components/images/authed-image'
import { useDockReport } from '@/components/shell/composer-dock'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
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
  suggestion,
  sending,
  disabled = false,
  attachments,
  onAttach,
  onDetach,
  onMask,
  attaching = false,
  docked = true,
  placeholderText,
  label,
  testId,
  modelSlot,
  docs,
  onAttachDocs,
  onDetachDoc,
  docProblem = false,
  plusMenu,
  chips,
  sendTrack,
  overlay,
  onKeyDownFirst,
  onPasteText,
  areaRef,
  notice,
  askTarget = false,
  onRefDrop,
}: {
  value: string
  onChange: (v: string) => void
  onSend: () => void
  onStop: () => void
  /** 这件事正在跑（发送位变「停」；还能打字，发出去排在这一轮后面）。 */
  running: boolean
  closed: boolean
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
  /** WP287：占位字换一句（岗位页「问点什么，或交一件事…」那类） */
  placeholderText?: string | undefined
  /** WP287：输入框的无障碍名字（不给 = 事项页那句） */
  label?: string | undefined
  /** WP287：输入框的 `data-testid`（不给就不写） */
  testId?: string | undefined
  /** WP342（决策 853）：左下角的 AI 钮（`ComposerModelPicker`；不给就不画）。 */
  modelSlot?: ReactNode
  /** WP357：已经附上的资料（名字）。 */
  docs?: { name: string }[] | undefined
  /** WP357：收资料（拖进来 / 点「+」/ 粘贴文件）。不给 = 不收资料。 */
  onAttachDocs?: ((files: File[]) => void) | undefined
  onDetachDoc?: ((index: number) => void) | undefined
  /** WP357：有资料没收下（太大 / 太多 / 读不了）——框里说一句只收哪几种。 */
  docProblem?: boolean
  /** WP456-T8：「+」点开是这个小菜单（`DropdownMenuItem` 们）；不给 = 「+」直接开选文件。 */
  plusMenu?: ReactNode
  /** WP456-T8：框里输入区上面那一排小标（`@` 选的岗位、开着的联网 / 公司资料）。 */
  chips?: ReactNode
  /** WP476：发送键的 `data-track`（匿名使用数据的按钮编号；不给 = 按 `matter-send` 记）。 */
  sendTrack?: string | undefined
  /** WP456-T8：贴在框上方的浮层（`@` 菜单）。 */
  overlay?: ReactNode
  /** WP456-T8：按键先给调用方（`@` 菜单的上下 / 回车 / Esc）；回 `true` = 它处理了。 */
  onKeyDownFirst?: ((e: KeyboardEvent<HTMLTextAreaElement>) => boolean) | undefined
  /** WP456-T8：粘贴的是字时先给调用方（一大段字收成附件）；回 `true` = 它收下了。 */
  onPasteText?: ((text: string) => boolean) | undefined
  /** WP456-T8：调用方要拿输入框（`@` 选人时看光标在哪）。 */
  areaRef?: RefObject<HTMLTextAreaElement | null> | undefined
  /** WP456-T8：框里说一句（看不了图、图太大……），和收不下文件那一句同一个位置。 */
  notice?: string | undefined
  /**
   * WP504（决策 1775 A）：第三栏点 ✦「问 AI」时引用小卡飞进**这个**框（挂 `data-ask-ai-target`）。
   * 一页只该有一个框给它（岗位 / 职责 / 事项页的完整对话框）。
   */
  askTarget?: boolean
  /** WP504（F4c）：第三栏的卡拖进来（`application/x-agentsws-ref`）= 和点 ✦ 一样。 */
  onRefDrop?: ((refs: ContextRef[]) => void) | undefined
}): ReactNode {
  const { t } = useApp()
  const ownArea = useRef<HTMLTextAreaElement>(null)
  const area = areaRef ?? ownArea
  const hintId = useId()
  const picker = useRef<HTMLInputElement>(null)
  const canImages = onAttach !== undefined
  const canDocs = onAttachDocs !== undefined
  const canAttach = canImages || canDocs
  const has =
    value.trim() !== '' ||
    (canImages && (attachments ?? []).length > 0) ||
    (canDocs && (docs ?? []).length > 0)
  /** WP357：认不出的文件说一句（不静默）。 */
  const [rejected, setRejected] = useState(false)
  /** WP504：一张卡正拖在框上（框亮一圈「放这里」）。 */
  const [refOver, setRefOver] = useState(false)
  const isRefDrag = (types: readonly string[]): boolean =>
    onRefDrop !== undefined && types.includes(REF_MIME)
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
  const ghost = value === '' && suggestion !== undefined ? suggestion : undefined
  const stopMode = running && !has

  // 自动长高（最多约 10 行，再多在框里滚）
  // biome-ignore lint/correctness/useExhaustiveDependencies: 跟着内容变高
  useEffect(() => {
    const el = area.current
    if (el === null) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`
  }, [value])

  const placeholder =
    placeholderText !== undefined
      ? placeholderText
      : closed
        ? t('matter.cmp.placeholder.closed')
        : running
          ? t('matter.cmp.placeholder.running')
          : t('matter.cmp.placeholder')
  // WP478：告诉外面的底部对话框「框里有没有字 / 附件」（有就不缩成小条）和这一页的占位词（小条上写它）
  useDockReport(has, placeholder)

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

  // WP456-T8：给了 `plusMenu` 时「+」点开是小菜单（附资料 / 加图在菜单里），否则直接开选文件
  const plusButton = (
    <button
      type="button"
      disabled={!canAttach || attaching}
      data-testid="matter-attach"
      aria-label={plusMenu === undefined ? attachLabel : t('assistant.plus')}
      title={plusMenu === undefined ? attachLabel : t('assistant.plus')}
      {...(plusMenu === undefined
        ? {
            onClick: () => {
              picker.current?.click()
            },
          }
        : {})}
      className={cn(
        'grid size-8 place-items-center rounded-md',
        canAttach ? 'text-ws-body hover:bg-muted' : 'text-ws-muted-fg/70',
      )}
    >
      <Plus aria-hidden className="size-[18px]" />
    </button>
  )

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
        data-ask-ai-target={askTarget ? '' : undefined}
        data-ref-over={refOver ? 'true' : undefined}
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
        onDragOver={(e) => {
          const types = [...e.dataTransfer.types]
          if (isRefDrag(types)) {
            e.preventDefault()
            e.dataTransfer.dropEffect = 'copy'
            if (!refOver) setRefOver(true)
            return
          }
          if (canAttach && types.includes('Files')) e.preventDefault()
        }}
        onDragLeave={() => {
          if (refOver) setRefOver(false)
        }}
        onDrop={(e) => {
          if (isRefDrag([...e.dataTransfer.types])) {
            e.preventDefault()
            setRefOver(false)
            try {
              const raw: unknown = JSON.parse(e.dataTransfer.getData(REF_MIME))
              const list = (Array.isArray(raw) ? raw : [raw]).filter(
                (r): r is ContextRef =>
                  typeof r === 'object' &&
                  r !== null &&
                  typeof (r as ContextRef).kind === 'string' &&
                  typeof (r as ContextRef).id === 'string' &&
                  typeof (r as ContextRef).label === 'string' &&
                  Array.isArray((r as ContextRef).facts),
              )
              if (list.length > 0) onRefDrop?.(list)
            } catch {
              // 拖进来的不是一张卡：当没拖
            }
            return
          }
          if (!canAttach || e.dataTransfer.files.length === 0) return
          // 拖进来的文件一律接住（不让浏览器把它当页面打开）；收不下的说一句
          e.preventDefault()
          take(e.dataTransfer.files)
        }}
        onPaste={(e) => {
          if (canAttach && e.clipboardData.files.length > 0) {
            if (take(e.clipboardData.files)) e.preventDefault()
            return
          }
          if (onPasteText?.(e.clipboardData.getData('text/plain')) === true) e.preventDefault()
        }}
        className={cn(
          'ws-composer group/cmp relative rounded-[20px] bg-ws-card transition-[box-shadow,background-color]',
          has && 'is-has',
          refOver && 'ring-2 ring-ws-brand/50',
        )}
      >
        {overlay === undefined || overlay === null ? null : (
          <div className="absolute bottom-full left-0 z-30 mb-2 w-72 max-w-full">{overlay}</div>
        )}
        {canImages && (attachments ?? []).length > 0 ? (
          <div className="flex flex-wrap gap-1.5 px-4 pt-3" data-testid="matter-attachments">
            {(attachments ?? []).map((a) => (
              <div
                key={a.id}
                className="relative size-14 overflow-hidden rounded-lg ring-1 ring-ws-line"
                data-testid="matter-attachment"
              >
                {a.url.startsWith('data:') ? (
                  <img src={a.url} alt="" className="size-full object-cover" />
                ) : (
                  <AuthedImage src={a.url} alt={a.id} className="size-full" />
                )}
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
        {chips === undefined || chips === null ? null : (
          <div className="flex flex-wrap items-center gap-1.5 px-4 pt-3" data-testid="matter-chips">
            {chips}
          </div>
        )}
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
        ) : notice === undefined || notice === '' ? null : (
          <p className="px-4 pt-2 text-[12px] text-ws-warn" data-testid="matter-notice">
            {notice}
          </p>
        )}
        <div className="relative">
          <textarea
            ref={area}
            rows={2}
            value={value}
            disabled={disabled}
            aria-label={label ?? t('matter.say')}
            data-testid={testId}
            aria-describedby={ghost === undefined ? undefined : hintId}
            placeholder={ghost === undefined ? placeholder : ''}
            onChange={(e) => {
              onChange(e.target.value)
            }}
            onKeyDown={(e) => {
              if (onKeyDownFirst?.(e) === true) return
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
              'block max-h-[240px] min-h-14 w-full resize-none overflow-y-auto bg-transparent px-4 pb-1 text-[14px] leading-[22px] text-ws-ink outline-none placeholder:text-ws-muted-fg',
              'pt-3.5',
            )}
          />
          {ghost === undefined ? null : (
            <div
              aria-hidden
              data-testid="matter-suggest"
              className={cn(
                'pointer-events-none absolute inset-x-0 top-0 flex items-baseline gap-2 overflow-hidden px-4 pb-1 text-[14px] leading-[22px] whitespace-nowrap text-ws-muted-fg/80',
                'pt-3.5',
              )}
            >
              <span className="truncate">{ghost}</span>
              <span className="inline-flex h-[18px] shrink-0 items-center rounded-sm bg-ws-surface px-[5px] font-sans text-ws-tiny font-semibold tracking-[0.02em] text-ws-muted-fg shadow-[inset_0_0_0_1px_var(--ws-line),0_1px_0_var(--ws-line)]">
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
          {plusMenu === undefined ? (
            plusButton
          ) : (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>{plusButton}</DropdownMenuTrigger>
              <DropdownMenuContent
                side="top"
                align="start"
                className="w-64 rounded-xl"
                data-testid="composer-plus-menu"
              >
                {plusMenu}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
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
          {modelSlot}
          <span
            aria-hidden
            className="mr-2 ml-auto text-xs whitespace-nowrap text-ws-muted-fg opacity-0 transition-opacity group-focus-within/cmp:opacity-100 group-[.is-has]/cmp:opacity-100"
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
              data-track={sendTrack}
              aria-label={t('matter.cmp.send')}
              title={t('matter.cmp.send')}
              disabled={!has || sending || disabled}
              className={cn(
                'grid size-8 shrink-0 place-items-center rounded-full transition-[background-color,color,transform] active:scale-[.94]',
                !has
                  ? 'bg-muted text-ws-muted-fg/70 dark:bg-input'
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
