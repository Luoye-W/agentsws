/**
 * WP509（决策 1730 B、1811）：「把红人同步到这张飞书表」那张**同步设置卡**的卡面（中栏，决策 1765「决策在中」）。
 *
 * 卡上就地改、改完点「开始同步」（主按钮在卡身里，带着改过的那一份批 = `edited_payload`）：
 * - 哪一列放什么：每列一个下拉（我们的字段 / 不写）；公式、人员这类写不进的列灰着；
 * - 按哪一列认人（主页链接 / 账号 / 邮箱…）；
 * - 同步什么（三个勾）、多久一次（三选一）；
 * - 单选列里对不上的阶段：每个一个下拉（已有选项 / 不写）；「对不上的在飞书里新建选项」默认不勾；
 * - 一行预览（会写成这样）。
 * 界面少字：为什么这样认人、三个勾各是什么放问号里。
 */
import type { DeckCard } from '@agentsws/deck'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ExternalLink } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { openExternal } from '@/components/connections/bridge'
import { FootButtons, useCardFootActions } from '@/components/deck/card-foot'
import { Segmented } from '@/components/design/segmented'
import { Hint } from '@/components/ui/hint'
import { decide } from '@/lib/api'
import { useApp } from '@/lib/app-context'

const rec = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}

type Cadence = 'realtime' | 'hourly' | 'daily'
type What = { new_creators: boolean; stages: boolean; collab_records: boolean }

interface SyncColumnRow {
  name: string
  type: string
  options?: string[]
  field: string | null
  samples?: string[]
}

export interface KolSyncPayload {
  form: 'kol_sync'
  sync_id: string
  name: string
  url: string
  kind: 'bitable' | 'sheet'
  columns: SyncColumnRow[]
  fields: { id: string; zh: string }[]
  key_column?: string
  what: What
  cadence: Cadence
  stage_column?: string
  stage_options?: string[]
  stage_map: { stage: string; zh: string; option: string | null }[]
  allow_new_options: boolean
  counts: { table_rows: number; in_scope: number; matched: number; to_append: number }
  preview: [string, string][]
  [k: string]: unknown
}

export function isKolSyncPayload(p: unknown): p is KolSyncPayload {
  const r = rec(p)
  return r.form === 'kol_sync' && Array.isArray(r.columns) && typeof r.sync_id === 'string'
}

/** 认人只认这几种字段的列（与服务端 `KEY_FIELDS` 同一份）。 */
const KEY_FIELDS = ['url', 'handle', 'email', 'name']
const NONE = '__none__'
const selectCls =
  'h-7 min-w-0 max-w-48 rounded-md border border-input bg-background px-1.5 text-xs text-foreground disabled:opacity-60'

