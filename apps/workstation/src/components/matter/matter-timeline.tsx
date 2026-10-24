/**
 * WP264：事项页的对话式时间线（docs/design/matter/README §3）。
 *
 * 你说的在右边气泡；AI 说的在左边（职责头像 + 名字 + Markdown）；结果 / 审批 / 选择 / 卡住是能直接点的卡；
 * 过程与系统事件缩成居中一行灰字，点开看步骤（决策 182：默认全收起）；正在跑的那次在最底下「正在做…」。
 * 怎么排在 `matter-model.ts`，这里只管画。
 */
import {
  type MatterAttachment,
  type MatterEvent,
  type MatterLiveRun,
  type MatterRunStep,
  splitGenuiReply,
  type ThemeChoicePayload,
} from '@agentsws/contracts'
import type { DeckAction, DeckCard } from '@agentsws/deck'
import { categoryKey } from '@agentsws/deck'
import { cn } from 'cn'
import {
  ArrowLeftRight,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  CircleCheck,
  CirclePause,
  CircleX,
  Copy,
  ExternalLink,
  Eye,
  FileCode,
  FileText,
  Handshake,
  Info,
  LoaderCircle,
  Plug,
  Rocket,
  X,
} from 'lucide-react'
import { type ReactNode, useEffect, useState } from 'react'
import { GenuiHostProvider } from '@/components/answer/genui/genui-host'
import { FootButton, useCardFootHost } from '@/components/deck/card-foot'
import { deckActionLabel } from '@/components/deck/deck-action-bar'
import { focusEvidenceCard } from '@/components/deck/deck-focus'
import { EvidencePill, evidenceLines } from '@/components/deck/evidence-chips'
import { isThemeChoicePayload, ThemeChoiceBody } from '@/components/deck/theme-choice-body'
import { CategoryTag } from '@/components/design/kit'
import { StatusPill } from '@/components/design/primitives'
import { EmailAutoReplyMark } from '@/components/messages/auto-reply-mark'
import { useRailState } from '@/components/rail/rail-state'
import { DutyIcon } from '@/components/role-icons/role-icon'
import { isSetupCard, SetupDeckBody } from '@/components/setup/setup-deck-body'
import { Button } from '@/components/ui/button'
import { SafeMarkdown } from '@/components/ui/safe-markdown'
import { isServiceCard, ServiceCardBody } from '@/components/workshop-services/service-card-body'
import { ServiceOfferLine } from '@/components/workshop-services/service-offer-line'
import { useApp } from '@/lib/app-context'
import { formatDateTime } from '@/lib/format'
import {
  bubbleIsLong,
  digestFacts,
  type MatterItem,
  replyIsLong,
  splitDuration,
} from './matter-model'

type T = (key: string, vars?: Record<string, string | number>) => string

const LOCALE = { zh: 'zh-CN', en: 'en-US' } as const

