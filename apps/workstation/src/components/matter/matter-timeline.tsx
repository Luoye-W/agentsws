/**
 * WP264：事项页的对话式时间线（docs/design/matter/README §3）。
 *
 * 你说的在右边气泡；AI 说的在左边（职责头像 + 名字 + Markdown）；结果 / 审批 / 选择 / 卡住是能直接点的卡；
 * 过程与系统事件缩成居中一行灰字，点开看步骤（决策 182：默认全收起）；正在跑的那次在最底下「正在做…」。
 * 怎么排在 `matter-model.ts`，这里只管画。
 */
import type { MatterEvent, MatterLiveRun, MatterRunStep } from '@agentsws/contracts'
import type { DeckAction, DeckCard } from '@agentsws/deck'
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
  Info,
  LoaderCircle,
  Plug,
  Rocket,
  Stamp,
  X,
} from 'lucide-react'
import { type ReactNode, useEffect, useState } from 'react'
import { deckActionLabel } from '@/components/deck/deck-action-bar'
import { DutyIcon } from '@/components/role-icons/role-icon'
import { Button } from '@/components/ui/button'
import { SafeMarkdown } from '@/components/ui/safe-markdown'
import { useApp } from '@/lib/app-context'
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

/** 职责头像：圆角方块里一枚职责图标（运行中外圈呼吸）。 */
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
        'relative grid size-7 place-items-center rounded-[9px] bg-ws-tint text-ws-ink',
        live &&
          'after:absolute after:-inset-[3px] after:animate-pulse after:rounded-[11px] after:shadow-[0_0_0_2px_var(--ws-brand)] after:opacity-50 motion-reduce:after:animate-none',
      )}
      style={{ '--ia': 'var(--ws-brand)' } as React.CSSProperties}
    >
      {roleId === undefined ? <Bot className="size-4" /> : <DutyIcon role_id={roleId} size={17} />}
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
  const long = bubbleIsLong(event.text)
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
          'rounded-[18px_18px_6px_18px] bg-secondary px-3.5 py-2.5 text-[14.5px] leading-[1.6] break-words whitespace-pre-wrap text-ws-ink',
          long && !open && 'line-clamp-6',
          queued && 'opacity-70',
        )}
        data-testid="matter-bubble"
      >
        {event.text}
      </div>
      <div className="flex gap-2 text-[11.5px] text-ws-muted-fg">
        {long ? (
          <button
            type="button"
            className="hover:text-ws-ink"
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
      className="group/ai grid grid-cols-[28px_minmax(0,1fr)] gap-x-3 gap-y-1 target:rounded-xl target:outline-2 target:outline-ws-brand/40"
    >
      <DutyAvatar roleId={roleId} live={live} />
      <div className="flex h-7 items-center gap-2 text-[13px] font-semibold text-ws-ink">
        {head ?? name}
        {at === undefined ? null : (
          <span className="font-normal text-[11.5px] text-ws-muted-fg">{clockOf(at, lang)}</span>
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
              className="grid size-[22px] place-items-center rounded-[7px] hover:bg-muted hover:text-ws-ink"
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
    <div
      className="mt-3 max-w-[520px] overflow-hidden rounded-2xl border border-ws-line bg-ws-card shadow-ws"
      data-testid="matter-preview-card"
    >
      <div className="flex items-center gap-2 px-3.5 pt-3 text-[12.5px] text-ws-muted-fg">
        <Eye aria-hidden className="size-3.5" />
        {t('matter.preview.ready')}
        <span className="ml-auto inline-flex h-[22px] items-center gap-1.5 rounded-full bg-muted px-2 text-[11.5px] text-ws-body">
          <i aria-hidden className="size-1.5 rounded-full bg-ws-muted-fg" />
          {t('matter.preview.unpublished')}
        </span>
      </div>
      <div className="flex gap-3.5 px-3.5 pt-2.5 pb-3">
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
          <p className="text-[15px] leading-[1.35] font-semibold break-words text-ws-ink">
            {preview.label}
          </p>
          {meta.length === 0 ? null : (
            <p className="mt-0.5 text-[12.5px] text-ws-muted-fg">{meta.join(' · ')}</p>
          )}
        </div>
      </div>
      {diff ? (
        <ul
          className="border-t border-ws-line px-3.5 py-2 font-mono text-[11.5px] text-ws-body"
          data-testid="matter-preview-files"
        >
          {files === undefined || files.length === 0 ? (
            <li className="font-sans text-ws-muted-fg">{t('matter.preview.nofiles')}</li>
          ) : (
            files.map((f) => <li key={f}>{f}</li>)
          )}
        </ul>
      ) : null}
      <div className="flex items-center gap-2 border-t border-ws-line bg-ws-surface px-3.5 py-2.5">
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
          className="ml-auto inline-flex items-center gap-1 text-[12.5px] text-ws-muted-fg hover:text-ws-ink"
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
}): ReactNode {
  const { t } = useApp()
  const text = item.event?.text ?? ''
  const long = replyIsLong(text)
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
        <p className="text-[14.5px] leading-[1.7] text-ws-ink">{t('matter.preview.lead')}</p>
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
            <SafeMarkdown text={text} variant="chat" />
          </div>
          {long ? (
            <button
              type="button"
              aria-expanded={open}
              data-testid="matter-unfold"
              onClick={() => {
                setOpen((v) => !v)
              }}
              className="mt-1.5 inline-flex h-[26px] items-center gap-1 rounded-full bg-ws-card px-2.5 text-[12.5px] text-ws-body shadow-[inset_0_0_0_1px_var(--ws-line)] hover:text-ws-ink"
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
      {onResume === undefined ? null : (
        <Button
          size="xs"
          variant="outline"
          className="mt-2"
          data-testid="matter-resume"
          disabled={resuming === true}
          onClick={onResume}
        >
          {t('matter.resume')}
        </Button>
      )}
    </AiShell>
  )
}

function StepList({ steps, live = false }: { steps: MatterRunStep[]; live?: boolean }): ReactNode {
  const { t } = useApp()
  return (
    <ul
      className="w-full max-w-[560px] rounded-xl bg-ws-surface px-3 py-2 text-[12.5px] text-ws-body shadow-[inset_0_0_0_1px_var(--ws-line)]"
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
          <span className="min-w-0 truncate font-mono text-[11.5px]">{s.text}</span>
          {s.seconds === undefined ? (
            live && s.status === 'running' ? (
              <span className="ml-auto text-[11.5px] text-ws-muted-fg">…</span>
            ) : null
          ) : (
            <span className="ml-auto shrink-0 text-[11.5px] text-ws-muted-fg tabular-nums">
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
            ? 'matter.sys.stopped'
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
      text = t(settled ? 'matter.sys.settled' : 'matter.sys.routed', { role: name })
    const options = (e.route?.options ?? []).filter((o) => o.role_id !== currentRole)
    detail = (
      <div className="flex max-w-[560px] flex-col items-center gap-2 text-center text-[12.5px] text-ws-body">
        {name === undefined ? null : <p>{e.text}</p>}
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
    if (name === undefined && (onRoute === undefined || options.length === 0)) detail = null
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
          className="inline-flex max-w-full items-center gap-1.5 rounded-full px-2.5 py-[3px] text-[12.5px] text-ws-muted-fg enabled:hover:bg-muted enabled:hover:text-ws-body disabled:cursor-default"
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
            className="text-[12.5px] text-ws-muted-fg underline-offset-2 hover:text-ws-ink hover:underline"
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
            {t('matter.resume')}
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
      className="grid grid-cols-[28px_minmax(0,1fr)] gap-x-3 gap-y-1"
      data-testid="matter-running"
      aria-live="polite"
    >
      <DutyAvatar roleId={roleId} live />
      <div className="flex h-7 items-center gap-2 text-[13px] font-semibold text-ws-ink">
        <span className="text-ws-brand-ink dark:text-ws-brand">{t('matter.run.doing')}</span>
        <span className="sr-only">{roleName}</span>
        {elapsed === undefined ? null : (
          <span className="font-normal text-[11.5px] text-ws-muted-fg tabular-nums">
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
          className="inline-flex items-center gap-2 py-0.5 text-[14px] text-ws-body"
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
            className="mt-1.5 max-w-[640px] text-[14.5px] leading-[1.7] whitespace-pre-wrap text-ws-ink"
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
      <p className="text-[14.5px] leading-[1.7] text-ws-ink">{event.text}</p>
      <div
        className="mt-3 max-w-[520px] overflow-hidden rounded-2xl border-[1.5px] border-ws-bad/45 bg-ws-card shadow-ws"
        data-testid="matter-blocked-card"
      >
        <div className="flex items-center gap-2 px-3.5 pt-3 text-[12.5px] text-ws-muted-fg">
          <Plug aria-hidden className="size-3.5" />
          {t('matter.blocked.head')}
          <span className="ml-auto inline-flex h-[22px] items-center rounded-full bg-ws-bad-bg px-2 text-[11.5px] font-medium text-ws-bad">
            {t('matter.blocked.pill')}
          </span>
        </div>
        <div className="px-3.5 pt-2.5 pb-3">
          <p className="text-[15px] leading-[1.35] font-semibold text-ws-ink">
            {what === '' ? t('matter.blocked.title.any') : t('matter.blocked.title', { what })}
          </p>
          <p className="mt-0.5 text-[12.5px] text-ws-muted-fg">{t('matter.blocked.hint')}</p>
        </div>
        <div className="flex items-center gap-2 border-t border-ws-line bg-ws-surface px-3.5 py-2.5">
          <Button
            size="sm"
            className="gap-1.5"
            data-testid="matter-blocked-connect"
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
      <div
        className="max-w-[520px] overflow-hidden rounded-2xl border-[1.5px] border-ws-warn/55 bg-ws-card shadow-ws"
        data-testid="matter-choice-card"
      >
        <p className="px-3.5 pt-3 pb-2.5 text-[14px] leading-[1.5] text-ws-ink">{event.text}</p>
        <div
          className="flex flex-wrap items-center gap-2 border-t border-ws-line bg-ws-surface px-3.5 py-2.5"
          data-testid="matter-route-options"
        >
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
  if (!WAITING.has(card.status)) {
    const key = APPROVED.has(card.status)
      ? 'matter.card.approved'
      : card.status === 'rejected'
        ? 'matter.card.rejected'
        : 'matter.card.done'
    const good = APPROVED.has(card.status)
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
            {t(key, { title: card.title })}
          </span>
          <span className="ml-auto shrink-0 text-[12px] text-ws-muted-fg">
            {clockOf(event.at, lang)}
          </span>
        </div>
      </AiShell>
    )
  }
  const approve = deckActionLabel(card, 'approve', t)
  const summary = (card.content_variants.zh_summary ?? card.summary)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
    .slice(0, 4)
  const options = card.options ?? []
  return (
    <AiShell id={event.id} roleId={roleId} name={roleName} at={event.at}>
      <div
        className="max-w-[520px] overflow-hidden rounded-2xl border-[1.5px] border-ws-warn/55 bg-ws-card shadow-ws"
        data-testid="matter-card"
        data-card={card.id}
      >
        <div className="flex items-center gap-2 px-3.5 pt-3 text-[12.5px] text-ws-muted-fg">
          <Stamp aria-hidden className="size-3.5" />
          {options.length > 0 ? t('matter.card.choice') : t('matter.card.await')}
          {options.length > 0 ? null : (
            <span className="ml-auto inline-flex h-[22px] items-center rounded-full bg-ws-warn-bg px-2 text-[11.5px] font-medium text-ws-warn">
              {approve}
            </span>
          )}
        </div>
        <div className="px-3.5 pt-2.5 pb-2">
          <p className="text-[15px] leading-[1.35] font-semibold break-words text-ws-ink">
            {card.title}
          </p>
        </div>
        {summary.length === 0 ? null : (
          <ul className="flex flex-col gap-1 px-3.5 pb-3 text-[13px] text-ws-body">
            {summary.map((l) => (
              <li key={l} className="break-words">
                {l}
              </li>
            ))}
          </ul>
        )}
        <div className="flex flex-wrap items-center gap-2 border-t border-ws-line bg-ws-surface px-3.5 py-2.5">
          {options.length > 0 ? (
            options.map((o) => (
              <Button
                key={o.id}
                size="sm"
                variant="outline"
                disabled={deciding}
                onClick={() => {
                  onDecide(card, 'approve', o.id)
                }}
              >
                {o.label}
              </Button>
            ))
          ) : (
            <>
              <Button
                size="sm"
                className="gap-1.5"
                data-testid="matter-card-approve"
                disabled={deciding || !card.available_actions.includes('approve')}
                onClick={() => {
                  onDecide(card, 'approve')
                }}
              >
                <Check aria-hidden />
                {approve}
              </Button>
              {card.available_actions.includes('reject') ? (
                <Button
                  size="sm"
                  variant="ghost"
                  data-testid="matter-card-reject"
                  disabled={deciding}
                  onClick={() => {
                    onDecide(card, 'reject')
                  }}
                >
                  {deckActionLabel(card, 'reject', t)}
                </Button>
              ) : null}
            </>
          )}
        </div>
      </div>
    </AiShell>
  )
}
