/**
 * WP475（决策 1591、1592）：反馈框——一格字（必填）、类型（问题 / 建议 / 其他）、附上截图、
 * 附上诊断信息（默认勾、可展开看、可取消）、联系方式（默认登录的工坊账号邮箱）；
 * 另一页「我的反馈」：每一条的状态与回复。
 *
 * 界面少字：说明都在 tooltip（`title`）里。表单的值放在外面（`FeedbackHost`）——截窗口时框先收起、
 * 截完再打开，字不能丢。
 */
import type { FeedbackDiagnostics, LocalFeedbackSubmitted } from '@agentsws/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Camera, ChevronDown, ChevronRight, ImagePlus, Inbox, Send, X } from 'lucide-react'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { CategoryTag, EmptyState, NoticeLine, Segmented, StatusPill } from '@/components/design'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { ApiClientError } from '@/lib/api'
import { useApp } from '@/lib/app-context'
import {
  FEEDBACK_KEY,
  type FeedbackKind,
  type FeedbackScreenshot,
  type FeedbackTab,
  imageToScreenshot,
  type LocalFeedbackItem,
  listMyFeedback,
  markFeedbackSeen,
  screenshotUrl,
  submitFeedback,
} from '@/lib/feedback'
import { formatDate } from '@/lib/format'
import { cn } from '@/lib/utils'

/** 表单的值（外壳里那一份 `FeedbackHost` 拿着）。 */
export interface FeedbackForm {
  message: string
  kind: FeedbackKind
  screenshot?: FeedbackScreenshot
  diagnostics: boolean
  /** `undefined` = 还没动过（跟着默认值走）。 */
  contact?: string
}

export const EMPTY_FORM: FeedbackForm = { message: '', kind: 'bug', diagnostics: true }

const KINDS: readonly FeedbackKind[] = ['bug', 'idea', 'other']

type Outcome = { kind: 'sent' } | { kind: 'queued' } | { kind: 'error'; reason: string }

