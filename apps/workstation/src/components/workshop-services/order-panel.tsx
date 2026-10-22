/**
 * WP390（docs/105 §5）：第三栏的**订单面板**（`agentsws://service-order/<订单号>`）——进度、预计时间、在等你的事、
 * 消息串（AI 帮读懂、起草回复，**不替你答应加钱或改范围**）、钱（托管 / 已结算 / 已退）、交付物保留到哪天
 * （P10：快到期提醒一次）、接单之前能取消。下单 / 验收 / 交换联系方式都在卡上，这里只指过去。
 *
 * WP403：附件——「在等你补材料」那一格能直接传文件（传了 = 补上了），附件列表里你传的、交付文件都能下载；
 * 对方要追加费用时标黄一行（点头在卡上，这里不花钱）。
 */
import {
  pendingServiceExtra,
  SERVICE_ATTACHMENT_LIMITS,
  type ServiceOrderView,
} from '@agentsws/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, ChevronDown, ChevronRight, Paperclip, Sparkles } from 'lucide-react'
import { type ReactNode, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { RailPanelBodyProps } from '@/components/rail/registry'
import { Button } from '@/components/ui/button'
import { Hint } from '@/components/ui/hint'
import { useApp } from '@/lib/app-context'
import {
  cancelWorkshopOrder,
  creditsText,
  downloadWorkshopAttachment,
  draftWorkshopReply,
  getWorkshopOrder,
  isOpenOrder,
  parseServiceOrderAddress,
  postWorkshopMessage,
  uploadWorkshopAttachment,
  WORKSHOP_ORDERS_KEY,
} from '@/lib/workshop-services-api'

/** 进度条那一格（0–100）：定制件按验收了几段，其余按状态。 */
export function orderProgress(o: ServiceOrderView): number {
  if (!isOpenOrder(o.status)) return 100
  const ms = o.milestones ?? []
  if (ms.length > 1 && ['in_progress', 'waiting_user', 'delivered'].includes(o.status)) {
    const done = ms.filter((m) => m.status === 'accepted').length
    const half = ms.some((m) => m.status === 'delivered') ? 0.7 : 0.35
    return Math.round(((done + half) / ms.length) * 100)
  }
  const by: Record<string, number> = {
    quote_requested: 10,
    quoted: 20,
    paid: 30,
    in_progress: 50,
    waiting_user: 50,
    delivered: 85,
    disputed: 90,
  }
  return by[o.status] ?? 0
}

const day = (iso: string | undefined, lang: string): string | undefined =>
  iso === undefined
    ? undefined
    : new Date(iso).toLocaleDateString(lang === 'zh' ? 'zh-CN' : 'en-US', {
        month: 'numeric',
        day: 'numeric',
      })

export function ServiceOrderPanel({ address }: RailPanelBodyProps): ReactNode {
  const { t, lang } = useApp()
  const id = parseServiceOrderAddress(address)
  const client = useQueryClient()
  const navigate = useNavigate()
  const reply = useRef<HTMLTextAreaElement>(null)
  const picker = useRef<HTMLInputElement>(null)
  const [fileError, setFileError] = useState<string | undefined>(undefined)
  const [text, setText] = useState('')
  const [needsYou, setNeedsYou] = useState(false)
  const [ledgerOpen, setLedgerOpen] = useState(false)
  const detail = useQuery({
    queryKey: [...WORKSHOP_ORDERS_KEY, id],
    enabled: id !== undefined,
    queryFn: () => getWorkshopOrder(id ?? ''),
    retry: false,
  })
  const refresh = () => {
    void client.invalidateQueries({ queryKey: WORKSHOP_ORDERS_KEY })
    void client.invalidateQueries({ queryKey: ['matter'] })
  }
  const send = useMutation({
    mutationFn: () => postWorkshopMessage(id ?? '', text),
    onSuccess: () => {
      setText('')
      setNeedsYou(false)
      refresh()
    },
  })
  const draft = useMutation({
    mutationFn: () => draftWorkshopReply(id ?? ''),
    onSuccess: (d) => {
      setText(d.text)
      setNeedsYou(d.needs_you === true)
      reply.current?.focus()
    },
  })
  const cancel = useMutation({
    mutationFn: () => cancelWorkshopOrder(id ?? ''),
    onSuccess: refresh,
  })
  const upload = useMutation({
    mutationFn: (file: File) => uploadWorkshopAttachment(id ?? '', file),
    onSuccess: () => {
      setFileError(undefined)
      refresh()
    },
    onError: (e) => setFileError(e instanceof Error ? e.message : String(e)),
  })
  const pick = (file: File | undefined) => {
    if (file === undefined) return
    if (file.size > SERVICE_ATTACHMENT_LIMITS.max_bytes) {
      setFileError(t('svc.order.file.too_big'))
      return
    }
    upload.mutate(file)
  }
  if (id === undefined || detail.isError)
    return <p className="p-3 text-sm text-ws-muted-fg">{t('svc.order.missing')}</p>
  const d = detail.data
  if (d === undefined)
    return <p className="p-3 text-sm text-ws-muted-fg">{t('svc.order.loading')}</p>
  const o = d.order
  const name = lang === 'zh' ? o.label_zh : o.label_en
  const pct = orderProgress(o)
  const eta = day(o.deliver_by, lang)
  const custom = o.kind === 'custom'
  const open = isOpenOrder(o.status)
  const extra = pendingServiceExtra(o)
  const accepted = (o.extras ?? []).filter((x) => x.status === 'accepted')
  const files = o.attachments ?? []
  const canUpload = custom && open && o.status !== 'draft'
  const uploadButton = canUpload ? (
    <Button
      size="xs"
      variant="outline"
      className="gap-1"
      data-testid="service-order-upload"
      disabled={upload.isPending}
      onClick={() => picker.current?.click()}
    >
      <Paperclip aria-hidden className="size-3" />
      {upload.isPending ? t('svc.order.uploading') : t('svc.order.upload')}
    </Button>
  ) : null
  return (
    <div
      className="flex flex-col gap-3 p-3 text-[13px]"
      data-testid="service-order-panel"
      data-status={o.status}
    >
      <div className="flex flex-col gap-1.5">
        <p className="flex flex-wrap items-center gap-1.5">
          <span className="font-semibold text-ws-ink">{name}</span>
          <span className="text-ws-muted-fg">· {t(`svc.status.${o.status}`)}</span>
          <span className="text-xs text-ws-muted-fg">
            · {t(`svc.provider.${o.provider_label}`)}
          </span>
        </p>
        <div className="flex items-center gap-2">
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-ws-tint" aria-hidden>
            <div className="h-full rounded-full bg-ws-brand" style={{ width: `${pct}%` }} />
          </div>
          {eta === undefined || !open ? null : (
            <span className="shrink-0 text-[12px] text-ws-muted-fg ws-num">
              {t('svc.order.eta', { date: eta })}
            </span>
          )}
        </div>
        {(o.milestones ?? []).length > 1 ? (
          <ol className="flex flex-wrap gap-1.5 text-xs">
            {(o.milestones ?? []).map((m) => (
              <li
                key={m.id}
                className="rounded-full bg-ws-surface px-2 py-0.5 shadow-[inset_0_0_0_1px_var(--ws-line)]"
                data-status={m.status}
              >
                {lang === 'zh' ? m.label_zh : m.label_en} · {creditsText(m.credits, lang)}
                {m.status === 'accepted' ? ' ✓' : ''}
              </li>
            ))}
          </ol>
        ) : null}
      </div>

      {o.waiting_for === undefined ? null : (
        <div
          className="flex items-center gap-2 rounded-lg bg-ws-warn-bg px-2.5 py-2 text-ws-warn"
          data-testid="service-order-waiting"
        >
          <span className="min-w-0 flex-1">{t('svc.order.waiting', { what: o.waiting_for })}</span>
          {uploadButton}
          <Button size="xs" variant="outline" onClick={() => reply.current?.focus()}>
            {t('svc.order.reply')}
          </Button>
        </div>
      )}
      {canUpload ? (
        <input
          ref={picker}
          type="file"
          className="hidden"
          data-testid="service-order-file"
          onChange={(e) => {
            pick(e.target.files?.[0])
            e.target.value = ''
          }}
        />
      ) : null}
      {fileError === undefined ? null : (
        <p className="text-[12px] text-ws-warn" data-testid="service-order-file-error">
          {fileError}
        </p>
      )}
      {extra === undefined ? null : (
        <p
          className="rounded-lg bg-ws-warn-bg px-2.5 py-2 text-ws-warn"
          data-testid="service-order-extra"
        >
          {t('svc.order.extra_waiting', {
            credits: creditsText(extra.credits, lang),
            reason: extra.reason,
          })}
        </p>
      )}
      {d.card_id === undefined ? null : (
        <div
          className="flex items-center gap-2 rounded-lg bg-ws-surface px-2.5 py-2"
          data-testid="service-order-card"
        >
          <span className="min-w-0 flex-1">{t('svc.order.card')}</span>
          <Button
            size="xs"
            onClick={() => {
              if (d.matter_id !== undefined)
                void navigate(`/matters/${encodeURIComponent(d.matter_id)}`)
              else void navigate(`/cards/${encodeURIComponent(d.card_id ?? '')}`)
            }}
          >
            {t('svc.order.open_card')}
          </Button>
        </div>
      )}
      {d.expiring === true ? (
        <p
          className="flex items-center gap-1.5 text-[12.5px] text-ws-warn"
          data-testid="service-order-expiring"
        >
          <AlertTriangle aria-hidden className="size-3.5" />
          {t('svc.order.expiring', { date: day(o.deliverables_expire_at, lang) ?? '' })}
        </p>
      ) : o.deliverables_expire_at === undefined ||
        (o.deliverables.length === 0 && files.length === 0) ? null : (
        <p className="text-[12px] text-ws-muted-fg">
          {t('svc.order.expires', { date: day(o.deliverables_expire_at, lang) ?? '' })}
        </p>
      )}
      {o.dispute?.note === undefined ? null : (
        <p className="text-[12.5px] text-ws-body">
          {t('svc.order.dispute_note', { note: o.dispute.note })}
        </p>
      )}
      {open && o.contact?.status === 'accepted' && o.contact.provider_contact !== undefined ? (
        <p className="text-[12.5px] text-ws-body">
          {t('svc.order.contact', {
            kind: t(`svc.contact.${o.contact.provider_contact.kind}`),
            value: o.contact.provider_contact.value,
          })}
        </p>
      ) : null}

      {files.length > 0 || (canUpload && o.waiting_for === undefined) ? (
        <section className="flex flex-col gap-1" data-testid="service-order-files">
          <div className="flex items-center gap-2">
            <h4 className="min-w-0 flex-1 text-[12px] font-medium text-ws-muted-fg">
              {t('svc.order.files')}
            </h4>
            {o.waiting_for === undefined ? uploadButton : null}
          </div>
          <ul className="flex flex-col gap-0.5">
            {files.map((f) => (
              <li key={f.id} className="flex items-center gap-1.5 text-[12.5px]">
                <span className="min-w-0 flex-1 truncate text-ws-ink" title={f.name}>
                  {f.name}
                </span>
                <span className="shrink-0 text-xs text-ws-muted-fg">
                  {f.from === 'user' ? t('svc.order.file.mine') : t('svc.order.file.delivery')} ·{' '}
                  {Math.max(1, Math.ceil(f.size / 1024))} KB
                </span>
                {f.expired === true ? (
                  <span className="shrink-0 text-xs text-ws-muted-fg">
                    {t('svc.order.file.expired')}
                  </span>
                ) : (
                  <Button
                    size="xs"
                    variant="ghost"
                    data-testid="service-order-download"
                    onClick={() => {
                      void downloadWorkshopAttachment(o.id, f).catch((e: unknown) =>
                        setFileError(e instanceof Error ? e.message : String(e)),
                      )
                    }}
                  >
                    {t('svc.order.file.download')}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {custom ? (
        <section className="flex flex-col gap-1.5" data-testid="service-order-messages">
          <h4 className="text-[12px] font-medium text-ws-muted-fg">
            {t('svc.order.messages', {
              n: String(d.messages.filter((m) => m.kind !== 'status').length),
            })}
          </h4>
          {d.messages.length === 0 ? (
            <p className="text-[12px] text-ws-muted-fg">{t('svc.order.no_messages')}</p>
          ) : (
            <ul className="flex max-h-60 flex-col gap-1 overflow-y-auto">
              {d.messages.map((m) => (
                <li
                  key={m.id}
                  className={
                    m.kind === 'status'
                      ? 'text-center text-xs text-ws-muted-fg'
                      : m.from === 'user'
                        ? 'ml-6 rounded-lg bg-ws-tint px-2 py-1 text-ws-ink'
                        : 'mr-6 rounded-lg bg-ws-surface px-2 py-1 text-ws-ink shadow-[inset_0_0_0_1px_var(--ws-line)]'
                  }
                >
                  {m.text}
                </li>
              ))}
            </ul>
          )}
          {open ? (
            <form
              className="flex flex-col gap-1.5"
              onSubmit={(e) => {
                e.preventDefault()
                if (text.trim() !== '') send.mutate()
              }}
            >
              <textarea
                ref={reply}
                className="min-h-16 rounded-md border border-ws-line bg-ws-card p-2 text-[13px] outline-none focus:border-ws-brand"
                placeholder={t('svc.order.placeholder')}
                value={text}
                data-testid="service-order-reply"
                onChange={(e) => setText(e.target.value)}
              />
              {needsYou ? (
                <p className="text-[12px] text-ws-warn" data-testid="service-order-needs-you">
                  {t('svc.order.needs_you')}
                </p>
              ) : null}
              <div className="flex items-center gap-2">
                <Button size="sm" type="submit" disabled={text.trim() === '' || send.isPending}>
                  {t('svc.order.send')}
                </Button>
                <Button
                  size="sm"
                  type="button"
                  variant="outline"
                  className="gap-1"
                  disabled={draft.isPending}
                  data-testid="service-order-draft"
                  onClick={() => draft.mutate()}
                >
                  <Sparkles aria-hidden className="size-3.5" />
                  {t('svc.order.draft')}
                </Button>
              </div>
            </form>
          ) : null}
        </section>
      ) : null}

      {accepted.length === 0 ? null : (
        <p className="text-[12px] text-ws-muted-fg ws-num" data-testid="service-order-extras">
          {t('svc.order.extras', {
            list: accepted.map((x) => creditsText(x.credits, lang)).join(' + '),
          })}
        </p>
      )}
      <p className="flex items-center gap-1 text-[12px] text-ws-muted-fg ws-num">
        {t('svc.order.money', {
          escrow: creditsText(o.escrow_credits, lang),
          settled: creditsText(o.settled_credits, lang),
          refunded: creditsText(o.refunded_credits, lang),
        })}
        <Hint text={t('svc.order.money.tip')} />
      </p>
      {o.actions.includes('cancel') ? (
        <Button
          size="xs"
          variant="ghost"
          className="w-fit text-ws-muted-fg"
          title={t('svc.order.cancel.tip')}
          data-testid="service-order-cancel"
          disabled={cancel.isPending}
          onClick={() => cancel.mutate()}
        >
          {t('svc.order.cancel')}
        </Button>
      ) : null}
      {d.ledger.length === 0 ? null : (
        <section>
          <button
            type="button"
            className="ws-link-muted flex items-center gap-1 text-[12px]"
            aria-expanded={ledgerOpen}
            onClick={() => setLedgerOpen((v) => !v)}
          >
            {ledgerOpen ? (
              <ChevronDown aria-hidden className="size-3" />
            ) : (
              <ChevronRight aria-hidden className="size-3" />
            )}
            {t('svc.order.ledger')}
          </button>
          {ledgerOpen ? (
            <ul
              className="mt-1 flex flex-col gap-0.5 text-xs text-ws-muted-fg"
              data-testid="service-order-ledger"
            >
              {d.ledger.map((l) => (
                <li key={`${l.at}-${l.kind}-${l.text}`} className="flex gap-2">
                  <span className="shrink-0 ws-num">{day(l.at, lang)}</span>
                  <span className="min-w-0">{l.text}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      )}
    </div>
  )
}