export function clockOf(iso: string, lang: 'zh' | 'en'): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return new Intl.DateTimeFormat(LOCALE[lang], {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(d)
}

export function durationText(seconds: number, t: T): string {
  const { m, s } = splitDuration(seconds)
  return m === 0 ? t('matter.dur.s', { s }) : t('matter.dur.ms', { m, s })
}

export function DaySep({ at }: { at: string }): ReactNode {
  const { lang } = useApp()
  const label = new Intl.DateTimeFormat(LOCALE[lang], {
    month: 'long',
    day: 'numeric',
    weekday: 'short',
  }).format(new Date(at))
  return (
    <div
      className="flex items-center gap-2.5 text-[12px] text-ws-muted-fg before:h-px before:flex-1 before:bg-ws-line after:h-px after:flex-1 after:bg-ws-line"
      data-testid="matter-day"
    >
      {label}
    </div>
  )
}

/**
 * 职责头像：圆角方块里一枚职责图标（运行中外圈呼吸）。
 * WP456-T3（§3.3）：缩成 22，和「AI · 时间」那一行一样高；正文往里缩进 30（22 + 8）。
 */
export function DutyAvatar({
  roleId,
  live = false,
}: {
  roleId?: string | undefined
  live?: boolean
}): ReactNode {
  return (
    <span
      aria-hidden
      className={cn(
        'relative grid size-[22px] place-items-center rounded-md bg-ws-tint text-ws-ink',
        live &&
          'after:absolute after:-inset-[3px] after:animate-pulse after:rounded-lg after:shadow-[0_0_0_2px_var(--ws-brand)] after:opacity-50 motion-reduce:after:animate-none',
      )}
      style={{ '--ia': 'var(--ws-brand)' } as React.CSSProperties}
    >
      {roleId === undefined ? (
        <Bot className="size-3.5" />
      ) : (
        <DutyIcon role_id={roleId} size={14} />
      )}
    </span>
  )
}

export function MeBubble({
  event,
  queued = false,
}: {
  event: MatterEvent
  queued?: boolean
}): ReactNode {
  const { t, lang } = useApp()
  // WP341：表单交上来的那句只显示摘要（数据段是给 AI 的），长短也按摘要算
  const said = splitGenuiReply(event.text).text
  const long = bubbleIsLong(said)
  const [open, setOpen] = useState(false)
  return (
    <div
      id={event.id}
      data-testid="timeline-event"
      data-kind="human_message"
      className="group/me flex max-w-[min(78%,560px)] flex-col items-end gap-1 self-end target:rounded-xl target:outline-2 target:outline-ws-brand/40"
    >
      <div
        className={cn(
          'rounded-[18px_18px_6px_18px] bg-secondary px-3.5 py-2.5 text-[14px] leading-[1.6] break-words whitespace-pre-wrap text-ws-ink',
          long && !open && 'line-clamp-6',
          queued && 'opacity-70',
        )}
        data-testid="matter-bubble"
      >
        {said}
      </div>
      {/* WP357：这句话附上的资料——名字 · 字数，点开看读出来的文字 */}
      {(event.attachments ?? []).length === 0 ? null : (
        <div className="flex w-full flex-col items-end gap-1" data-testid="matter-bubble-files">
          {(event.attachments ?? []).map((a, i) => (
            <AttachmentChip key={`${a.name}:${String(i)}`} file={a} />
          ))}
        </div>
      )}
      <div className="flex gap-2 text-xs text-ws-muted-fg">
        {long ? (
          <button
            type="button"
            className="ws-link-muted"
            aria-expanded={open}
            onClick={() => {
              setOpen((v) => !v)
            }}
          >
            {open ? t('matter.bubble.less') : t('matter.bubble.more')}
          </button>
        ) : null}
        <span className={cn(!queued && 'opacity-0 transition-opacity group-hover/me:opacity-100')}>
          {queued ? t('matter.run.queued') : clockOf(event.at, lang)}
        </span>
      </div>
    </div>
  )
}

/** WP357：人那句话附上的一份资料。读出来的文字点开看（只在本机事项里）；读不出 / 抹了口令照实说一句。 */
function AttachmentChip({ file }: { file: MatterAttachment }): ReactNode {
  const { t } = useApp()
  const [open, setOpen] = useState(false)
  const readable = file.text !== undefined && file.text !== ''
  return (
    <div className="flex w-full flex-col items-end gap-1" data-testid="matter-bubble-file">
      <button
        type="button"
        disabled={!readable}
        aria-expanded={readable ? open : undefined}
        onClick={() => {
          setOpen((v) => !v)
        }}
        className="inline-flex max-w-full items-center gap-1.5 rounded-full border bg-ws-card px-2.5 py-0.5 text-[12px] text-ws-body hover:border-ws-brand/50 disabled:hover:border-ws-line"
      >
        <FileText aria-hidden className="size-3.5 shrink-0 text-ws-muted-fg" />
        <span className="truncate">{file.name}</span>
        {readable ? (
          <span className="shrink-0 text-ws-muted-fg">
            {t('matter.file.chars', { n: file.chars })}
          </span>
        ) : null}
      </button>
      {file.unreadable === undefined && file.redacted === undefined ? null : (
        <span className="text-xs text-ws-muted-fg">
          {[
            file.unreadable,
            file.redacted === undefined
              ? undefined
              : t('matter.file.redacted', { n: file.redacted }),
          ]
            .filter((x) => x !== undefined)
            .join(' · ')}
        </span>
      )}
      {open && readable ? (
        <pre
          className="max-h-64 w-full overflow-auto rounded-lg bg-ws-surface p-2.5 text-left text-[12px] leading-5 whitespace-pre-wrap text-ws-body"
          data-testid="matter-bubble-file-text"
        >
          {file.text}
        </pre>
      ) : null}
    </div>
  )
}

/** AI 那一条的外壳：头像 + 名字 + 钟点，正文在第二列。 */
export function AiShell({
  id,
  roleId,
  name,
  at,
  live = false,
  head,
  children,
  copyText,
}: {
  id?: string
  roleId?: string | undefined
  name: string
  at?: string
  live?: boolean
  head?: ReactNode
  children: ReactNode
  copyText?: string
}): ReactNode {
  const { t, lang } = useApp()
  const [copied, setCopied] = useState(false)
  return (
    <div
      {...(id === undefined ? {} : { id })}
      data-testid="timeline-event"
      data-kind="agent_message"
      className="group/ai grid grid-cols-[22px_minmax(0,1fr)] gap-x-2 gap-y-1.5 target:rounded-xl target:outline-2 target:outline-ws-brand/40"
    >
      <DutyAvatar roleId={roleId} live={live} />
      {/* WP456-T3（§3.3）：一律「AI · 时间」一行灰字（12），不再是粗体名字 + 另一种灰的钟点 */}
      <div className="flex h-[22px] items-center gap-1 text-xs text-ws-muted-fg">
        <span className="font-medium">{head ?? name}</span>
        {at === undefined ? null : (
          <>
            <span aria-hidden>·</span>
            <span className="ws-num">{clockOf(at, lang)}</span>
          </>
        )}
      </div>
      <div className="col-start-2 min-w-0">
        {children}
        {copyText === undefined ? null : (
          <div className="mt-0.5 flex h-0 gap-0.5 overflow-visible text-ws-muted-fg opacity-0 transition-opacity group-hover/ai:opacity-100 focus-within:opacity-100">
            <button
              type="button"
              aria-label={copied ? t('matter.copied') : t('matter.copy')}
              title={copied ? t('matter.copied') : t('matter.copy')}
              className="grid size-[22px] place-items-center rounded-md hover:bg-muted hover:text-ws-ink"
              onClick={() => {
                void globalThis.navigator?.clipboard?.writeText(copyText).then(
                  () => {
                    setCopied(true)
                  },
                  () => undefined,
                )
              }}
            >
              {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

/** 「预览好了」结果卡：缩略图（占位）、主题名、改了几处、检查结果；打开预览 / 发布上线 / 看改动。 */
export function PreviewCard({
  preview,
  onOpen,
  onPublish,
  publishing,
}: {
  preview: NonNullable<MatterEvent['preview']>
  onOpen: () => void
  onPublish?: (() => void) | undefined
  publishing?: boolean
}): ReactNode {
  const { t } = useApp()
  const [diff, setDiff] = useState(false)
  const files = preview.changed_files
  const meta = [
    files === undefined ? undefined : t('matter.preview.files', { count: files.length }),
    preview.check === undefined
      ? undefined
      : t('matter.preview.check', {
          errors: preview.check.errors,
          warnings: preview.check.warnings,
        }),
  ].filter((x): x is string => x !== undefined)
  return (
    <div className="mt-3 ws-dcard max-w-[520px]" data-testid="matter-preview-card">
      <div className="ws-dcard-head">
        <Eye aria-hidden className="size-3.5" />
        {t('matter.preview.ready')}
        <StatusPill className="ml-auto">{t('matter.preview.unpublished')}</StatusPill>
      </div>
      <div className="ws-dcard-body flex gap-3.5">
        {/* 缩略图先用占位（真截图以后接）：一块深色小页面，几条色块示意分区 */}
        <div
          aria-hidden
          className="flex w-28 shrink-0 flex-col gap-[3px] rounded-lg bg-[#0b0d10] p-[5px] shadow-[0_0_0_1px_var(--ws-line)]"
        >
          <i className="block h-[30px] rounded-[2px] bg-gradient-to-br from-[#1a1e24] to-[#2a2f36]" />
          <i className="block h-4 rounded-[2px] bg-[repeating-linear-gradient(90deg,#1a1e24_0_22px,#0b0d10_22px_25px)]" />
          <i className="block h-3 rounded-[2px] bg-[#1a1e24]" />
          <i className="block h-[9px] rounded-[2px] bg-[#1a1e24]" />
          <i className="block h-1.5 rounded-[2px] bg-ws-brand/70" />
        </div>
        <div className="min-w-0">
          <p className="ws-dcard-title">{preview.label}</p>
          {meta.length === 0 ? null : <p className="ws-dcard-desc">{meta.join(' · ')}</p>}
        </div>
      </div>
      {diff ? (
        <ul
          className="border-t border-ws-line px-5 py-2 font-mono text-xs text-ws-body"
          data-testid="matter-preview-files"
        >
          {files === undefined || files.length === 0 ? (
            <li className="font-sans text-ws-muted-fg">{t('matter.preview.nofiles')}</li>
          ) : (
            files.map((f) => <li key={f}>{f}</li>)
          )}
        </ul>
      ) : null}
      <div className="ws-dcard-foot">
        <Button size="sm" className="gap-1.5" data-testid="matter-preview-open" onClick={onOpen}>
          <ExternalLink aria-hidden />
          {t('matter.preview.open')}
        </Button>
        {onPublish === undefined ? null : (
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5"
            data-testid="matter-preview-publish"
            disabled={publishing === true}
            onClick={onPublish}
          >
            <Rocket aria-hidden />
            {t('matter.preview.publish')}
          </Button>
        )}
        <button
          type="button"
          aria-expanded={diff}
          data-testid="matter-preview-diff"
          onClick={() => {
            setDiff((v) => !v)
          }}
          className="ws-link-muted ml-auto inline-flex items-center gap-1 text-[13px]"
        >
          <FileCode aria-hidden className="size-3" />
          {t('matter.preview.diff')}
        </button>
      </div>
    </div>
  )
}

export function AiEntry({
  item,
  roleId,
  roleName,
  onOpenPreview,
  onPublish,
  publishing,
  onResume,
  resuming,
  resumeLabel,
}: {
  item: Extract<MatterItem, { kind: 'ai' }>
  roleId?: string | undefined
  roleName: string
  onOpenPreview: (url: string) => void
  onPublish?: (() => void) | undefined
  publishing?: boolean
  /** WP236：这一条是被停下来的那次的部分结果——下面出「接着跑」。 */
  onResume?: (() => void) | undefined
  resuming?: boolean
  /** WP423：按钮上的字（预算停的那次写「接着做」）；不给 = 「接着跑」。 */
  resumeLabel?: string
}): ReactNode {
  const { t } = useApp()
  const raw = item.event?.text ?? ''
  // WP336：```dsh-ui 留在正文里，由 SafeMarkdown 就地交给 genui 渲染层（同所有 AI 回话；不再认 ```answer）
  const text = raw
  // 折叠只按字算：```dsh-ui 那段画成组件，不算长度（不然一张表就把整段折起来、组件被截掉）
  const long = replyIsLong(text.replace(/```[ \t]*dsh-ui[\s\S]*?(?:```|$)/gu, ''))
  const [open, setOpen] = useState(false)
  const preview = item.preview?.preview
  const card =
    preview === undefined ? null : (
      <PreviewCard
        preview={preview}
        onOpen={() => {
          onOpenPreview(preview.url)
        }}
        onPublish={onPublish}
        {...(publishing === undefined ? {} : { publishing })}
      />
    )
  const at = item.event?.at ?? item.preview?.at
  return (
    <AiShell
      {...(item.event === undefined ? {} : { id: item.event.id })}
      roleId={roleId}
      name={roleName}
      {...(at === undefined ? {} : { at })}
      {...(text === '' ? {} : { copyText: text })}
    >
      {item.event === undefined ? (
        <p className="text-[14px] leading-[1.7] text-ws-ink">{t('matter.preview.lead')}</p>
      ) : null}
      {card}
      {text === '' ? null : (
        <div className={cn(card !== null && 'mt-3.5')}>
          <div
            className={cn(
              'relative',
              long &&
                !open &&
                'max-h-[240px] overflow-hidden after:absolute after:inset-x-0 after:bottom-0 after:h-[72px] after:bg-gradient-to-b after:from-transparent after:to-ws-paper',
            )}
            data-testid="matter-reply"
            data-folded={long && !open ? 'true' : 'false'}
          >
            {/* WP341：这条回话里的工具按钮按出它的那次运行算（「改前必读」看那次读过的） */}
            <GenuiHostProvider value={{ runId: item.event?.run_id }}>
              <SafeMarkdown text={text} variant="chat" />
            </GenuiHostProvider>
          </div>
          {long ? (
            <button
              type="button"
              aria-expanded={open}
              data-testid="matter-unfold"
              onClick={() => {
                setOpen((v) => !v)
              }}
              className="mt-1.5 inline-flex h-[26px] items-center gap-1 rounded-full bg-ws-card px-2.5 text-[13px] text-ws-body shadow-[inset_0_0_0_1px_var(--ws-line)] hover:text-ws-ink"
            >
              {open ? (
                <ChevronUp aria-hidden className="size-3" />
              ) : (
                <ChevronDown aria-hidden className="size-3" />
              )}
              {open ? t('matter.fold.close') : t('matter.fold.open')}
            </button>
          ) : null}
        </div>
      )}
      {/* WP390（docs/105 §4）：推荐卡——挂在这段话末尾的一行（不是审批卡、不进卡片队列） */}
      {item.event?.service_offer === undefined ? null : (
        <ServiceOfferLine offer={item.event.service_offer} matterId={item.event.matter_id} />
      )}
      {onResume === undefined ? null : (
        <Button
          size="xs"
          variant="outline"
          className="mt-2"
          data-testid="matter-resume"
          disabled={resuming === true}
          onClick={onResume}
        >
          {resumeLabel ?? t('matter.resume')}
        </Button>
      )}
    </AiShell>
  )
}

function StepList({ steps, live = false }: { steps: MatterRunStep[]; live?: boolean }): ReactNode {
  const { t } = useApp()
  return (
    <ul
      className="w-full max-w-[560px] rounded-xl bg-ws-surface px-3 py-2 text-[13px] text-ws-body shadow-[inset_0_0_0_1px_var(--ws-line)]"
      data-testid="matter-steps"
    >
      {steps.map((s, i) => (
        <li
          key={`${String(i)}-${s.text}`}
          className={cn(
            'flex items-center gap-2 py-[3px]',
            s.status === 'running' && 'font-medium text-ws-ink',
          )}
        >
          {s.status === 'ok' ? (
            <Check aria-hidden className="size-3.5 shrink-0 text-ws-good" />
          ) : s.status === 'running' ? (
            <LoaderCircle
              aria-hidden
              className="size-3.5 shrink-0 animate-spin text-ws-brand motion-reduce:animate-none"
            />
          ) : (
            <X aria-hidden className="size-3.5 shrink-0 text-ws-bad" />
          )}
          <span className="min-w-0 truncate font-mono text-xs">{s.text}</span>
          {s.seconds === undefined ? (
            live && s.status === 'running' ? (
              <span className="ml-auto text-xs text-ws-muted-fg">…</span>
            ) : null
          ) : (
            <span className="ml-auto shrink-0 text-xs text-ws-muted-fg tabular-nums">
              {durationText(s.seconds, t)}
            </span>
          )}
        </li>
      ))}
    </ul>
  )
}

/** 居中一行灰字；有步骤 / 有细节的点开看（默认收起）。 */
export function SysLine({
  item,
  roleName,
  currentRole,
  onRoute,
  routing,
  onResume,
  resuming,
  resumeLabel,
  onRetry,
  retrying,
}: {
  item: Extract<MatterItem, { kind: 'sys' }>
  roleName: (role_id: string) => string | undefined
  currentRole?: string | undefined
  onRoute?: ((role_id: string) => void) | undefined
  routing?: boolean
  onResume?: (() => void) | undefined
  resuming?: boolean
  /** WP423：按钮上的字（预算停的那次写「接着做」）；不给 = 「接着跑」。 */
  resumeLabel?: string
  /** WP287：「没跑成」那一行下面的「重试」（只给最近那一条、后面没人接着做时） */
  onRetry?: (() => void) | undefined
  retrying?: boolean
}): ReactNode {
  const { t } = useApp()
  const [open, setOpen] = useState(false)
  const e = item.event
  /** WP287：没问人、自己定的那条职责（还能换）——「按 X 做的 · 换一条」 */
  const settled =
    item.variant === 'route' && e.route?.picked !== undefined && e.route.options.length > 0
  let Icon = Info
  let tone = ''
  let text = e.text
  let detail: ReactNode = null
  if (item.variant === 'run') {
    Icon = Bot
    text = t('matter.sys.ran')
  } else if (item.variant === 'digest' && e.run_digest !== undefined) {
    const d = e.run_digest
    const f = digestFacts(d)
    Icon = d.outcome === 'completed' ? CircleCheck : d.outcome === 'stopped' ? CirclePause : CircleX
    tone =
      d.outcome === 'completed'
        ? 'text-ws-good'
        : d.outcome === 'stopped'
          ? 'text-ws-warn'
          : 'text-ws-bad'
    const facts = [
      f.read > 0 && f.changed === 0 ? t('matter.sys.read', { count: f.read }) : undefined,
      f.changed > 0 ? t('matter.sys.changed', { count: f.changed }) : undefined,
      f.checked ? t('matter.sys.checked') : undefined,
      f.pushed ? t('matter.sys.pushed') : undefined,
    ].filter((x): x is string => x !== undefined)
    text = [
      t(
        d.outcome === 'completed'
          ? 'matter.sys.done'
          : d.outcome === 'stopped'
            ? // WP423：预算停的写人话原因（「查的东西太多，这一轮先停在这里」）
              d.budget === undefined
              ? 'matter.sys.stopped'
              : `matter.sys.budget.${d.budget}`
            : 'matter.sys.failed',
      ),
      durationText(d.seconds, t),
      ...(facts.length > 0
        ? facts
        : d.steps.length > 0
          ? [t('matter.sys.steps', { count: d.steps.length })]
          : []),
    ].join(' · ')
    if (d.steps.length > 0) detail = <StepList steps={d.steps} />
  } else if (item.variant === 'route') {
    Icon = ArrowLeftRight
    const picked = e.route?.picked
    const name = picked === undefined ? undefined : roleName(picked)
    if (name !== undefined)
      text = t(
        // WP291：一开始就记成任务的那一行（原话后面头一句）
        e.route?.task === true
          ? 'matter.sys.task'
          : settled
            ? 'matter.sys.settled'
            : 'matter.sys.routed',
        { role: name },
      )
    const options = (e.route?.options ?? []).filter((o) => o.role_id !== currentRole)
    detail = (
      <div className="flex max-w-[560px] flex-col items-center gap-2 text-center text-[13px] text-ws-body">
        {name === undefined || e.route?.task === true ? null : <p>{e.text}</p>}
        {onRoute === undefined || options.length === 0 ? null : (
          <div className="flex flex-wrap justify-center gap-1.5" data-testid="matter-route-options">
            {options.map((o) => (
              <Button
                key={o.role_id}
                size="xs"
                variant="outline"
                data-role={o.role_id}
                disabled={routing === true}
                onClick={() => {
                  onRoute(o.role_id)
                }}
              >
                {t(picked === undefined ? 'matter.route.go' : 'matter.route.switch', {
                  role: o.role_name,
                })}
              </Button>
            ))}
          </div>
        )}
      </div>
    )
    if (
      (name === undefined || e.route?.task === true) &&
      (onRoute === undefined || options.length === 0)
    )
      detail = null
  } else if (item.variant === 'blocked') {
    Icon = Plug
    tone = 'text-ws-warn'
    const what = e.blocked?.connections.join('、') ?? ''
    text = `${what === '' ? e.text : t('matter.sys.blocked', { what })} · ${t('matter.sys.blocked.later')}`
  } else if (item.variant === 'stopped') {
    Icon = CirclePause
    tone = 'text-ws-warn'
  } else if (item.variant === 'failed') {
    Icon = CircleX
    tone = 'text-ws-bad'
  }
  const expandable = detail !== null
  return (
    <div
      id={e.id}
      className="flex flex-col items-center gap-2"
      data-testid="timeline-event"
      data-kind={e.kind}
      data-sys={item.variant}
    >
      <div className="flex max-w-full items-center gap-1.5">
        <button
          type="button"
          disabled={!expandable}
          aria-expanded={expandable ? open : undefined}
          title={expandable ? t('matter.sys.expand') : undefined}
          onClick={() => {
            setOpen((v) => !v)
          }}
          className="inline-flex max-w-full items-center gap-1.5 rounded-full px-2.5 py-[3px] text-[13px] text-ws-muted-fg enabled:hover:bg-muted enabled:hover:text-ws-body disabled:cursor-default"
        >
          <Icon aria-hidden className={cn('size-3.5 shrink-0', tone)} />
          <span className="truncate">{text}</span>
          {expandable && !(settled && !open) ? (
            <ChevronRight
              aria-hidden
              className={cn('size-3 shrink-0 transition-transform', open && 'rotate-90')}
            />
          ) : null}
        </button>
        {settled && expandable && !open ? (
          <button
            type="button"
            data-testid="matter-route-switch"
            className="text-[13px] text-ws-muted-fg underline-offset-2 hover:text-ws-ink hover:underline"
            onClick={() => {
              setOpen(true)
            }}
          >
            · {t('matter.route.another')}
          </button>
        ) : null}
        {onResume === undefined ? null : (
          <Button
            size="xs"
            variant="outline"
            data-testid="matter-resume"
            disabled={resuming === true}
            onClick={onResume}
          >
            {resumeLabel ?? t('matter.resume')}
          </Button>
        )}
        {onRetry === undefined || item.variant !== 'failed' ? null : (
          <Button
            size="xs"
            variant="outline"
            data-testid="matter-retry"
            disabled={retrying === true}
            onClick={onRetry}
          >
            {t('matter.retry')}
          </Button>
        )}
      </div>
      {open && expandable ? detail : null}
    </div>
  )
}

/** 正在跑：左侧「正在做…」+ 当前一步（字面上一道流光），点开实时步骤。 */
export function RunningEntry({
  live,
  roleId,
  roleName,
}: {
  live?: MatterLiveRun | undefined
  roleId?: string | undefined
  roleName: string
}): ReactNode {
  const { t } = useApp()
  const [open, setOpen] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now())
    }, 1000)
    return () => {
      clearInterval(timer)
    }
  }, [])
  const steps = live?.steps ?? []
  const current =
    [...steps].reverse().find((s) => s.status === 'running') ?? steps[steps.length - 1]
  const started = live === undefined ? undefined : Date.parse(live.started_at)
  const elapsed =
    started === undefined || Number.isNaN(started) ? undefined : (now - started) / 1000
  return (
    <div
      className="grid grid-cols-[22px_minmax(0,1fr)] gap-x-2 gap-y-1.5"
      data-testid="matter-running"
      aria-live="polite"
    >
      <DutyAvatar roleId={roleId} live />
      <div className="flex h-[22px] items-center gap-2 text-xs font-medium text-ws-ink">
        <span className="text-ws-brand-ink dark:text-ws-brand">{t('matter.run.doing')}</span>
        <span className="sr-only">{roleName}</span>
        {elapsed === undefined ? null : (
          <span className="font-normal text-xs text-ws-muted-fg tabular-nums">
            {t('matter.run.elapsed', { dur: durationText(Math.max(0, elapsed), t) })}
          </span>
        )}
      </div>
      <div className="col-start-2 min-w-0">
        <button
          type="button"
          disabled={steps.length === 0}
          aria-expanded={steps.length === 0 ? undefined : open}
          data-testid="matter-running-now"
          onClick={() => {
            setOpen((v) => !v)
          }}
          className="ws-disclosure -mx-1 inline-flex items-center gap-2 px-1 py-0.5 text-[14px] text-ws-body disabled:cursor-default"
        >
          <LoaderCircle
            aria-hidden
            className="size-3.5 animate-spin text-ws-brand motion-reduce:animate-none"
          />
          <span className="ws-shimmer">
            {current === undefined ? t('matter.run.preparing') : current.text}
          </span>
          {steps.length === 0 ? null : (
            <span className="text-[12px] text-ws-muted-fg tabular-nums">
              {t('matter.run.step', { n: steps.length })}
            </span>
          )}
          {steps.length === 0 ? null : open ? (
            <ChevronDown aria-hidden className="size-3" />
          ) : (
            <ChevronRight aria-hidden className="size-3" />
          )}
        </button>
        {open && steps.length > 0 ? (
          <div className="mt-2 max-w-[520px]">
            <StepList steps={steps} live />
          </div>
        ) : null}
        {/* WP287：AI 边做边说的话，流式出现在线程里（跑完以时间线上那条为准） */}
        {live?.text === undefined ? null : (
          <p
            className="mt-1.5 max-w-[640px] text-[14px] leading-[1.7] whitespace-pre-wrap text-ws-ink"
            data-testid="matter-running-text"
          >
            {live.text}
          </p>
        )}
      </div>
    </div>
  )
}