export function FeedbackDialog({
  open,
  onOpenChange,
  tab,
  onTab,
  form,
  onForm,
  draft,
  page,
  onCapture,
  capturing = false,
  shotNotice,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  tab: FeedbackTab
  onTab: (tab: FeedbackTab) => void
  form: FeedbackForm
  onForm: (next: FeedbackForm) => void
  /** 打开时本机给的：联系方式默认值 + 将要附上的诊断信息。 */
  draft?: { contact?: string; diagnostics: FeedbackDiagnostics }
  /** 交的时候一起报给本机服务的几样。 */
  page: { route: string; locale: string; app_version?: string; shell: 'desktop' | 'browser' }
  /** 桌面壳里一键截窗口（浏览器里没有：退回选图 / 粘贴 / 拖入）。 */
  onCapture?: () => void
  capturing?: boolean
  /** 截窗口没成时的那一句（外面给）。 */
  shotNotice?: string
}): ReactNode {
  const { t } = useApp()
  const client = useQueryClient()
  const [outcome, setOutcome] = useState<Outcome | undefined>()
  const [shotProblem, setShotProblem] = useState<string | undefined>()
  const [showDiag, setShowDiag] = useState(false)
  const file = useRef<HTMLInputElement>(null)

  const contact = form.contact ?? draft?.contact ?? ''
  const set = (patch: Partial<FeedbackForm>): void => {
    onForm({ ...form, ...patch })
  }

  const send = useMutation({
    mutationFn: () =>
      submitFeedback({
        kind: form.kind,
        message: form.message.trim(),
        ...(contact.trim() === '' ? {} : { contact: contact.trim() }),
        include_diagnostics: form.diagnostics,
        route: page.route,
        locale: page.locale,
        ...(page.app_version === undefined ? {} : { app_version: page.app_version }),
        shell: page.shell,
        ...(form.screenshot === undefined ? {} : { screenshot: form.screenshot }),
      }),
    onSuccess: (out: LocalFeedbackSubmitted) => {
      setOutcome(out.delivered ? { kind: 'sent' } : { kind: 'queued' })
      onForm({ ...EMPTY_FORM, ...(form.contact === undefined ? {} : { contact: form.contact }) })
      setShowDiag(false)
      void client.invalidateQueries({ queryKey: FEEDBACK_KEY })
    },
    onError: (err) => {
      setOutcome({
        kind: 'error',
        reason: err instanceof ApiClientError ? err.message : String(err),
      })
    },
  })

  // 换了一页 / 重新打开，上一次的「收到了」不留着
  useEffect(() => {
    if (!open) setOutcome(undefined)
  }, [open])

  const addImage = async (blob: Blob | undefined): Promise<void> => {
    if (blob === undefined) return
    const shot = await imageToScreenshot(blob)
    if (shot === undefined) {
      setShotProblem(t('feedback.shot.bad'))
      return
    }
    setShotProblem(undefined)
    set({ screenshot: shot })
  }

  const canSend = form.message.trim() !== '' && !send.isPending

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn('gap-3 sm:max-w-lg', capturing && 'invisible')}
        data-testid="feedback-dialog"
        onPaste={(e) => {
          if (tab !== 'new') return
          const img = [...e.clipboardData.files].find((f) => f.type.startsWith('image/'))
          if (img === undefined) return
          e.preventDefault()
          void addImage(img)
        }}
        onDragOver={(e) => {
          e.preventDefault()
        }}
        onDrop={(e) => {
          if (tab !== 'new') return
          e.preventDefault()
          void addImage([...e.dataTransfer.files].find((f) => f.type.startsWith('image/')))
        }}
      >
        <DialogHeader className="flex-row items-center gap-3 pr-8">
          <DialogTitle>{t('feedback.title')}</DialogTitle>
          <Segmented
            kind="tabs"
            size="sm"
            label={t('feedback.tabs')}
            value={tab}
            onChange={onTab}
            testId="feedback-tabs"
            options={[
              { value: 'new', label: t('feedback.tab.new'), testId: 'feedback-tab-new' },
              { value: 'mine', label: t('feedback.tab.mine'), testId: 'feedback-tab-mine' },
            ]}
          />
        </DialogHeader>

        {tab === 'mine' ? (
          <MyFeedback open={open} />
        ) : (
          <form
            className="flex min-w-0 flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault()
              if (canSend) send.mutate()
            }}
          >
            <Textarea
              autoFocus
              data-testid="feedback-message"
              aria-label={t('feedback.message')}
              placeholder={t('feedback.message.placeholder')}
              className="min-h-24"
              maxLength={2000}
              value={form.message}
              onChange={(e) => {
                set({ message: e.target.value })
                if (outcome !== undefined) setOutcome(undefined)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && canSend) {
                  e.preventDefault()
                  send.mutate()
                }
              }}
            />

            <div className="flex flex-wrap items-center gap-2">
              <Segmented
                size="sm"
                label={t('feedback.kind')}
                value={form.kind}
                onChange={(kind) => {
                  set({ kind })
                }}
                testId="feedback-kind"
                options={KINDS.map((k) => ({
                  value: k,
                  label: t(`feedback.kind.${k}`),
                  testId: `feedback-kind-${k}`,
                }))}
              />
              <span className="flex-1" />
              {onCapture === undefined ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  data-testid="feedback-shot-pick"
                  title={t('feedback.shot.pick.hint')}
                  onClick={() => file.current?.click()}
                >
                  <ImagePlus aria-hidden />
                  {t('feedback.shot.pick')}
                </Button>
              ) : (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  data-testid="feedback-shot-capture"
                  title={t('feedback.shot.capture.hint')}
                  disabled={capturing}
                  onClick={onCapture}
                >
                  <Camera aria-hidden />
                  {t('feedback.shot.capture')}
                </Button>
              )}
              <input
                ref={file}
                type="file"
                accept="image/*"
                hidden
                data-testid="feedback-shot-file"
                onChange={(e) => {
                  void addImage(e.target.files?.[0])
                  e.target.value = ''
                }}
              />
            </div>

            {form.screenshot === undefined ? null : (
              <div className="relative w-fit" data-testid="feedback-shot-preview">
                <img
                  src={screenshotUrl(form.screenshot)}
                  alt={t('feedback.shot.alt')}
                  className="max-h-40 rounded-md border border-ws-line object-contain"
                />
                <button
                  type="button"
                  data-testid="feedback-shot-remove"
                  aria-label={t('feedback.shot.remove')}
                  title={t('feedback.shot.remove')}
                  className="absolute top-1 right-1 flex size-6 items-center justify-center rounded-full bg-ws-ink/70 text-ws-paper hover:bg-ws-ink"
                  onClick={() => {
                    const { screenshot: _drop, ...rest } = form
                    onForm(rest)
                  }}
                >
                  <X aria-hidden className="size-3.5" />
                </button>
              </div>
            )}
            {(shotProblem ?? shotNotice) === undefined ? null : (
              <NoticeLine tone="warn" data-testid="feedback-shot-problem">
                {shotProblem ?? shotNotice}
              </NoticeLine>
            )}

            <div className="flex flex-col gap-1.5">
              <div className="flex items-center gap-2">
                <label
                  className="flex items-center gap-2 text-sm"
                  title={t('feedback.diag.hint')}
                  data-testid="feedback-diag-label"
                >
                  <input
                    type="checkbox"
                    data-testid="feedback-diag"
                    checked={form.diagnostics}
                    onChange={(e) => {
                      set({ diagnostics: e.target.checked })
                    }}
                  />
                  {t('feedback.diag')}
                </label>
                {form.diagnostics ? (
                  <button
                    type="button"
                    className="ws-link-muted flex items-center gap-0.5 text-xs"
                    data-testid="feedback-diag-toggle"
                    aria-expanded={showDiag}
                    onClick={() => {
                      setShowDiag((v) => !v)
                    }}
                  >
                    {showDiag ? (
                      <ChevronDown aria-hidden className="size-3.5" />
                    ) : (
                      <ChevronRight aria-hidden className="size-3.5" />
                    )}
                    {showDiag ? t('feedback.diag.hide') : t('feedback.diag.show')}
                  </button>
                ) : null}
              </div>
              {form.diagnostics && showDiag ? <DiagnosticsView diag={draft?.diagnostics} /> : null}
            </div>

            <div className="flex items-center gap-2 text-sm">
              <label htmlFor="feedback-contact" className="shrink-0 text-muted-foreground">
                {t('feedback.contact')}
              </label>
              <Input
                id="feedback-contact"
                data-testid="feedback-contact"
                className="h-8"
                maxLength={200}
                placeholder={t('feedback.contact.placeholder')}
                value={contact}
                onChange={(e) => {
                  set({ contact: e.target.value })
                }}
              />
            </div>

            <div className="flex items-center gap-3">
              <span className="min-w-0 flex-1 text-sm" aria-live="polite">
                {outcome === undefined ? null : outcome.kind === 'sent' ? (
                  <span className="text-ws-good" data-testid="feedback-sent">
                    {t('feedback.sent')}
                  </span>
                ) : outcome.kind === 'queued' ? (
                  <span className="text-ws-warn" data-testid="feedback-queued">
                    {t('feedback.queued')}
                  </span>
                ) : (
                  <span className="text-ws-bad" data-testid="feedback-error">
                    {t('feedback.failed', { reason: outcome.reason })}
                  </span>
                )}
              </span>
              <Button type="submit" size="sm" data-testid="feedback-send" disabled={!canSend}>
                <Send aria-hidden />
                {send.isPending ? t('feedback.sending') : t('feedback.send')}
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}