export function KolSyncBody({
  card,
  payload,
}: {
  card: DeckCard
  payload: KolSyncPayload
}): ReactNode {
  const { t } = useApp()
  const client = useQueryClient()
  const [fields, setFields] = useState<Record<string, string | null>>(() =>
    Object.fromEntries(payload.columns.map((c) => [c.name, c.field])),
  )
  const [key, setKey] = useState<string | undefined>(payload.key_column)
  const [what, setWhat] = useState<What>(payload.what)
  const [cadence, setCadence] = useState<Cadence>(payload.cadence)
  const [stages, setStages] = useState<Record<string, string | null>>(() =>
    Object.fromEntries(payload.stage_map.map((m) => [m.stage, m.option])),
  )
  const [allowNew, setAllowNew] = useState(payload.allow_new_options)
  const decidable = card.available_actions.includes('approve')

  const keyChoices = payload.columns.filter((c) => {
    const f = fields[c.name]
    return f !== null && f !== undefined && KEY_FIELDS.includes(f)
  })
  const keyNow = keyChoices.some((c) => c.name === key) ? key : keyChoices[0]?.name

  const send = useMutation({
    mutationFn: () =>
      decide(
        card.id,
        {
          action: 'approve',
          version: card.version,
          via: 'workstation',
          edited_payload: {
            ...payload,
            columns: payload.columns.map((c) => ({ name: c.name, field: fields[c.name] ?? null })),
            key_column: keyNow ?? null,
            what,
            cadence,
            stage_map: Object.entries(stages).map(([stage, option]) => ({ stage, option })),
            allow_new_options: allowNew,
          },
        } as never,
        card.position_id,
      ),
    onSettled: () => {
      for (const key of ['approval', 'deck', 'kol-sync'])
        void client.invalidateQueries({ queryKey: [key] })
    },
  })
  const actions = decidable
    ? [
        {
          key: 'kol-sync-start',
          label: t('kolsync.card.start'),
          primary: true,
          disabled: send.isPending || send.isSuccess,
          testId: 'kol-sync-start',
          onSelect: () => send.mutate(),
        },
      ]
    : null
  const hosted = useCardFootActions(actions)
  const locked = !decidable || send.isSuccess
  const unmapped = payload.stage_map.filter((m) => m.option === null)
  const taken = new Set(Object.values(fields).filter((f): f is string => f !== null))

  return (
    <div className="mt-2.5 flex flex-col gap-3 text-[13px]" data-testid="deck-kol-sync">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-ws-muted-fg">
        <span data-testid="kol-sync-counts">
          {t('kolsync.card.counts', {
            rows: payload.counts.table_rows,
            matched: payload.counts.matched,
            append: payload.counts.to_append,
          })}
        </span>
        <button
          type="button"
          className="ws-link-muted inline-flex items-center gap-1"
          onClick={() => openExternal(payload.url)}
          data-testid="kol-sync-open"
        >
          <ExternalLink aria-hidden className="size-3.5" />
          {t('kolsync.card.open')}
        </button>
        <Hint text={t('kolsync.card.via')} />
      </div>

      <section className="flex flex-col gap-1.5" aria-label={t('kolsync.card.columns')}>
        <ul
          className="grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-2"
          data-testid="kol-sync-columns"
        >
          {payload.columns.map((c) => {
            const readonly = c.type === 'readonly'
            return (
              <li
                key={c.name}
                className="flex min-w-0 items-center gap-2"
                data-testid="kol-sync-column"
              >
                <span className="min-w-0 flex-1 truncate" title={(c.samples ?? []).join(' · ')}>
                  {c.name}
                  {c.name === keyNow ? (
                    <span className="ml-1 rounded-sm bg-ws-surface px-1 text-ws-tiny text-ws-muted-fg">
                      {t('kolsync.card.key')}
                    </span>
                  ) : null}
                </span>
                {readonly ? (
                  <span className="text-xs text-ws-muted-fg">{t('kolsync.card.readonly')}</span>
                ) : (
                  <select
                    className={selectCls}
                    value={fields[c.name] ?? NONE}
                    disabled={locked}
                    aria-label={c.name}
                    data-testid="kol-sync-field"
                    onChange={(e) => {
                      const v = e.target.value
                      setFields((prev) => ({ ...prev, [c.name]: v === NONE ? null : v }))
                    }}
                  >
                    <option value={NONE}>{t('kolsync.card.none')}</option>
                    {payload.fields
                      .filter((f) => f.id === fields[c.name] || !taken.has(f.id))
                      .map((f) => (
                        <option key={f.id} value={f.id}>
                          {f.zh}
                        </option>
                      ))}
                  </select>
                )}
              </li>
            )
          })}
        </ul>
        <div className="flex flex-wrap items-center gap-2 text-xs text-ws-muted-fg">
          {keyChoices.length === 0 ? (
            <span data-testid="kol-sync-key-none">{t('kolsync.card.key.none')}</span>
          ) : (
            <label className="flex items-center gap-1.5">
              {t('kolsync.card.key')}
              <select
                className={selectCls}
                value={keyNow}
                disabled={locked}
                data-testid="kol-sync-key"
                onChange={(e) => setKey(e.target.value)}
              >
                {keyChoices.map((c) => (
                  <option key={c.name} value={c.name}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <Hint text={t('kolsync.card.key.hint')} />
        </div>
      </section>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <fieldset className="flex flex-wrap items-center gap-3" data-testid="kol-sync-what">
          <legend className="sr-only">{t('kolsync.card.what')}</legend>
          {(['new_creators', 'stages', 'collab_records'] as const).map((k) => (
            <label key={k} className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={what[k]}
                disabled={locked}
                data-testid={`kol-sync-what-${k}`}
                onChange={(e) => setWhat((prev) => ({ ...prev, [k]: e.target.checked }))}
              />
              {t(`kolsync.what.${k}`)}
            </label>
          ))}
          <Hint text={t('kolsync.what.hint')} />
        </fieldset>
        <Segmented<Cadence>
          size="sm"
          label={t('kolsync.card.cadence')}
          value={cadence}
          testId="kol-sync-cadence"
          onChange={(v) => {
            if (!locked) setCadence(v)
          }}
          options={(['realtime', 'hourly', 'daily'] as const).map((v) => ({
            value: v,
            label: t(`kolsync.cadence.${v}`),
          }))}
        />
      </div>

      {unmapped.length === 0 || payload.stage_column === undefined ? null : (
        <section className="flex flex-col gap-1.5" data-testid="kol-sync-stages">
          <p className="text-xs text-ws-muted-fg">
            {t('kolsync.card.stages', { column: payload.stage_column })}
          </p>
          <ul className="flex flex-wrap gap-x-4 gap-y-1">
            {unmapped.map((m) => (
              <li key={m.stage} className="flex items-center gap-1.5">
                <span>{m.zh}</span>
                <select
                  className={selectCls}
                  value={stages[m.stage] ?? NONE}
                  disabled={locked}
                  aria-label={m.zh}
                  data-testid="kol-sync-stage"
                  onChange={(e) => {
                    const v = e.target.value
                    setStages((prev) => ({ ...prev, [m.stage]: v === NONE ? null : v }))
                  }}
                >
                  <option value={NONE}>{t('kolsync.card.stage.none')}</option>
                  {(payload.stage_options ?? []).map((o) => (
                    <option key={o} value={o}>
                      {o}
                    </option>
                  ))}
                  {allowNew ? <option value={m.zh}>{`＋ ${m.zh}`}</option> : null}
                </select>
              </li>
            ))}
          </ul>
          <label className="flex items-center gap-1.5 text-xs text-ws-muted-fg">
            <input
              type="checkbox"
              checked={allowNew}
              disabled={locked}
              data-testid="kol-sync-allow-new"
              onChange={(e) => setAllowNew(e.target.checked)}
            />
            {t('kolsync.card.allow_new')}
          </label>
        </section>
      )}

      {payload.preview.length === 0 ? null : (
        <section className="flex flex-col gap-1" data-testid="kol-sync-preview">
          <p className="text-xs text-ws-muted-fg">{t('kolsync.card.preview')}</p>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-md bg-ws-surface px-2.5 py-2 text-xs">
            {payload.preview
              .filter(([col]) => fields[col] !== null && fields[col] !== undefined)
              .map(([col, v]) => (
                <div key={col} className="col-span-2 grid grid-cols-subgrid">
                  <dt className="text-ws-muted-fg">{col}</dt>
                  <dd className="min-w-0 truncate">{v}</dd>
                </div>
              ))}
          </dl>
        </section>
      )}
      {decidable && !hosted ? <FootButtons actions={actions ?? []} /> : null}
    </div>
  )
}