/** 卡住了（最新一条时）：红边卡，「去连接」「接着做」。 */
export function BlockedCard({
  event,
  roleId,
  roleName,
  onConnect,
  onGo,
  going,
}: {
  event: MatterEvent
  roleId?: string | undefined
  roleName: string
  onConnect: () => void
  onGo: () => void
  going: boolean
}): ReactNode {
  const { t } = useApp()
  const what = event.blocked?.connections.join('、') ?? ''
  return (
    <AiShell id={event.id} roleId={roleId} name={roleName} at={event.at}>
      <p className="text-[14px] leading-[1.7] text-ws-ink">{event.text}</p>
      <div className="mt-3 ws-dcard max-w-[520px]" data-testid="matter-blocked-card">
        <div className="ws-dcard-head">
          <Plug aria-hidden className="size-3.5" />
          {t('matter.blocked.head')}
          <StatusPill tone="bad" className="ml-auto">
            {t('matter.blocked.pill')}
          </StatusPill>
        </div>
        <div className="ws-dcard-body">
          <p className="ws-dcard-title">
            {what === '' ? t('matter.blocked.title.any') : t('matter.blocked.title', { what })}
          </p>
          <p className="ws-dcard-desc">{t('matter.blocked.hint')}</p>
        </div>
        <div className="ws-dcard-foot">
          <Button
            size="sm"
            className="gap-1.5"
            data-testid="matter-blocked-connect"
            data-connect={event.blocked?.services?.join('+') ?? ''}
            onClick={onConnect}
          >
            <Plug aria-hidden />
            {t('matter.blocked.connect')}
          </Button>
          <Button
            size="sm"
            variant="outline"
            data-testid="matter-blocked-go"
            disabled={going}
            onClick={onGo}
          >
            {t('matter.blocked.go')}
          </Button>
        </div>
      </div>
    </AiShell>
  )
}

