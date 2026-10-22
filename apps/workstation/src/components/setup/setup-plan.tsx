/**
 * WP348（决策 887）：配置卡的卡面是**方案**，不是表单。
 *
 * - 「我打算这样设」：一格一行——AI 定的值 + 一句理由（来源可点开：哪条档案、哪个网页、哪个已连的账号）；
 *   查不到 / 不该 AI 猜的格子标「需要你填」。底下「就这样」（直接存、接着做）「改一下」（才展开表单，预填方案值）；
 *   「先不设」在卡底那一排。
 * - 「我打算改成这样」：只列要改的几格（现值 → 新值 + 理由），其余不动；人点头才生效。
 *
 * 表单本身沿用 {@link SetupFieldsBody}（WP324），不另造。
 */
import {
  isSecretLikeSetupKey,
  type SetupField,
  type SetupRequestPayload,
  type SetupSource,
  safeSourceUrl,
} from '@agentsws/contracts'
import { ArrowRight, ExternalLink } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useApp } from '@/lib/app-context'
import { SetupFieldsBody, useFieldText } from './setup-card'

type T = ReturnType<typeof useApp>['t']

function shown(f: SetupField, v: string | undefined, t: T): string | undefined {
  if (v === undefined || v.trim() === '') return undefined
  if (f.kind === 'toggle') return v === 'true' ? t('setup.plan.on') : t('setup.plan.off')
  if (f.kind === 'select') return f.options?.find((o) => o.value === v)?.label ?? v
  return v
}

function Sources({ sources }: { sources: readonly SetupSource[] }): ReactNode {
  if (sources.length === 0) return null
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {sources.map((s) => {
        const url = safeSourceUrl(s.url)
        const key = `${s.kind}:${s.label}:${s.url ?? ''}`
        return url === undefined ? (
          <span
            key={key}
            className="rounded-sm bg-ws-surface px-1 text-xs text-ws-muted-fg"
            data-testid="setup-plan-source"
            data-kind={s.kind}
          >
            {s.label}
          </span>
        ) : (
          <a
            key={key}
            href={url}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex max-w-[180px] items-center gap-0.5 truncate rounded-sm bg-ws-surface px-1 text-xs text-ws-brand hover:underline"
            data-testid="setup-plan-source"
            data-kind={s.kind}
          >
            <span className="truncate">{s.label}</span>
            <ExternalLink aria-hidden className="size-3 shrink-0" />
          </a>
        )
      })}
    </span>
  )
}

function Row({
  field,
  change,
  label,
  t,
}: {
  field: SetupField
  change: boolean
  label: string
  t: T
}): ReactNode {
  const value = shown(field, field.suggested, t)
  const needsYou = field.needs_you === true && value === undefined
  return (
    <li
      className="flex flex-col gap-0.5 py-1.5"
      data-testid="setup-plan-row"
      data-key={field.key}
      {...(needsYou ? { 'data-needs-you': 'true' } : {})}
    >
      <div className="flex items-baseline gap-2">
        <span className="w-24 shrink-0 text-xs text-ws-muted-fg">{label}</span>
        <span className="min-w-0 flex-1 text-sm break-words text-ws-ink">
          {change ? (
            <span className="inline-flex flex-wrap items-center gap-1">
              <span className="text-ws-muted-fg line-through" data-testid="setup-plan-current">
                {shown(field, field.current, t) ?? t('setup.plan.empty')}
              </span>
              <ArrowRight aria-hidden className="size-3 text-ws-muted-fg" />
              <span data-testid="setup-plan-value">{value ?? t('setup.plan.empty')}</span>
            </span>
          ) : needsYou ? (
            <span className="font-medium text-ws-warn" data-testid="setup-plan-needs-you">
              {t('setup.plan.needs_you')}
            </span>
          ) : (
            <span
              data-testid="setup-plan-value"
              className={value === undefined ? 'text-ws-muted-fg' : ''}
            >
              {value ?? t('setup.plan.empty')}
            </span>
          )}
        </span>
      </div>
      {field.suggested_why === undefined && (field.sources ?? []).length === 0 ? null : (
        <div className="flex flex-wrap items-center gap-1 pl-26 text-[12px] leading-5 text-ws-muted-fg">
          {field.suggested_why === undefined ? null : (
            <span data-testid="setup-plan-why">{field.suggested_why}</span>
          )}
          <Sources sources={field.sources ?? []} />
        </div>
      )}
    </li>
  )
}

