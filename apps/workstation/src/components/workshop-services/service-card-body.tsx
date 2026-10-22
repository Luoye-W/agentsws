/**
 * WP390（docs/105 §5）：工坊服务卡（`service_order`，永远 L1）的五种卡面——卡片流与事项时间线同一份。
 *
 * 主按钮在卡身里（下单 / 提交 / 同意并支付 / 通过·要改·申请退款 / 同意给这一种），卡底那排只剩「先不要 / 稍后」：
 * - 价目单（标准件）：勾几项、填数量与对象，合计当场算；点「下单」= 批（扣进托管）；
 * - 需求单（定制件）：AI 整理的问答，「再改改」就地改，「提交」= 交去报价（不扣钱）；
 * - 下单卡：多少、多久、能改几次、几天不点自动通过、会交给做的人什么；「同意并支付」= 批；
 * - 验收卡：标准件看凭证、定制件按段；通过 / 要改 / 申请退款（后两样写一句为什么）；写明几时自动通过；
 * - 交换联系方式：用户自己选给哪一种（N1），只对这一单有效。
 *
 * 界面少字：卡上不写风险、不写合作方名字；解释进问号。
 */
import {
  isServiceOrderCardPayload,
  normalizeServiceLines,
  normalizeServiceRequirements,
  type ServiceAcceptanceCardPayload,
  type ServiceCardSnapshot,
  type ServiceContactCardPayload,
  type ServiceContactKind,
  type ServiceMenuCardPayload,
  type ServiceOrderLine,
  type ServicePayCardPayload,
  type ServiceRequirementsCardPayload,
  type ServiceView,
} from '@agentsws/contracts'
import type { DeckCard } from '@agentsws/deck'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ExternalLink } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Hint } from '@/components/ui/hint'
import { decide } from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { RAIL_KEY } from '@/lib/work-archive'
import { creditsText, WORKSHOP_ORDERS_KEY } from '@/lib/workshop-services-api'

/** 这张卡是不是工坊服务卡（主按钮在卡身里）。 */
export const isServiceCard = (card: Pick<DeckCard, 'detail'>): boolean =>
  isServiceOrderCardPayload(card.detail.payload)

const asService = (s: ServiceCardSnapshot): ServiceView => ({
  ...s,
  deliverables: [],
  positions: [],
  intents: [],
  available: true,
})

function useDecideService(card: DeckCard) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (input: { edited?: unknown; option?: string }) =>
      decide(
        card.id,
        {
          action: 'approve',
          version: card.version,
          via: 'workstation',
          ...(input.edited === undefined ? {} : { edited_payload: input.edited }),
          ...(input.option === undefined ? {} : { selected_option_id: input.option }),
        } as never,
        card.position_id,
      ),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: ['approval'] })
      void client.invalidateQueries({ queryKey: ['deck'] })
      void client.invalidateQueries({ queryKey: RAIL_KEY })
      void client.invalidateQueries({ queryKey: ['matter'] })
      void client.invalidateQueries({ queryKey: WORKSHOP_ORDERS_KEY })
    },
  })
}

/** 「约 N 天 · 可改 R 次 · D 天不点自动通过」那一行。 */
function useTerms(): (
  s: ServiceCardSnapshot,
  hours: number | undefined,
  withRevisions?: boolean,
) => string {
  const { t } = useApp()
  return (s, hours, withRevisions = true) => {
    const parts: string[] = []
    if (hours !== undefined)
      parts.push(
        hours < 48
          ? t('svc.pay.hours', { n: String(hours) })
          : t('svc.pay.days', { n: String(Math.round(hours / 24)) }),
      )
    if (withRevisions) parts.push(t('svc.pay.revisions', { n: String(s.revisions) }))
    const autoDays = s.auto_accept_hours / 24
    parts.push(
      autoDays >= 1 && Number.isInteger(autoDays)
        ? t('svc.pay.auto', { n: String(autoDays) })
        : t('svc.pay.auto_hours', { n: String(s.auto_accept_hours) }),
    )
    return parts.join(' · ')
  }
}

const field =
  'h-8 rounded-md border border-ws-line bg-ws-card px-2 text-[13px] text-ws-ink outline-none focus:border-ws-brand'

/* ── 价目单 ──────────────────────────────────────────────────────── */