/** 路由还没定职责：选择卡（琥珀边），按钮就是候选职责（WP237 那几个，点了钉到那条并开跑）。 */
export function ChoiceCard({
  event,
  onRoute,
  routing,
}: {
  event: MatterEvent
  onRoute: (role_id: string) => void
  routing: boolean
}): ReactNode {
  const { t } = useApp()
  return (
    <AiShell id={event.id} name={t('matter.card.choice')} at={event.at}>
      <div className="ws-dcard max-w-[520px]" data-testid="matter-choice-card">
        <p className="ws-dcard-body pt-4 text-ws-read text-ws-ink">{event.text}</p>
        <div className="ws-dcard-foot" data-testid="matter-route-options">
          {(event.route?.options ?? []).map((o) => (
            <Button
              key={o.role_id}
              size="sm"
              variant="outline"
              data-testid="matter-route-go"
              data-role={o.role_id}
              disabled={routing}
              onClick={() => {
                onRoute(o.role_id)
              }}
            >
              {t('matter.route.go', { role: o.role_name })}
            </Button>
          ))}
        </div>
      </div>
    </AiShell>
  )
}

const WAITING = new Set(['proposed', 'pending', 'in_review', 'deferred'])
const APPROVED = new Set(['approved', 'approved_edited', 'auto_approved', 'applying', 'applied'])

