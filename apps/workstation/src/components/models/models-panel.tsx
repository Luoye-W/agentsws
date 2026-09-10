/**
 * 设置页的「模型」一段（WP25 交付 C）。
 *
 * 四块，从上到下：
 * 1. **已配的**——每条一行：地址、模型名、境内外、有没有 key、上次测试；两个动作：测试、删；
 * 2. **加一个**——两种种类各一张卡（DeepSeek 官方 / OpenAI 兼容自定义），
 *    卡上写清楚要准备什么（≤ 5 步 + 外链），表单是**不经模型的原生表单**；
 * 3. **默认模型**——按 purpose（跑活 / 抽取 / 反思 / 向量 / 判分 / 转写）各选一个，
 *    外加数据驻留与三级预算；
 * 4. **今天花了多少**——按 purpose 汇总的一张小表（22 §3 的 usage）。
 *
 * key 这条线：值从 `ModelForm` 的 FormData 出来 → `saveModelProvider` 发出去 → 结束。
 * 这个文件里没有一处把它放进 state、query 缓存、URL 或日志。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Brain, CheckCircle2, ExternalLink, Plus, Trash2, XCircle } from 'lucide-react'
import { useState } from 'react'
import { ModelForm, type ModelFormValues } from '@/components/models/model-form'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import type {
  ModelDefaultsView,
  ModelProviderKind,
  ModelProviderView,
  ModelPurposeName,
  ModelTestResult,
} from '@/lib/api'
import {
  discoverModelProviderModels,
  getModelDefaults,
  getModelUsage,
  listModelProviders,
  removeModelProvider,
  saveModelProvider,
  setModelDefaults,
  testModelProvider,
} from '@/lib/api'
import { useApp } from '@/lib/app-context'

const PURPOSES: ModelPurposeName[] = [
  'run',
  'extraction',
  'reflection',
  'embedding',
  'judge',
  'transcription',
]

export function ModelsPanel({ assignment }: { assignment?: string }): React.ReactNode {
  const { t } = useApp()
  const client = useQueryClient()
  const [adding, setAdding] = useState<ModelProviderKind | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [tests, setTests] = useState<Record<string, ModelTestResult>>({})
  const [error, setError] = useState<string | null>(null)

  const providers = useQuery({
    queryKey: ['model-providers', assignment],
    queryFn: () => listModelProviders(assignment),
  })
  const defaults = useQuery({
    queryKey: ['model-defaults', assignment],
    queryFn: () => getModelDefaults(assignment),
  })
  const usage = useQuery({
    queryKey: ['model-usage', assignment],
    queryFn: () => getModelUsage(assignment),
  })

  const refresh = (): void => {
    void client.invalidateQueries({ queryKey: ['model-providers'] })
    void client.invalidateQueries({ queryKey: ['model-defaults'] })
    // 接上模型之后首页那条黄条要消失
    void client.invalidateQueries({ queryKey: ['home'] })
  }

  /** 保存。`values.api_key` 只在这一次调用里存在——不进 state、不进 query key。 */
  const save = useMutation({
    mutationFn: (values: ModelFormValues & { kind: ModelProviderKind }) => {
      const { id, kind, ...rest } = values
      return saveModelProvider(id, { kind, ...rest }, assignment)
    },
    onSuccess: () => {
      setAdding(null)
      setEditing(null)
      setError(null)
      refresh()
    },
    onError: (e: Error) => {
      // 只记错误消息，不回显任何用户填的值
      setError(e.message)
    },
  })

  const runTest = useMutation({
    mutationFn: (id: string) => testModelProvider(id, assignment),
    onSuccess: (result, id) => {
      setTests((prev) => ({ ...prev, [id]: result }))
      refresh()
    },
    onError: (e: Error) => {
      setError(e.message)
    },
  })

  const drop = useMutation({
    mutationFn: (id: string) => removeModelProvider(id, assignment),
    onSuccess: () => {
      refresh()
    },
    onError: (e: Error) => {
      setError(e.message)
    },
  })

  /**
   * WP42「拉取模型列表」。`probe.api_key` 只在这一次调用里存在——
   * 不进 state、不进 query key、不进 query 缓存（`useMutation` 不缓存入参）。
   */
  const discover = (probe: {
    id: string
    base_url: string
    api_key?: string
    region: 'cn' | 'global'
  }) => {
    const { id, ...rest } = probe
    return discoverModelProviderModels(id, rest, assignment)
  }

  const saveDefaults = useMutation({
    mutationFn: (input: Parameters<typeof setModelDefaults>[0]) =>
      setModelDefaults(input, assignment),
    onSuccess: () => {
      setError(null)
      refresh()
    },
    onError: (e: Error) => {
      setError(e.message)
    },
  })

  if (providers.isPending || defaults.isPending) return <Skeleton className="h-64 w-full" />

  const rows = providers.data?.providers ?? []
  const templates = providers.data?.templates ?? []
  const settings = defaults.data
  const active = rows.filter((p) => p.active)

  return (
    <Card data-testid="models-panel">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Brain className="size-4" aria-hidden />
          {t('models.title')}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 text-sm">
        <p className="text-muted-foreground">{t('models.subtitle')}</p>

        {error === null ? null : (
          <p className="rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-xs text-destructive">
            {error}
          </p>
        )}

        {/* ① 已配的 */}
        <section className="flex flex-col gap-2">
          <h4 className="text-xs font-medium text-muted-foreground">{t('models.configured')}</h4>
          {rows.length === 0 ? (
            <p className="text-xs text-muted-foreground" data-testid="models-empty">
              {t('models.empty')}
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {rows.map((p) => (
                <li
                  key={p.id}
                  className="rounded-lg border p-2.5"
                  data-testid="model-row"
                  data-id={p.id}
                >
                  <ProviderRow
                    provider={p}
                    result={tests[p.id] ?? p.last_test}
                    busy={runTest.isPending || drop.isPending}
                    onTest={() => {
                      runTest.mutate(p.id)
                    }}
                    onEdit={() => {
                      setEditing((v) => (v === p.id ? null : p.id))
                    }}
                    onRemove={() => {
                      if (!globalThis.confirm(t('models.remove.confirm'))) return
                      drop.mutate(p.id)
                    }}
                  />
                  {editing === p.id ? (
                    <ModelForm
                      template={
                        templates.find((tpl) => tpl.kind === p.kind) ??
                        templates[0] ?? {
                          kind: p.kind,
                          label: p.label,
                          summary: '',
                          default_base_url: p.base_url,
                          default_model: p.model,
                          region: p.region,
                          steps: [],
                          links: [],
                        }
                      }
                      existing={p}
                      busy={save.isPending}
                      onDiscover={discover}
                      onCancel={() => {
                        setEditing(null)
                      }}
                      onSubmit={(values) => {
                        save.mutate({ ...values, kind: p.kind })
                      }}
                    />
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* ② 加一个 */}
        <section className="flex flex-col gap-2">
          <h4 className="text-xs font-medium text-muted-foreground">{t('models.add')}</h4>
          <div className="grid gap-2 lg:grid-cols-2">
            {templates.map((tpl) => (
              <div
                key={tpl.kind}
                className="rounded-lg border p-2.5"
                data-testid="model-template"
                data-kind={tpl.kind}
              >
                <p className="text-sm font-medium">{tpl.label}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">{tpl.summary}</p>
                <ol className="mt-1.5 list-decimal space-y-0.5 pl-4 text-[11px] text-muted-foreground">
                  {tpl.steps.map((step) => (
                    <li key={step}>{step}</li>
                  ))}
                </ol>
                <div className="mt-1.5 flex flex-wrap gap-2">
                  {tpl.links.map((link) => (
                    <a
                      key={link.url}
                      href={link.url}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="inline-flex items-center gap-1 text-[11px] text-primary underline-offset-4 hover:underline"
                    >
                      {link.label}
                      <ExternalLink className="size-3" aria-hidden />
                    </a>
                  ))}
                </div>
                {adding === tpl.kind ? (
                  <ModelForm
                    template={tpl}
                    busy={save.isPending}
                    onDiscover={discover}
                    onCancel={() => {
                      setAdding(null)
                    }}
                    onSubmit={(values) => {
                      save.mutate({ ...values, kind: tpl.kind })
                    }}
                  />
                ) : (
                  <Button
                    className="mt-2"
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setError(null)
                      setAdding(tpl.kind)
                    }}
                  >
                    <Plus aria-hidden />
                    {t('models.add.button')}
                  </Button>
                )}
              </div>
            ))}
          </div>
        </section>

        {settings === undefined || active.length === 0 ? null : (
          <>
            <Separator />
            {/* ③ 默认模型 + 驻留 + 预算 */}
            <DefaultsSection
              settings={settings}
              busy={saveDefaults.isPending}
              onChange={(input) => {
                saveDefaults.mutate(input)
              }}
            />
          </>
        )}

        {/* ④ 花了多少 */}
        {usage.data === undefined || usage.data.rows.length === 0 ? null : (
          <>
            <Separator />
            <section className="flex flex-col gap-2">
              <h4 className="text-xs font-medium text-muted-foreground">{t('models.usage')}</h4>
              <table className="w-full text-xs" data-testid="model-usage">
                <thead className="text-muted-foreground">
                  <tr className="border-b">
                    <th className="py-1 text-left font-normal">{t('models.usage.purpose')}</th>
                    <th className="py-1 text-right font-normal">{t('models.usage.calls')}</th>
                    <th className="py-1 text-right font-normal">{t('models.usage.tokens')}</th>
                    <th className="py-1 text-right font-normal">{t('models.usage.cost')}</th>
                  </tr>
                </thead>
                <tbody>
                  {usage.data.rows.map((row) => (
                    <tr key={row.purpose} className="border-b last:border-0">
                      <td className="py-1">{t(`models.purpose.${row.purpose}`)}</td>
                      <td className="py-1 text-right tabular-nums">{row.calls}</td>
                      <td className="py-1 text-right tabular-nums">
                        {(row.input_tokens + row.output_tokens).toLocaleString()}
                      </td>
                      <td className="py-1 text-right tabular-nums">{row.cost_base.toFixed(4)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {usage.data.budget.frozen ? (
                <p className="text-xs text-destructive">{t('models.budget.frozen')}</p>
              ) : null}
            </section>
          </>
        )}
      </CardContent>
    </Card>
  )
}

function ProviderRow({
  provider,
  result,
  busy,
  onTest,
  onEdit,
  onRemove,
}: {
  provider: ModelProviderView
  result: ModelTestResult | undefined
  busy: boolean
  onTest: () => void
  onEdit: () => void
  onRemove: () => void
}): React.ReactNode {
  const { t } = useApp()
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">
            {provider.label}
            <span className="ml-1.5 text-xs font-normal text-muted-foreground">
              {provider.model}
            </span>
            {provider.from_env === true ? (
              <span
                className="ml-1.5 rounded bg-muted px-1 py-px text-[10px] text-muted-foreground"
                data-testid="model-from-env"
              >
                {t('models.from_env')}
              </span>
            ) : null}
          </p>
          <p className="truncate text-[11px] text-muted-foreground">
            {provider.base_url} · {t(`models.region.${provider.region}`)}
          </p>
          {provider.active ? null : (
            <p className="text-[11px] text-destructive" data-testid="model-inactive">
              {provider.inactive_reason ?? t('models.inactive')}
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button size="xs" variant="outline" disabled={busy} onClick={onTest}>
            {t('models.test')}
          </Button>
          <Button size="xs" variant="ghost" onClick={onEdit}>
            {t('models.edit')}
          </Button>
          {provider.from_env === true ? null : (
            <Button size="xs" variant="ghost" disabled={busy} onClick={onRemove}>
              <Trash2 aria-hidden />
              <span className="sr-only">{t('models.remove')}</span>
            </Button>
          )}
        </div>
      </div>
      {result === undefined ? null : (
        <p
          className={
            result.ok
              ? 'flex items-center gap-1 text-[11px] text-emerald-600 dark:text-emerald-400'
              : 'flex items-center gap-1 text-[11px] text-destructive'
          }
          data-testid="model-test-result"
          data-ok={result.ok ? 'true' : 'false'}
        >
          {result.ok ? (
            <CheckCircle2 className="size-3" aria-hidden />
          ) : (
            <XCircle className="size-3" aria-hidden />
          )}
          <span>
            {result.detail ?? (result.ok ? t('models.test.ok') : t('models.test.failed'))}
            {result.model === undefined ? '' : ` · ${result.model}`}
            {result.duration_ms === undefined ? '' : ` · ${result.duration_ms}ms`}
          </span>
        </p>
      )}
    </div>
  )
}

function DefaultsSection({
  settings,
  busy,
  onChange,
}: {
  settings: ModelDefaultsView
  busy: boolean
  onChange: (input: Parameters<typeof setModelDefaults>[0]) => void
}): React.ReactNode {
  const { t } = useApp()
  return (
    <section className="flex flex-col gap-3" data-testid="model-defaults">
      <h4 className="text-xs font-medium text-muted-foreground">{t('models.defaults')}</h4>

      <label className="flex items-center justify-between gap-2 text-xs">
        <span>{t('models.defaults.default')}</span>
        <select
          className="rounded-md border bg-background px-2 py-1 text-xs"
          value={settings.default}
          disabled={busy}
          data-testid="model-default-select"
          onChange={(event) => {
            onChange({ default: event.currentTarget.value })
          }}
        >
          {settings.choices.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
      </label>

      {PURPOSES.map((purpose) => (
        <label key={purpose} className="flex items-center justify-between gap-2 text-xs">
          <span className="text-muted-foreground">{t(`models.purpose.${purpose}`)}</span>
          <select
            className="rounded-md border bg-background px-2 py-1 text-xs"
            value={settings.by_purpose[purpose] ?? ''}
            disabled={busy}
            data-testid="model-purpose-select"
            data-purpose={purpose}
            onChange={(event) => {
              const value = event.currentTarget.value
              const { [purpose]: _dropped, ...rest } = settings.by_purpose
              onChange({ by_purpose: value === '' ? rest : { ...rest, [purpose]: value } })
            }}
          >
            <option value="">{t('models.defaults.same_as_default')}</option>
            {settings.choices.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
      ))}

      <label className="flex items-center justify-between gap-2 text-xs">
        <span>{t('models.residency')}</span>
        <select
          className="rounded-md border bg-background px-2 py-1 text-xs"
          value={settings.data_residency}
          disabled={busy}
          data-testid="model-residency-select"
          onChange={(event) => {
            onChange({ data_residency: event.currentTarget.value === 'cn' ? 'cn' : 'any' })
          }}
        >
          <option value="cn">{t('models.residency.cn')}</option>
          <option value="any">{t('models.residency.any')}</option>
        </select>
      </label>

      <div className="grid grid-cols-3 gap-2">
        <BudgetInput
          label={t('models.budget.daily')}
          value={settings.budget.workspace_daily_base}
          busy={busy}
          onCommit={(v) => {
            onChange({ budget: withCap(settings.budget, 'workspace_daily_base', v) })
          }}
        />
        <BudgetInput
          label={t('models.budget.monthly')}
          value={settings.budget.workspace_monthly_base}
          busy={busy}
          onCommit={(v) => {
            onChange({ budget: withCap(settings.budget, 'workspace_monthly_base', v) })
          }}
        />
        <BudgetInput
          label={t('models.budget.assignment')}
          value={settings.budget.assignment_daily_base}
          busy={busy}
          onCommit={(v) => {
            onChange({ budget: withCap(settings.budget, 'assignment_daily_base', v) })
          }}
        />
      </div>
      <p className="text-[11px] text-muted-foreground">{t('models.budget.hint')}</p>
    </section>
  )
}

/**
 * 改一个上限。`exactOptionalPropertyTypes` 下 `{ a: undefined }` 与 `{}` 不是一回事，
 * 所以"清空"要真把这个键删掉，而不是塞一个 undefined 进去。
 */
function withCap(
  budget: ModelDefaultsView['budget'],
  key: keyof ModelDefaultsView['budget'],
  value: number | undefined,
): ModelDefaultsView['budget'] {
  const { [key]: _dropped, ...rest } = budget
  return value === undefined ? rest : { ...rest, [key]: value }
}

function BudgetInput({
  label,
  value,
  busy,
  onCommit,
}: {
  label: string
  value: number | undefined
  busy: boolean
  onCommit: (value: number | undefined) => void
}): React.ReactNode {
  return (
    <label className="flex flex-col gap-1 text-[11px]">
      <span className="text-muted-foreground">{label}</span>
      <input
        className="rounded-md border bg-background px-2 py-1 text-xs"
        type="number"
        min="0"
        step="1"
        defaultValue={value ?? ''}
        disabled={busy}
        data-testid="model-budget-input"
        onBlur={(event) => {
          const raw = event.currentTarget.value.trim()
          const parsed = raw === '' ? undefined : Number(raw)
          onCommit(parsed === undefined || !Number.isFinite(parsed) ? undefined : parsed)
        }}
      />
    </label>
  )
}
