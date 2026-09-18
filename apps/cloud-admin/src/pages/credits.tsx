/**
 * 积分与会员（65 §6 / §7）。
 *
 * 三块：发放流水（可撤回未消耗部分——两个旧后台都没有这个动作）、手动会员 term、
 * 14 天内到期。发积分支持**粘贴一坨邮箱**：内测期最常见的动作就是"给这二十个人
 * 各发一百分"。
 */

import { useState } from 'react'
import {
  Button,
  Empty,
  Field,
  inputClass,
  Note,
  SectionTitle,
  Spinner,
  StatusPill,
  WsCard,
  WsTag,
} from '@/components/design'
import { PageHeader } from '@/components/layout'
import { api } from '@/lib/api'
import { useApp, useQuery } from '@/lib/app'
import { credits, day, orDash, when } from '@/lib/format'

interface GrantRow {
  id: string
  org_id: string
  org_name: string | null
  credits: number
  remaining: number
  granted_at: string
  expires_at: string | null
  source_ref: string | null
}

interface TermRow {
  id: string
  org_id: string
  org_name: string | null
  plan_id: string
  status: string
  starts_at: string
  ends_at: string
  cycles: number
  granted_cycles: number
  note?: string
}

interface CreditsPage {
  grants: { rows: GrantRow[]; total: number }
  terms: TermRow[]
  expiring: { id: string; org_id: string; remaining: number; expires_at: string }[]
  plans: {
    id: string
    label_zh: string
    label_en: string
    credits_per_cycle: number
    note_zh: string
  }[]
}