/** 这张卡还在等人批吗（页头「等你批」与输入框建议都看它）。 */
export function cardWaiting(card: DeckCard | undefined): boolean {
  return card !== undefined && WAITING.has(card.status)
}

/** 审批 / 选择卡内嵌在对话里：能直接批；批过缩成一行。 */
export function InlineCard({
  event,
  card,
  loading,
  roleId,
  roleName,
  onDecide,
  deciding,
}: {
  event: MatterEvent
  card?: DeckCard | undefined
  loading: boolean
  roleId?: string | undefined
  roleName: string
  onDecide: (card: DeckCard, action: Exclude<DeckAction, 'open'>, option?: string) => void
  deciding: boolean
}): ReactNode {
  const { t, lang } = useApp()
  if (card === undefined)
    return (
      <AiShell id={event.id} roleId={roleId} name={roleName} at={event.at}>
        <p className="text-[13px] text-ws-muted-fg" data-testid="matter-card-missing">
          {loading ? t('matter.card.loading') : `${event.text} · ${t('matter.card.gone')}`}
        </p>
      </AiShell>
    )
  // WP440（docs/108 M9）：AI 按把握直接回了的那封——「AI 直接回 · 出处」+「这封不该直接回」
  if (!WAITING.has(card.status) && card.auto_reply !== undefined)
    return (
      <AiShell id={event.id} roleId={roleId} name={roleName} at={event.at}>
        <div
          className="flex max-w-[520px] flex-col gap-1 rounded-2xl border border-ws-line bg-ws-surface px-3.5 py-2.5"
          data-testid="matter-card-auto-reply"
          data-status={card.status}
        >
          <div className="flex items-center gap-2">
            {card.status === 'applied' ? (
              <CircleCheck aria-hidden className="size-3.5 text-ws-good" />
            ) : (
              <CircleX aria-hidden className="size-3.5 text-ws-muted-fg" />
            )}
            <span className="min-w-0 truncate text-[13px] font-medium text-ws-body">
              {card.title}
            </span>
            <span className="ml-auto shrink-0 text-[12px] text-ws-muted-fg">
              {clockOf(event.at, lang)}
            </span>
          </div>
          <EmailAutoReplyMark approvalItemId={card.id} sources={card.auto_reply.sources} />
        </div>
      </AiShell>
    )
  if (!WAITING.has(card.status)) {
    // WP324：连接卡 / 配置卡补完（人点的、或在别处连好自动收起的）说「已连上 / 已设好」，不说「你批了」
    const setupDone =
      isSetupCard(card) && (APPROVED.has(card.status) || card.status === 'withdrawn')
    const key = setupDone
      ? card.kind === 'setup_request'
        ? 'setup.card.done.setup'
        : 'setup.card.done.connect'
      : APPROVED.has(card.status)
        ? 'matter.card.approved'
        : card.status === 'rejected'
          ? 'matter.card.rejected'
          : 'matter.card.done'
    // WP510（决策 1515）：② / ③ 里别人定的写上是谁（「林峰批了」）；自己定的、① 里照旧「你批了」
    const by = setupDone ? undefined : card.decided_by
    const label =
      by === undefined
        ? t(key, { title: card.title })
        : t(`${key}_by`, { name: by.name, title: card.title })
    const good = setupDone || APPROVED.has(card.status)
    return (
      <AiShell id={event.id} roleId={roleId} name={roleName} at={event.at}>
        <div
          className="flex max-w-[520px] items-center gap-2 rounded-2xl border border-ws-line bg-ws-surface px-3.5 py-2.5 opacity-90"
          data-testid="matter-card-done"
          data-status={card.status}
        >
          {good ? (
            <CircleCheck aria-hidden className="size-3.5 text-ws-good" />
          ) : (
            <CircleX aria-hidden className="size-3.5 text-ws-muted-fg" />
          )}
          <span
            className={cn(
              'min-w-0 truncate text-[13px] font-medium',
              good ? 'text-ws-good' : 'text-ws-body',
            )}
          >
            {label}
          </span>
          <span className="ml-auto shrink-0 text-[12px] text-ws-muted-fg">
            {clockOf(event.at, lang)}
          </span>
        </div>
      </AiShell>
    )
  }
  // WP390：工坊服务卡——价目单 / 需求单 / 下单 / 验收 / 联系方式就在对话里点（主按钮在卡身里）
  if (isServiceCard(card))
    return (
      <AiShell id={event.id} roleId={roleId} name={roleName} at={event.at}>
        <div
          className="ws-dcard max-w-[520px]"
          data-testid="matter-service-card"
          data-card={card.id}
        >
          <div className="ws-dcard-head">
            <Handshake aria-hidden className="size-3.5" />
            {t('svc.card.head')}
          </div>
          <div className="ws-dcard-body">
            <p className="ws-dcard-title">{card.title}</p>
            <ServiceCardBody card={card} />
          </div>
          {card.available_actions.includes('reject') ? (
            <div className="ws-dcard-foot">
              <Button
                size="sm"
                variant="secondary"
                data-testid="matter-card-reject"
                disabled={deciding}
                onClick={() => {
                  onDecide(card, 'reject')
                }}
              >
                {deckActionLabel(card, 'reject', t)}
              </Button>
            </div>
          ) : null}
        </div>
      </AiShell>
    )
  // WP324（决策 690）：连接卡 / 配置卡——就在对话里连 / 填（同一张卡的投影），补完原任务自动接着做
  if (isSetupCard(card))
    return (
      <AiShell id={event.id} roleId={roleId} name={roleName} at={event.at}>
        <MatterSetupCard card={card} onDecide={onDecide} deciding={deciding} />
      </AiShell>
    )
  // WP418（审计 A3 / U7）：选主题卡在事项里也画成富卡（高级主题排第一、不能买也灰着列出原因），不是一排平铺按钮
  if (card.kind === 'theme_choice' && isThemeChoicePayload(card.detail.payload))
    return (
      <AiShell id={event.id} roleId={roleId} name={roleName} at={event.at}>
        <MatterThemeChoice
          card={card}
          payload={card.detail.payload}
          onDecide={onDecide}
          deciding={deciding}
        />
      </AiShell>
    )
  return (
    <AiShell id={event.id} roleId={roleId} name={roleName} at={event.at}>
      <MatterDecisionCard card={card} onDecide={onDecide} deciding={deciding} />
    </AiShell>
  )
}