function MenuBody({
  card,
  payload,
}: {
  card: DeckCard
  payload: ServiceMenuCardPayload
}): ReactNode {
  const { t, lang } = useApp()
  const go = useDecideService(card)
  const terms = useTerms()
  const s = payload.service
  const menu = s.menu ?? []
  const [rows, setRows] = useState<
    Record<string, { on: boolean; qty: string; target: Record<string, string> }>
  >(() =>
    Object.fromEntries(
      menu.map((m) => {
        const pre = payload.lines.find((l) => l.item_id === m.id)
        const target = Object.fromEntries(
          Object.entries(pre?.target ?? {}).map(([k, v]) => [k, String(v)]),
        )
        return [
          m.id,
          { on: pre !== undefined, qty: String(pre?.quantity ?? m.min_quantity), target },
        ]
      }),
    ),
  )
  const lines: ServiceOrderLine[] = menu
    .filter((m) => rows[m.id]?.on === true)
    .map((m) => ({
      item_id: m.id,
      quantity: Number(rows[m.id]?.qty ?? 0),
      ...(m.target_fields.length === 0 ? {} : { target: rows[m.id]?.target ?? {} }),
    }))
  const check = normalizeServiceLines(asService(s), lines)
  const decidable = card.available_actions.includes('approve')
  const set = (
    id: string,
    patch: Partial<{ on: boolean; qty: string; target: Record<string, string> }>,
  ) =>
    setRows((r) => ({ ...r, [id]: { ...(r[id] ?? { on: false, qty: '', target: {} }), ...patch } }))
  return (
    <div className="mt-2.5 flex flex-col gap-2" data-testid="service-menu">
      <ul className="flex flex-col gap-1.5">
        {menu.map((m) => {
          const row = rows[m.id]
          return (
            <li key={m.id} className="flex flex-col gap-1 text-[13px]">
              <div className="flex flex-wrap items-center gap-2">
                <label className="flex min-w-0 items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={row?.on === true}
                    disabled={!decidable}
                    data-testid={`service-menu-pick-${m.id}`}
                    onChange={(e) => set(m.id, { on: e.target.checked })}
                  />
                  <span className="font-medium text-ws-ink">
                    {lang === 'zh' ? m.label_zh : m.label_en}
                  </span>
                </label>
                <span className="text-xs text-ws-muted-fg">
                  {t('svc.menu.unit_price', {
                    credits: creditsText(m.credits_per_unit, lang),
                    unit: lang === 'zh' ? m.unit_zh : m.unit_en,
                  })}
                </span>
                {row?.on === true ? (
                  <input
                    type="number"
                    min={m.min_quantity}
                    max={m.max_quantity}
                    aria-label={t('svc.menu.qty')}
                    className={`${field} ml-auto w-20 text-right tabular-nums`}
                    value={row.qty}
                    disabled={!decidable}
                    data-testid={`service-menu-qty-${m.id}`}
                    onChange={(e) => set(m.id, { qty: e.target.value })}
                  />
                ) : null}
              </div>
              {row?.on === true
                ? m.target_fields.map((f) => (
                    <input
                      key={f.name}
                      className={`${field} w-full`}
                      placeholder={f.label_zh}
                      aria-label={f.label_zh}
                      value={row.target[f.name] ?? ''}
                      disabled={!decidable}
                      data-testid={`service-menu-target-${m.id}-${f.name}`}
                      onChange={(e) =>
                        set(m.id, { target: { ...row.target, [f.name]: e.target.value } })
                      }
                    />
                  ))
                : null}
            </li>
          )
        })}
      </ul>
      <p
        className="flex flex-wrap items-center gap-1 text-[13px] text-ws-body"
        data-testid="service-menu-total"
      >
        <span className="font-semibold text-ws-ink">
          {t('svc.menu.total', { credits: creditsText(check.ok ? check.total_credits : 0, lang) })}
        </span>
        <span className="text-ws-muted-fg">
          · {terms(s, s.promise.deliver_hours, false)} · {t('svc.menu.refund')}
        </span>
        <Hint text={t('svc.menu.tip')} />
      </p>
      {decidable ? (
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            data-testid="service-menu-order"
            disabled={!check.ok || go.isPending}
            onClick={() => go.mutate({ edited: { ...payload, lines } })}
          >
            {t('svc.menu.order')}
          </Button>
          {!check.ok && lines.length > 0 ? (
            <span className="text-xs text-ws-warn">{check.message}</span>
          ) : lines.length === 0 ? (
            <span className="text-xs text-ws-muted-fg">{t('svc.menu.pick')}</span>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

/* ── 需求单 ──────────────────────────────────────────────────────── */

function RequirementsBody({
  card,
  payload,
}: {
  card: DeckCard
  payload: ServiceRequirementsCardPayload
}): ReactNode {
  const { t, lang } = useApp()
  const go = useDecideService(card)
  const s = payload.service
  const decidable = card.available_actions.includes('approve')
  const [answers, setAnswers] = useState<Record<string, string>>(() =>
    Object.fromEntries(payload.answers.map((a) => [a.question_id, a.answer])),
  )
  const anyMissing = s.questions.some(
    (q) => q.required === true && (answers[q.id] ?? '').trim() === '',
  )
  const [editing, setEditing] = useState(anyMissing)
  const list = s.questions.map((q) => ({ question_id: q.id, answer: answers[q.id] ?? '' }))
  const check = normalizeServiceRequirements(asService(s), list)
  const label = (q: (typeof s.questions)[number]) => (lang === 'zh' ? q.label_zh : q.label_en)
  return (
    <div className="mt-2.5 flex flex-col gap-2" data-testid="service-requirements">
      {editing && decidable ? (
        <div className="flex flex-col gap-1.5">
          {s.questions.map((q) => (
            <div key={q.id} className="flex flex-col gap-0.5 text-[13px]">
              <span className="text-ws-muted-fg">
                {label(q)}
                {q.required === true ? ` · ${t('svc.req.required')}` : ''}
              </span>
              {q.options === undefined ? (
                <input
                  className={`${field} w-full`}
                  aria-label={label(q)}
                  value={answers[q.id] ?? ''}
                  data-testid={`service-req-${q.id}`}
                  onChange={(e) => setAnswers((a) => ({ ...a, [q.id]: e.target.value }))}
                />
              ) : (
                <select
                  className={`${field} w-full`}
                  aria-label={label(q)}
                  value={answers[q.id] ?? ''}
                  data-testid={`service-req-${q.id}`}
                  onChange={(e) => setAnswers((a) => ({ ...a, [q.id]: e.target.value }))}
                >
                  <option value="">—</option>
                  {q.options.map((o) => (
                    <option key={o} value={o}>
                      {o}
                    </option>
                  ))}
                </select>
              )}
            </div>
          ))}
        </div>
      ) : (
        <p className="text-[13px] leading-[1.7] text-ws-body" data-testid="service-req-summary">
          {s.questions
            .filter((q) => (answers[q.id] ?? '').trim() !== '')
            .map((q) => `${label(q)}：${answers[q.id]}`)
            .join(' · ') || t('svc.req.empty')}
        </p>
      )}
      {decidable ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            data-testid="service-req-submit"
            disabled={!check.ok || go.isPending}
            onClick={() =>
              go.mutate({
                edited: { ...payload, answers: list.filter((a) => a.answer.trim() !== '') },
              })
            }
          >
            {s.pricing_mode === 'quote' ? t('svc.req.submit_quote') : t('svc.req.submit_fixed')}
          </Button>
          <Button
            size="sm"
            variant="outline"
            data-testid="service-req-edit"
            onClick={() => setEditing((v) => !v)}
          >
            {editing ? t('svc.req.done') : t('svc.req.edit')}
          </Button>
          {check.ok ? null : <span className="text-xs text-ws-warn">{check.message}</span>}
        </div>
      ) : null}
    </div>
  )
}

/* ── 下单卡（同意并支付） ───────────────────────────────────────── */

function PayBody({ card, payload }: { card: DeckCard; payload: ServicePayCardPayload }): ReactNode {
  const { t, lang } = useApp()
  const go = useDecideService(card)
  const terms = useTerms()
  const s = payload.service
  const decidable = card.available_actions.includes('approve')
  const ms = payload.milestones ?? []
  // WP403：追加费用那一种——加多少、为什么、交付顺延多久；随那一段验收结算
  if (payload.stage === 'extra')
    return (
      <div className="mt-2.5 flex flex-col gap-2" data-testid="service-pay" data-stage="extra">
        <p className="text-[22px] font-semibold text-ws-ink tabular-nums">
          {t('svc.extra.price', { credits: creditsText(payload.credits, lang) })}
        </p>
        {payload.extra_reason === undefined ? null : (
          <p className="text-[13px] text-ws-body">「{payload.extra_reason}」</p>
        )}
        <p className="flex items-center gap-1 text-[12px] text-ws-muted-fg">
          {payload.deliver_hours === undefined
            ? t('svc.extra.same_time')
            : t('svc.extra.later', {
                n: String(Math.max(1, Math.round(payload.deliver_hours / 24))),
              })}
          <Hint text={t('svc.extra.tip')} />
        </p>
        {decidable ? (
          <Button
            size="sm"
            className="w-fit"
            data-testid="service-pay-go"
            disabled={go.isPending}
            onClick={() => go.mutate({})}
          >
            {t('svc.pay.go')}
          </Button>
        ) : null}
      </div>
    )
  return (
    <div className="mt-2.5 flex flex-col gap-2" data-testid="service-pay">
      <p className="text-[22px] font-semibold text-ws-ink tabular-nums">
        {t('svc.offer.price', { credits: creditsText(payload.credits, lang) })}
      </p>
      <p className="text-[13px] text-ws-body">
        {terms(s, payload.deliver_hours ?? s.promise.deliver_hours)}
      </p>
      {ms.length > 1 ? (
        <p className="flex flex-wrap items-center gap-1 text-[12px] text-ws-muted-fg">
          {ms
            .map((m) => `${lang === 'zh' ? m.label_zh : m.label_en} ${m.share_percent}%`)
            .join(' / ')}
          <Hint text={t('svc.pay.milestones', { n: String(ms.length) })} />
        </p>
      ) : null}
      {payload.quote_note === undefined ? null : (
        <p className="text-[13px] text-ws-body">「{payload.quote_note}」</p>
      )}
      <p className="flex items-center gap-1 text-[12px] text-ws-muted-fg">
        {t('svc.pay.shares')}
        <Hint text={t('svc.pay.shares.tip')} />
      </p>
      {decidable ? (
        <Button
          size="sm"
          className="w-fit"
          data-testid="service-pay-go"
          disabled={go.isPending}
          onClick={() => go.mutate({})}
        >
          {t('svc.pay.go')}
        </Button>
      ) : null}
    </div>
  )
}

/* ── 验收卡 ──────────────────────────────────────────────────────── */

function AcceptanceBody({
  card,
  payload,
}: {
  card: DeckCard
  payload: ServiceAcceptanceCardPayload
}): ReactNode {
  const { t, lang } = useApp()
  const go = useDecideService(card)
  const decidable = card.available_actions.includes('approve')
  const [mode, setMode] = useState<'revise' | 'dispute' | undefined>(undefined)
  const [reason, setReason] = useState('')
  const proof = payload.proof
  const when = payload.auto_accept_at === undefined ? undefined : new Date(payload.auto_accept_at)
  const whenText =
    when === undefined
      ? undefined
      : when.toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-US', {
          month: 'numeric',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        })
  return (
    <div className="mt-2.5 flex flex-col gap-2" data-testid="service-acceptance">
      {payload.lines !== undefined && payload.lines.length > 0 ? (
        <ul className="flex flex-col gap-0.5 text-[13px] text-ws-body">
          {payload.lines.map((l) => (
            <li key={l.item_id}>
              {t('svc.acc.done_of', {
                label: lang === 'zh' ? l.label_zh : l.label_en,
                done: String(l.completed ?? l.quantity),
                qty: String(l.quantity),
              })}
            </li>
          ))}
        </ul>
      ) : null}
      {[...(proof?.links ?? []), ...(proof?.screenshots ?? [])].length > 0 ||
      payload.deliverables.some((d) => d.url !== undefined || d.text !== undefined) ? (
        <ul className="flex flex-col gap-0.5 text-[13px]" data-testid="service-acceptance-proof">
          {payload.deliverables.map((d) => (
            <li key={`${d.label}-${d.delivered_at}`} className="flex min-w-0 items-center gap-1">
              {d.url === undefined ? (
                <span className="truncate text-ws-body">
                  {d.label}
                  {d.text === undefined ? '' : `：${d.text}`}
                </span>
              ) : (
                <a
                  href={d.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="inline-flex min-w-0 items-center gap-1 truncate text-ws-brand hover:underline"
                >
                  {d.label}
                  <ExternalLink aria-hidden className="size-3 shrink-0" />
                </a>
              )}
            </li>
          ))}
          {[...(proof?.links ?? []), ...(proof?.screenshots ?? [])].map((u) => (
            <li key={u} className="min-w-0 truncate">
              <a
                href={u}
                target="_blank"
                rel="noreferrer noopener"
                className="text-ws-brand hover:underline"
              >
                {u}
              </a>
            </li>
          ))}
        </ul>
      ) : null}
      {whenText === undefined ? null : (
        <p className="text-[12px] text-ws-muted-fg">
          {t('svc.acc.auto', { at: whenText })}
          {payload.revisions_left > 0
            ? ` · ${t('svc.acc.revisions_left', { n: String(payload.revisions_left) })}`
            : ` · ${t('svc.acc.no_revisions')}`}
        </p>
      )}
      {decidable ? (
        mode === undefined ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              data-testid="service-accept"
              disabled={go.isPending}
              onClick={() => go.mutate({ option: 'accept' })}
            >
              {t('svc.acc.accept')}
            </Button>
            <Button
              size="sm"
              variant="outline"
              data-testid="service-revise"
              disabled={payload.revisions_left <= 0}
              onClick={() => setMode('revise')}
            >
              {t('svc.acc.revise')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              data-testid="service-dispute"
              onClick={() => setMode('dispute')}
            >
              {t('svc.acc.dispute')}
            </Button>
          </div>
        ) : (
          <form
            className="flex flex-col gap-1.5"
            onSubmit={(e) => {
              e.preventDefault()
              go.mutate({ option: mode, edited: { ...payload, reason: reason.trim() } })
            }}
          >
            <textarea
              className="min-h-16 rounded-md border border-ws-line bg-ws-card p-2 text-[13px] outline-none focus:border-ws-brand"
              placeholder={mode === 'dispute' ? t('svc.acc.reason_required') : t('svc.acc.reason')}
              value={reason}
              data-testid="service-acceptance-reason"
              onChange={(e) => setReason(e.target.value)}
            />
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                type="submit"
                data-testid="service-acceptance-send"
                disabled={go.isPending || (mode === 'dispute' && reason.trim() === '')}
              >
                {mode === 'dispute' ? t('svc.acc.dispute') : t('svc.acc.revise')}
              </Button>
              <Button size="sm" type="button" variant="ghost" onClick={() => setMode(undefined)}>
                {t('svc.req.done')}
              </Button>
            </div>
          </form>
        )
      ) : null}
    </div>
  )
}

/* ── 交换联系方式 ─────────────────────────────────────────────────── */

const CONTACT_KINDS: readonly ServiceContactKind[] = ['wechat', 'phone', 'email']

function ContactBody({
  card,
  payload,
}: {
  card: DeckCard
  payload: ServiceContactCardPayload
}): ReactNode {
  const { t } = useApp()
  const go = useDecideService(card)
  const decidable = card.available_actions.includes('approve')
  const [kind, setKind] = useState<ServiceContactKind>('wechat')
  const [value, setValue] = useState('')
  return (
    <div className="mt-2.5 flex flex-col gap-2" data-testid="service-contact">
      <p className="text-[13px] text-ws-body">「{payload.reason}」</p>
      {decidable ? (
        <>
          <div className="flex flex-wrap items-center gap-2 text-[13px]" role="radiogroup">
            {CONTACT_KINDS.map((k) => (
              <label key={k} className="flex items-center gap-1">
                <input
                  type="radio"
                  name={`contact-${card.id}`}
                  checked={kind === k}
                  onChange={() => setKind(k)}
                />
                {t(`svc.contact.${k}`)}
              </label>
            ))}
            <Hint text={t('svc.contact.tip')} />
          </div>
          <div className="flex items-center gap-2">
            <input
              className={`${field} min-w-0 flex-1`}
              placeholder={t('svc.contact.value', { kind: t(`svc.contact.${kind}`) })}
              value={value}
              data-testid="service-contact-value"
              onChange={(e) => setValue(e.target.value)}
            />
            <Button
              size="sm"
              data-testid="service-contact-agree"
              disabled={value.trim() === '' || go.isPending}
              onClick={() =>
                go.mutate({ edited: { ...payload, contact: { kind, value: value.trim() } } })
              }
            >
              {t('svc.contact.agree')}
            </Button>
          </div>
        </>
      ) : null}
    </div>
  )
}

/** 卡片流 / 时间线里的那一块（不是工坊服务卡回 `null`）。 */
export function ServiceCardBody({ card }: { card: DeckCard }): ReactNode {
  const p = card.detail.payload
  if (!isServiceOrderCardPayload(p)) return null
  switch (p.form) {
    case 'service_menu':
      return <MenuBody card={card} payload={p} />
    case 'service_requirements':
      return <RequirementsBody card={card} payload={p} />
    case 'service_pay':
      return <PayBody card={card} payload={p} />
    case 'service_acceptance':
      return <AcceptanceBody card={card} payload={p} />
    case 'service_contact':
      return <ContactBody card={card} payload={p} />
  }
}