export function CreditsPage(): React.ReactNode {
  const { t, canWrite, lang } = useApp()
  const page = useQuery<CreditsPage>('/v1/admin/credits?limit=50')
  const [error, setError] = useState<string | undefined>(undefined)

  return (
    <>
      <PageHeader
        title={t('nav.credits')}
        note={canWrite ? undefined : <Note tone="info">{t('readonly.notice')}</Note>}
      />
      {page.loading && page.data === undefined && <Spinner label={t('loading')} />}
      {page.data !== undefined && (
        <div className="flex flex-col gap-5">
          {canWrite && (
            <div className="grid gap-4 xl:grid-cols-2">
              <GrantForm
                onDone={page.reload}
                onError={setError}
                plans={page.data.plans}
                lang={lang}
              />
              <MembershipForm
                onDone={page.reload}
                onError={setError}
                plans={page.data.plans}
                lang={lang}
              />
            </div>
          )}
          {error !== undefined && <Note tone="bad">{error}</Note>}

          <WsCard className="overflow-hidden">
            <div className="px-4 pt-4">
              <SectionTitle>{t('credits.grants')}</SectionTitle>
            </div>
            <div className="max-h-[340px] overflow-auto">
              <table className="w-full border-collapse">
                <thead>
                  <tr>
                    <th className="ws-th">{t('col.org')}</th>
                    <th className="ws-th text-right">{t('col.credits')}</th>
                    <th className="ws-th text-right">{t('col.remaining')}</th>
                    <th className="ws-th">{t('col.at')}</th>
                    <th className="ws-th">{t('col.expires')}</th>
                    <th className="ws-th" />
                  </tr>
                </thead>
                <tbody>
                  {page.data.grants.rows.map((row) => (
                    <tr key={row.id} className="ws-tr">
                      <td className="ws-td max-w-[220px] truncate" title={row.org_id}>
                        {orDash(row.org_name ?? row.org_id)}
                      </td>
                      <td className="ws-td ws-num text-right">{credits(row.credits)}</td>
                      <td className="ws-td ws-num text-right">{credits(row.remaining)}</td>
                      <td className="ws-td ws-num">{when(row.granted_at)}</td>
                      <td className="ws-td ws-num">{orDash(day(row.expires_at))}</td>
                      <td className="ws-td text-right">
                        {canWrite && row.remaining > 0 && (
                          <RevokeButton lotId={row.id} onDone={page.reload} onError={setError} />
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {page.data.grants.rows.length === 0 && <Empty label={t('empty')} />}
            </div>
          </WsCard>

          <div className="grid gap-4 xl:grid-cols-[2fr_1fr]">
            <WsCard className="overflow-hidden">
              <div className="px-4 pt-4">
                <SectionTitle>{t('credits.terms')}</SectionTitle>
              </div>
              <div className="max-h-[320px] overflow-auto">
                <table className="w-full border-collapse">
                  <thead>
                    <tr>
                      <th className="ws-th">{t('col.org')}</th>
                      <th className="ws-th">{t('col.plan')}</th>
                      <th className="ws-th">{t('col.status')}</th>
                      <th className="ws-th">{t('col.expires')}</th>
                      <th className="ws-th" />
                    </tr>
                  </thead>
                  <tbody>
                    {page.data.terms.map((term) => (
                      <tr key={term.id} className="ws-tr">
                        <td className="ws-td max-w-[200px] truncate">
                          {orDash(term.org_name ?? term.org_id)}
                        </td>
                        <td className="ws-td">
                          <WsTag>{term.plan_id}</WsTag>
                        </td>
                        <td className="ws-td">
                          <StatusPill tone={term.status === 'active' ? 'good' : 'neutral'}>
                            {term.status} {term.granted_cycles}/{term.cycles}
                          </StatusPill>
                        </td>
                        <td className="ws-td ws-num">{day(term.ends_at)}</td>
                        <td className="ws-td text-right">
                          {canWrite && term.status === 'active' && (
                            <CancelTermButton
                              termId={term.id}
                              onDone={page.reload}
                              onError={setError}
                            />
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {page.data.terms.length === 0 && <Empty label={t('empty')} />}
              </div>
            </WsCard>

            <WsCard className="p-4">
              <SectionTitle>{t('credits.expiring')}</SectionTitle>
              {page.data.expiring.length === 0 ? (
                <Empty label={t('empty')} />
              ) : (
                <ul className="flex flex-col gap-1.5 text-[13px]">
                  {page.data.expiring.map((lot) => (
                    <li key={lot.id} className="flex items-center justify-between gap-2">
                      <span className="min-w-0 truncate text-ws-muted-fg">{lot.org_id}</span>
                      <span className="ws-num">
                        {credits(lot.remaining)} · {day(lot.expires_at)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </WsCard>
          </div>
        </div>
      )}
    </>
  )
}

function RevokeButton({
  lotId,
  onDone,
  onError,
}: {
  lotId: string
  onDone: () => void
  onError: (message: string) => void
}): React.ReactNode {
  const { t } = useApp()
  const [busy, setBusy] = useState(false)
  return (
    <Button
      disabled={busy}
      onClick={() => {
        const reason = window.prompt(t('form.reason'))
        if (reason === null || reason.trim().length < 2) return
        setBusy(true)
        api
          .post('/v1/admin/credits/revoke', { lot_id: lotId, reason })
          .then(onDone)
          .catch((err: unknown) => {
            onError(err instanceof Error ? err.message : String(err))
          })
          .finally(() => {
            setBusy(false)
          })
      }}
    >
      {t('action.revoke_grant')}
    </Button>
  )
}

function CancelTermButton({
  termId,
  onDone,
  onError,
}: {
  termId: string
  onDone: () => void
  onError: (message: string) => void
}): React.ReactNode {
  const { t } = useApp()
  const [busy, setBusy] = useState(false)
  return (
    <Button
      disabled={busy}
      onClick={() => {
        const reason = window.prompt(t('form.reason'))
        if (reason === null || reason.trim().length < 2) return
        setBusy(true)
        api
          .post(`/v1/admin/membership/${termId}/cancel`, { reason })
          .then(onDone)
          .catch((err: unknown) => {
            onError(err instanceof Error ? err.message : String(err))
          })
          .finally(() => {
            setBusy(false)
          })
      }}
    >
      {t('action.cancel_membership')}
    </Button>
  )
}

function GrantForm({
  onDone,
  onError,
}: {
  onDone: () => void
  onError: (message: string) => void
  plans: CreditsPage['plans']
  lang: 'zh' | 'en'
}): React.ReactNode {
  const { t } = useApp()
  const [emails, setEmails] = useState('')
  const [amount, setAmount] = useState('100')
  const [kind, setKind] = useState<'granted' | 'purchased'>('granted')
  const [days, setDays] = useState('90')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<string | undefined>(undefined)

  const list = emails
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter((s) => s !== '')

  return (
    <WsCard className="flex flex-col gap-2 p-4">
      <SectionTitle>{t('action.grant')}</SectionTitle>
      <Field label={t('form.emails')}>
        <textarea
          rows={4}
          className={`${inputClass} h-auto py-2`}
          value={emails}
          onChange={(e) => {
            setEmails(e.target.value)
          }}
        />
      </Field>
      <div className="grid grid-cols-3 gap-2">
        <Field label={t('form.credits')}>
          <input
            className={inputClass}
            inputMode="decimal"
            value={amount}
            onChange={(e) => {
              setAmount(e.target.value)
            }}
          />
        </Field>
        <Field label={t('form.kind')}>
          <select
            className={inputClass}
            value={kind}
            onChange={(e) => {
              setKind(e.target.value as 'granted' | 'purchased')
            }}
          >
            <option value="granted">{t('form.kind.granted')}</option>
            <option value="purchased">{t('form.kind.purchased')}</option>
          </select>
        </Field>
        <Field label={t('form.expires_in_days')}>
          <input
            className={inputClass}
            inputMode="numeric"
            disabled={kind === 'purchased'}
            value={days}
            onChange={(e) => {
              setDays(e.target.value)
            }}
          />
        </Field>
      </div>
      <Field label={t('form.reason')}>
        <input
          className={inputClass}
          value={reason}
          onChange={(e) => {
            setReason(e.target.value)
          }}
        />
      </Field>
      <Button
        variant="primary"
        disabled={busy || list.length === 0 || reason.trim().length < 2 || Number(amount) <= 0}
        onClick={() => {
          setBusy(true)
          setResult(undefined)
          api
            .post<{ granted: unknown[]; skipped: { label: string; why: string }[] }>(
              '/v1/admin/credits/grant',
              {
                emails: list,
                credits: Number(amount),
                kind,
                ...(kind === 'granted' ? { expires_in_days: Number(days) } : {}),
                reason,
              },
            )
            .then((out) => {
              setResult(
                `${String(out.granted.length)} ok · ${String(out.skipped.length)} skipped${
                  out.skipped.length === 0 ? '' : `：${out.skipped.map((s) => s.label).join(', ')}`
                }`,
              )
              onDone()
            })
            .catch((err: unknown) => {
              onError(err instanceof Error ? err.message : String(err))
            })
            .finally(() => {
              setBusy(false)
            })
        }}
      >
        {t('action.grant')} ({list.length})
      </Button>
      {result !== undefined && <Note tone="good">{result}</Note>}
    </WsCard>
  )
}

function MembershipForm({
  onDone,
  onError,
  plans,
  lang,
}: {
  onDone: () => void
  onError: (message: string) => void
  plans: CreditsPage['plans']
  lang: 'zh' | 'en'
}): React.ReactNode {
  const { t } = useApp()
  const [email, setEmail] = useState('')
  const [plan, setPlan] = useState(plans[0]?.id ?? '')
  const [months, setMonths] = useState('3')
  const [until, setUntil] = useState('')
  const [grantNow, setGrantNow] = useState(true)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)

  return (
    <WsCard className="flex flex-col gap-2 p-4">
      <SectionTitle>{t('action.start_membership')}</SectionTitle>
      <Note tone="warn">{t('credits.plan_todo')}</Note>
      <Field label={t('col.email')}>
        <input
          className={inputClass}
          value={email}
          onChange={(e) => {
            setEmail(e.target.value)
          }}
        />
      </Field>
      <div className="grid grid-cols-3 gap-2">
        <Field label={t('form.plan')}>
          <select
            className={inputClass}
            value={plan}
            onChange={(e) => {
              setPlan(e.target.value)
            }}
          >
            {plans.map((p) => (
              <option key={p.id} value={p.id}>
                {lang === 'zh' ? p.label_zh : p.label_en}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('form.months')}>
          <input
            className={inputClass}
            inputMode="numeric"
            value={months}
            disabled={until !== ''}
            onChange={(e) => {
              setMonths(e.target.value)
            }}
          />
        </Field>
        <Field label={t('form.until')}>
          <input
            className={inputClass}
            type="date"
            value={until}
            onChange={(e) => {
              setUntil(e.target.value)
            }}
          />
        </Field>
      </div>
      <label className="flex items-center gap-2 text-xs text-ws-muted-fg">
        <input
          type="checkbox"
          checked={grantNow}
          onChange={(e) => {
            setGrantNow(e.target.checked)
          }}
        />
        {t('form.grant_now')}
      </label>
      <Field label={t('form.note')}>
        <input
          className={inputClass}
          value={note}
          onChange={(e) => {
            setNote(e.target.value)
          }}
        />
      </Field>
      <Button
        variant="primary"
        disabled={busy || email.trim() === '' || plan === ''}
        onClick={() => {
          setBusy(true)
          api
            .post('/v1/admin/membership/start', {
              email: email.trim(),
              plan_id: plan,
              ...(until === ''
                ? { months: Number(months) }
                : { until: new Date(`${until}T00:00:00Z`).toISOString() }),
              grant_now: grantNow,
              ...(note === '' ? {} : { note }),
            })
            .then(() => {
              onDone()
            })
            .catch((err: unknown) => {
              onError(err instanceof Error ? err.message : String(err))
            })
            .finally(() => {
              setBusy(false)
            })
        }}
      >
        {t('action.start_membership')}
      </Button>
    </WsCard>
  )
}