/**
 * 事项里的连接卡 / 配置卡（WP324）。WP478：卡身里的「就这样 / 修改」「保存并接着做」报到卡底，
 * 和「先不设」并成一排（与岗位卡片流同一个规矩）。
 */
function MatterSetupCard({
  card,
  onDecide,
  deciding,
}: {
  card: DeckCard
  onDecide: (card: DeckCard, action: Exclude<DeckAction, 'open'>, option?: string) => void
  deciding: boolean
}): ReactNode {
  const { t } = useApp()
  const foot = useCardFootHost()
  const reject = card.available_actions.includes('reject')
  return (
    <div className="ws-dcard max-w-[520px]" data-testid="matter-setup-card" data-card={card.id}>
      <div className="ws-dcard-head">
        <Plug aria-hidden className="size-3.5" />
        {t(setupHeadKey(card))}
      </div>
      <div className="ws-dcard-body">
        <p className="ws-dcard-title">{card.title}</p>
        {foot.wrap(<SetupDeckBody card={card} />)}
      </div>
      {foot.lead.length === 0 && !reject ? null : (
        <div className="ws-dcard-foot">
          {foot.lead.map((a) => (
            <FootButton key={a.key} action={a} />
          ))}
          {reject ? (
            <button
              type="button"
              className="ws-btn ws-btn-secondary"
              data-testid="matter-card-reject"
              disabled={deciding}
              onClick={() => {
                onDecide(card, 'reject')
              }}
            >
              {deckActionLabel(card, 'reject', t)}
            </button>
          ) : null}
        </div>
      )}
    </div>
  )
}