/** 展开看：将要附上的诊断信息（就是会发出去的那一份）。 */
function DiagnosticsView({ diag }: { diag: FeedbackDiagnostics | undefined }): ReactNode {
  const { t } = useApp()
  if (diag === undefined) return null
  const rows: [string, string][] = [
    [t('feedback.diag.version'), diag.app_version],
    [t('feedback.diag.os'), diag.os],
    [t('feedback.diag.locale'), diag.locale],
    [t('feedback.diag.route'), diag.route],
  ]
  return (
    <div
      className="max-h-48 overflow-auto rounded-md bg-muted/60 px-2.5 py-2 font-mono text-xs leading-relaxed"
      data-testid="feedback-diag-view"
    >
      {rows.map(([k, v]) => (
        <div key={k} className="flex gap-2">
          <span className="w-12 shrink-0 text-muted-foreground">{k}</span>
          <span className="min-w-0 break-all">{v}</span>
        </div>
      ))}
      <div className="mt-1 text-muted-foreground">
        {diag.errors.length === 0
          ? t('feedback.diag.no_errors')
          : t('feedback.diag.errors', { n: diag.errors.length })}
      </div>
      {diag.errors.map((line, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: 日志行可能重复，按位置排
        <div key={i} className="break-all whitespace-pre-wrap">
          {line}
        </div>
      ))}
    </div>
  )
}