/** 方案卡的身体（`payload.mode` 为 `plan` / `change`）。 */
export function SetupPlanBody({
  payload,
  saving,
  onAccept,
  onSave,
}: {
  payload: SetupRequestPayload
  saving: boolean
  /** 「就这样」：方案原样存（决定里不带值，服务端用方案值）。 */
  onAccept: () => void
  /** 「改一下」后保存：人改过的值为准。 */
  onSave: (values: Record<string, string>) => void
}): ReactNode {
  const { t } = useApp()
  const text = useFieldText(payload.target)
  // WP410（真机 #6）：出卡前没查成——照实说原因，直接摊开表单问人要不要填（不装成方案）
  const failed = payload.research_failed !== undefined
  const [editing, setEditing] = useState(failed)
  const change = payload.mode === 'change'
  const fields = payload.fields.filter((f) => !isSecretLikeSetupKey(f.key, f.label))
  const rows = change ? fields.filter((f) => (f.suggested ?? '') !== (f.current ?? '')) : fields
  // 必填又空着（需要你填）：「就这样」存不了，先展开表单
  const blocked =
    failed ||
    fields.some((f) => f.required && (f.suggested === undefined || f.suggested.trim() === ''))
  const steps = payload.steps ?? []
  if (editing)
    return (
      <div
        className="flex flex-col gap-2"
        data-testid="setup-plan"
        data-mode={payload.mode}
        data-editing="true"
      >
        {failed ? (
          <p className="text-sm leading-6 text-ws-warn" data-testid="setup-plan-research-failed">
            {payload.why}
          </p>
        ) : null}
        <SetupFieldsBody payload={{ ...payload, why: '' }} saving={saving} onSave={onSave} />
        <div>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setEditing(false)}
            data-testid="setup-plan-fold"
          >
            {t('setup.plan.fold')}
          </Button>
        </div>
      </div>
    )
  return (
    <div className="flex flex-col gap-1.5" data-testid="setup-plan" data-mode={payload.mode}>
      {payload.why === '' ? null : <p className="text-sm leading-6 text-ws-body">{payload.why}</p>}
      <ul className="divide-y divide-ws-line" data-testid="setup-plan-rows">
        {rows.map((f) => (
          <Row key={f.key} field={f} change={change} label={text(f).label} t={t} />
        ))}
      </ul>
      {change && rows.length < fields.length ? (
        <p className="text-[12px] text-ws-muted-fg">{t('setup.plan.rest_same')}</p>
      ) : null}
      {steps.length === 0 ? null : (
        <details className="text-[12px] text-ws-muted-fg" data-testid="setup-plan-steps">
          <summary className="cursor-pointer select-none">
            {t('setup.plan.steps', { n: steps.length })}
          </summary>
          <ul className="mt-1 flex flex-col gap-0.5 pl-3">
            {steps.map((s, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: 几行查过的记录，顺序固定
              <li key={i} className="flex flex-wrap items-center gap-1">
                <span>{s.text}</span>
                {s.source === undefined ? null : <Sources sources={[s.source]} />}
              </li>
            ))}
          </ul>
        </details>
      )}
      <div className="flex items-center gap-2 pt-1">
        <Button
          size="sm"
          disabled={saving || blocked}
          onClick={onAccept}
          data-testid="setup-plan-accept"
        >
          {t('setup.plan.accept')}
        </Button>
        <Button
          size="sm"
          variant={blocked ? 'default' : 'outline'}
          disabled={saving}
          onClick={() => setEditing(true)}
          data-testid="setup-plan-edit"
        >
          {t('setup.plan.edit')}
        </Button>
      </div>
    </div>
  )
}