/**
 * 事项里一张等你批 / 要你选的卡（WP456-T3，规范 §2.6 第 13 条，决策 1483）：和「要你处理」同一种决定卡——
 * 头一行「分类标签 + 状态药丸」、右边「证据 N」；标题 16 + 一句灰字；底一行主按钮 + 次按钮（灰底）。
 */
function MatterDecisionCard({
  card,
  onDecide,
  deciding,
}: {
  card: DeckCard
  onDecide: (card: DeckCard, action: Exclude<DeckAction, 'open'>, option?: string) => void
  deciding: boolean
}): ReactNode {
  const { t, lang } = useApp()
  const rail = useRailState()
  const approve = deckActionLabel(card, 'approve', t)
  const summary = (card.content_variants.zh_summary ?? card.summary)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
    .slice(0, 4)
  const options = card.options ?? []
  const category = t(categoryKey(card.kind, card.change_kind) ?? `kind.${card.kind}`)
  const evidence = evidenceLines(card, t, (iso) => formatDateTime(iso, lang))
  return (
    <div className="ws-dcard max-w-[520px]" data-testid="matter-card" data-card={card.id}>
      <div className="ws-dcard-head">
        <CategoryTag data-testid="matter-card-tag">{category}</CategoryTag>
        <StatusPill tone={options.length > 0 ? 'neutral' : 'warn'} data-testid="matter-card-state">
          {options.length > 0 ? t('matter.card.choice') : t('matter.card.await')}
        </StatusPill>
        {evidence.length === 0 ? null : (
          <span className="ws-dcard-head-end">
            <EvidencePill
              lines={evidence}
              onOpen={() => {
                focusEvidenceCard(card)
                rail.show('evidence')
              }}
            />
          </span>
        )}
      </div>
      <div className="ws-dcard-body">
        <p className="ws-dcard-title">{card.title}</p>
        {summary.length === 0 ? null : (
          <div className="ws-dcard-desc flex flex-col gap-0.5">
            {summary.map((l) => (
              <p key={l} className="break-words">
                {l}
              </p>
            ))}
          </div>
        )}
      </div>
      <div className="ws-dcard-foot">
        {options.length > 0 ? (
          options.map((o) => (
            <button
              key={o.id}
              type="button"
              className="ws-btn ws-btn-secondary"
              disabled={deciding}
              onClick={() => {
                onDecide(card, 'approve', o.id)
              }}
            >
              {o.label}
            </button>
          ))
        ) : (
          <>
            <button
              type="button"
              className="ws-btn ws-btn-primary"
              data-testid="matter-card-approve"
              disabled={deciding || !card.available_actions.includes('approve')}
              onClick={() => {
                onDecide(card, 'approve')
              }}
            >
              <Check aria-hidden className="size-4" />
              {approve}
            </button>
            {/* WP456-T3（§3.3）：「驳回」是次按钮（灰底），不再是一行纯文字 */}
            {card.available_actions.includes('reject') ? (
              <button
                type="button"
                className="ws-btn ws-btn-secondary"
                data-testid="matter-card-reject"
                disabled={deciding}
                onClick={() => {
                  onDecide(card, 'reject')
                }}
              >
                {deckActionLabel(card, 'reject', t)}
              </button>
            ) : null}
          </>
        )}
      </div>
    </div>
  )
}