const STATUS_TONE = {
  new: 'info',
  in_progress: 'warn',
  fixed: 'good',
  wont_fix: 'neutral',
} as const

function StateBadge({ item }: { item: LocalFeedbackItem }): ReactNode {
  const { t } = useApp()
  if (item.state === 'queued')
    return <StatusPill tone="warn">{t('feedback.state.queued')}</StatusPill>
  if (item.state === 'failed')
    return <StatusPill tone="bad">{t('feedback.state.failed')}</StatusPill>
  const status = item.status ?? 'new'
  return <StatusPill tone={STATUS_TONE[status]}>{t(`feedback.status.${status}`)}</StatusPill>
}

/** 我的反馈：每一条的状态与回复（打开就去云上问一遍进度；看过了回复的未读清零）。 */
function MyFeedback({ open }: { open: boolean }): ReactNode {
  const { t, lang } = useApp()
  const client = useQueryClient()
  const list = useQuery({
    queryKey: [...FEEDBACK_KEY, 'mine'],
    queryFn: () => listMyFeedback(true),
    enabled: open,
    retry: false,
  })
  const unread = (list.data?.items ?? []).some((i) => i.unread_replies > 0)
  useEffect(() => {
    if (!unread) return
    void markFeedbackSeen().then(() =>
      client.invalidateQueries({ queryKey: ['notifications'] }).catch(() => undefined),
    )
  }, [unread, client])

  if (list.isPending) return <div className="h-24" />
  const items = list.data?.items ?? []
  return (
    <div
      className="flex max-h-[60vh] min-w-0 flex-col gap-2 overflow-auto"
      data-testid="feedback-mine"
    >
      {list.data?.stale === true ? (
        <NoticeLine tone="info" data-testid="feedback-mine-stale">
          {t('feedback.mine.stale')}
        </NoticeLine>
      ) : null}
      {items.length === 0 ? (
        <EmptyState icon={Inbox} text={t('feedback.mine.empty')} />
      ) : (
        items.map((item) => (
          <div
            key={item.client_id}
            className="flex min-w-0 flex-col gap-1.5 rounded-lg border border-ws-line px-3 py-2"
            data-testid="feedback-mine-item"
            data-state={item.state}
            data-status={item.status ?? ''}
          >
            <div className="flex min-w-0 items-center gap-2">
              <CategoryTag>{t(`feedback.kind.${item.kind}`)}</CategoryTag>
              <span className="min-w-0 flex-1 truncate text-sm" title={item.message}>
                {item.message}
              </span>
              <StateBadge item={item} />
            </div>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span>{formatDate(item.created_at, lang)}</span>
              {item.id === undefined ? null : <span className="font-mono">{item.id}</span>}
              {item.has_screenshot ? <span>· {t('feedback.mine.shot')}</span> : null}
              {item.has_diagnostics ? <span>· {t('feedback.mine.diag')}</span> : null}
            </div>
            {item.replies.map((r) => (
              <div
                key={`${r.at}:${r.text.slice(0, 20)}`}
                className="rounded-md bg-ws-tint px-2.5 py-1.5 text-sm"
                data-testid="feedback-mine-reply"
              >
                <span className="mr-1.5 text-xs text-ws-brand">{t('feedback.mine.reply')}</span>
                <span className="break-words whitespace-pre-wrap">{r.text}</span>
              </div>
            ))}
          </div>
        ))
      )}
    </div>
  )
}