/** WP418：事项里的选主题卡——同卡片页一样先在富卡里选一个，再点「就用这个」。 */
function MatterThemeChoice({
  card,
  payload,
  onDecide,
  deciding,
}: {
  card: DeckCard
  payload: ThemeChoicePayload
  onDecide: (card: DeckCard, action: Exclude<DeckAction, 'open'>, option?: string) => void
  deciding: boolean
}): ReactNode {
  const { t } = useApp()
  const [option, setOption] = useState('')
  return (
    <div className="ws-dcard max-w-[520px]" data-testid="matter-card" data-card={card.id}>
      {/* WP456-T3：头一行「分类标签 + 状态药丸」，和别的决定卡同一种 */}
      <div className="ws-dcard-head">
        <CategoryTag>
          {t(categoryKey(card.kind, card.change_kind) ?? `kind.${card.kind}`)}
        </CategoryTag>
        <StatusPill tone="neutral">{t('matter.card.choice')}</StatusPill>
      </div>
      <div className="ws-dcard-body">
        <p className="ws-dcard-title">{card.title}</p>
        <ThemeChoiceBody
          payload={payload}
          options={card.options ?? []}
          option={option}
          onOption={setOption}
        />
      </div>
      <div className="ws-dcard-foot">
        <Button
          size="sm"
          className="gap-1.5"
          data-testid="matter-card-approve"
          disabled={deciding || option === '' || !card.available_actions.includes('approve')}
          onClick={() => {
            onDecide(card, 'approve', option)
          }}
        >
          <Check aria-hidden />
          {deckActionLabel(card, 'approve', t)}
        </Button>
        {card.available_actions.includes('reject') ? (
          <Button
            size="sm"
            variant="secondary"
            data-testid="matter-card-reject"
            disabled={deciding}
            onClick={() => {
              onDecide(card, 'reject')
            }}
          >
            {deckActionLabel(card, 'reject', t)}
          </Button>
        ) : null}
      </div>
    </div>
  )
}

/** WP324 / WP348：连接卡 / 配置卡头上那一句（方案卡说「你点头就接着做 / 才生效」）。 */
function setupHeadKey(card: DeckCard): string {
  if (card.kind !== 'setup_request') {
    // WP360：主动带来的连接卡（这件事没卡在它上面、连好也不重跑）说「连上就能用」
    const resume = (card.detail.payload as { resume?: unknown } | undefined)?.resume
    return card.kind === 'connect_request' && resume === undefined
      ? 'setup.card.head.connect_ready'
      : 'setup.card.head.connect'
  }
  const mode = (card.detail.payload as { mode?: unknown } | undefined)?.mode
  return mode === 'change'
    ? 'setup.plan.head_change'
    : mode === 'plan'
      ? 'setup.plan.head'
      : 'setup.card.head.setup'
}
