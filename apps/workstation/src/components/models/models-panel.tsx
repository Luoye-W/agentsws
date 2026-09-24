/**
 * 设置页的「模型」一段（WP25 交付 C）。
 *
 * WP127 起分两块：「文字与看图」（下面这四段）与「生图」（最下面，单独一档）。
 * 顶部一条提示：默认模型看不了图 / 还没验证过能不能看图（老用户升级上来）。
 *
 * 四段，从上到下：
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
import { VISION_MODEL_EXAMPLES } from '@agentsws/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Brain, CheckCircle2, ExternalLink, Plus, RefreshCw, Trash2, XCircle } from 'lucide-react'
import { useState } from 'react'
import { BrandIcon } from '@/components/brand-icons'
import { BrandScopeNote } from '@/components/brand-scope-note'
import { ImageModelSection } from '@/components/models/image-model-section'
import { ModelCheckSteps } from '@/components/models/model-check-steps'
import { ModelForm, type ModelFormValues, suggestProviderId } from '@/components/models/model-form'
import { SubscriptionPlan } from '@/components/models/subscription-plan'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Hint } from '@/components/ui/hint'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import type {
  ModelDefaultsView,
  ModelPricingRefreshResult,
  ModelPricingView,
  ModelProviderKind,
  ModelProviderTemplate,
  ModelProviderView,
  ModelPurposeName,
  ModelTestResult,
} from '@/lib/api'
import {
  discoverModelProviderModels,
  getModelDefaults,
  getModelPricing,
  getModelUsage,
  isAccountTemplate,
  isDeepSeekAccountKind,
  listModelProviders,
  refreshModelPricing,
  removeModelProvider,
  saveModelProvider,
  setModelDefaults,
  setModelInheritance,
  testModelProvider,
} from '@/lib/api'
import { useApp } from '@/lib/app-context'

/**
 * 一张模板卡的稳定标识（WP88）。
 *
 * 在这之前卡是按 `kind` 认的——`kind` 当时恰好一张卡一个。WP88 之后不是了：
 * 「OpenAI 兼容（自定义）」和「阿里云百炼」都是 `openai_compatible`（它俩确实是同一种
 * 接口形态，分两张卡是因为**要准备的东西不一样**）。再拿 `kind` 当 key，两张卡会共用
 * 一个 React key，点开一张另一张跟着展开。
 *
 * 所以按**接口地址**认——那正是两张卡真正不同的地方；而且 `suggestProviderId` 本来
 * 就是干这个的（表单里的"编号"也是它生成的，两处认出来的名字天然一致）。
 */
function templateSlug(kind: string, baseUrl: string): string {
  return `${kind}:${suggestProviderId(baseUrl, [])}`
}

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
  /** 现在展开的是哪张模板卡。存的是 {@link templateSlug}，不是 `kind`——见它的注释。 */
  const [adding, setAdding] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [tests, setTests] = useState<Record<string, ModelTestResult>>({})
  const [error, setError] = useState<string | null>(null)
  const [priceRefresh, setPriceRefresh] = useState<ModelPricingRefreshResult | null>(null)

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
  // WP42 内置价目表：表单照它自动填价。整份一次拿完，选模型时在本地查
  const pricing = useQuery({
    queryKey: ['model-pricing', assignment],
    queryFn: () => getModelPricing(assignment),
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

  /** WP42：去各家官网抓一次价。抓不到不算失败——内置价原样留着。 */
  const refreshPrices = useMutation({
    mutationFn: () => refreshModelPricing(assignment),
    onSuccess: (result) => {
      setPriceRefresh(result)
      void client.invalidateQueries({ queryKey: ['model-pricing'] })
      void client.invalidateQueries({ queryKey: ['model-providers'] })
    },
    onError: (e: Error) => {
      setError(e.message)
    },
  })

  /**
   * WP66（52 O3）：这个品牌的模型设置跟不跟随公司默认。
   *
   * 改完要把整页的三条查询都刷一遍——跟随与不跟随读的根本是**两份**设置。
   */
  const setInherit = useMutation({
    mutationFn: (on: boolean) => setModelInheritance(on, assignment),
    onSuccess: () => {
      setError(null)
      void client.invalidateQueries({ queryKey: ['model-usage'] })
      refresh()
    },
    onError: (e: Error) => {
      setError(e.message)
    },
  })

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
  /*
   * WP127：默认模型能不能看图（按上一次验证）。老用户升级上来多半是"还没验证过"——
   * 顶部一条提示，**不挡路**：岗位照常干活，只是要看图的那一步会明说。
   */
  const defaultRow =
    settings === undefined
      ? undefined
      : active.find((p) => `${p.id}/${p.model}` === settings.default)
  const visionStatus = defaultRow?.vision_status

  return (
    <Card data-testid="models-panel">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Brain className="size-4" aria-hidden />
          {t('models.title')}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 text-sm">
        <p className="flex items-center gap-1 text-muted-foreground">
          {t('models.subtitle')}
          <Hint text={t('models.subtitle.hint')} />
        </p>
        {/* WP66（52 O1）：模型设置按品牌各一份——多品牌时说一句这一页管的是谁 */}
        <BrandScopeNote testId="models-brand-scope" />

        {defaultRow === undefined || visionStatus === undefined || visionStatus === 'ok' ? null : (
          <p
            role="status"
            className="rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-xs text-amber-700 dark:text-amber-300"
            data-testid="models-vision-banner"
            data-status={visionStatus}
          >
            {t(`models.vision.banner.${visionStatus}`, {
              model: defaultRow.model,
              models: VISION_MODEL_EXAMPLES.join('、'),
            })}
          </p>
        )}

        {/*
          52 O3「跟随公司默认」。**只有多品牌、而且不是公司默认那个品牌才出现**——
          单品牌的机器上没有可跟随的对象，多一个开关只是多一件要理解的事。
        */}
        {settings?.org_default !== false ? null : (
          <section
            className="flex items-center justify-between gap-3 rounded-md border px-3 py-2"
            data-testid="models-inherit"
          >
            <div className="flex flex-col gap-0.5">
              <span className="flex items-center gap-1 font-medium">
                {t('models.inherit')}
                <Hint text={t('models.inherit.hint')} />
              </span>
              <span className="text-xs text-muted-foreground">
                {settings.inherit_org === true
                  ? t('models.inherit.following', {
                      brand: settings.org_default_brand ?? '',
                    })
                  : t('models.inherit.own')}
              </span>
            </div>
            <Switch
              checked={settings.inherit_org === true}
              disabled={setInherit.isPending}
              aria-label={t('models.inherit')}
              data-testid="models-inherit-switch"
              onCheckedChange={(on) => {
                setInherit.mutate(on)
              }}
            />
          </section>
        )}
        {settings?.inherit_org === true ? (
          <p className="text-xs text-muted-foreground" data-testid="models-inherit-readonly">
            {t('models.inherit.readonly')}
          </p>
        ) : null}

        {error === null ? null : (
          <p className="rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-xs text-destructive">
            {error}
          </p>
        )}

        {/* WP127：第一块「文字与看图」（第二块「生图」在最下面） */}
        <h3 className="flex items-center gap-1 text-sm font-medium" data-testid="models-text-title">
          {t('models.text.title')}
          <Hint text={t('models.text.hint')} />
        </h3>

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
                        // WP88：同一个 kind 现在可能有两张卡，先按接口地址认是哪一张
                        // （改一条百炼的配置，该看到百炼那张的预设，不是通用那张的）
                        templates.find(
                          (tpl) =>
                            templateSlug(tpl.kind, tpl.default_base_url) ===
                            templateSlug(p.kind, p.base_url),
                        ) ??
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
                      {...(pricing.data === undefined ? {} : { pricing: pricing.data })}
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

        {/* ② 加一个：**一家一张卡**，点进去再选方案（WP90，Luoye 定） */}
        <section className="flex flex-col gap-2">
          <h4 className="text-xs font-medium text-muted-foreground">{t('models.add')}</h4>
          <div className="grid gap-2 lg:grid-cols-2">
            {/* WP134：「用我的 DeepSeek 账号登录」是单独那一张卡（设置页下面），不进这一排 */}
            {groupTemplates(templates.filter((tpl) => !isAccountTemplate(tpl))).map((card) => (
              <VendorCard
                key={card.id}
                card={card}
                busy={save.isPending}
                takenIds={rows.map((p) => p.id)}
                onDiscover={discover}
                {...(assignment === undefined ? {} : { assignment })}
                {...(pricing.data === undefined ? {} : { pricing: pricing.data })}
                openPlan={adding}
                onOpenPlan={(slug) => {
                  setError(null)
                  setAdding(slug)
                }}
                onSubmit={(values, kind) => {
                  save.mutate({ ...values, kind })
                }}
              />
            ))}
          </div>
        </section>

        {/* ②′ 价目表：内置的 + 去官网抓一次 */}
        <section className="flex flex-col gap-1.5" data-testid="model-pricing">
          <div className="flex items-center justify-between gap-2">
            <h4 className="text-xs font-medium text-muted-foreground">{t('models.pricing')}</h4>
            <Button
              size="xs"
              variant="outline"
              disabled={refreshPrices.isPending}
              onClick={() => {
                setError(null)
                refreshPrices.mutate()
              }}
              data-testid="model-pricing-refresh"
            >
              <RefreshCw aria-hidden />
              {refreshPrices.isPending
                ? t('models.pricing.refreshing')
                : t('models.pricing.refresh')}
            </Button>
          </div>
          <p className="text-[11px] text-muted-foreground">
            {pricing.data?.refreshed_at === undefined
              ? t('models.pricing.builtin')
              : t('models.pricing.refreshed_at', {
                  at: pricing.data.refreshed_at.slice(0, 10),
                })}
          </p>
          {priceRefresh === null ? null : (
            <ul className="flex flex-col gap-0.5" data-testid="model-pricing-result">
              {priceRefresh.reason === undefined ? null : (
                <li className="text-[11px] text-amber-600 dark:text-amber-400">
                  {priceRefresh.reason}
                </li>
              )}
              {priceRefresh.vendors.map((v) => (
                <li
                  key={v.id}
                  className={
                    v.ok
                      ? 'text-[11px] text-muted-foreground'
                      : 'text-[11px] text-amber-600 dark:text-amber-400'
                  }
                >
                  {v.ok
                    ? t('models.pricing.vendor_ok', { label: v.label, n: v.models })
                    : t('models.pricing.vendor_failed', {
                        label: v.label,
                        reason: v.reason ?? '',
                      })}
                </li>
              ))}
            </ul>
          )}
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

        {/* WP127：第二块「生图」——单独一档，可以不配 */}
        <Separator />
        <ImageModelSection {...(assignment === undefined ? {} : { assignment })} />
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
            <BrandIcon
              provider={provider.kind}
              size={16}
              className="mr-1.5 inline-block align-text-bottom"
            />
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
          {/* WP134：账号登录那一条没什么可改的（没有 key、地址是官方的）；登出在它自己那张卡上 */}
          {isDeepSeekAccountKind(provider.kind) ? null : (
            <Button size="xs" variant="ghost" onClick={onEdit}>
              {t('models.edit')}
            </Button>
          )}
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
      {/* WP127：三步小清单（与向导第 ① 步同一个件） */}
      {result === undefined ? null : <ModelCheckSteps steps={result.steps} />}
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

      {/* WP43 ③：原来底下那段规则说明进问号 */}
      <div className="flex items-center gap-1">
        <span className="text-xs font-medium text-muted-foreground">{t('models.budget')}</span>
        <Hint text={t('models.budget.hint')} />
      </div>
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

/**
 * WP90（Luoye 定）：**同一家厂商 / 渠道的几个方案合成一张卡**，点进去再选方案。
 *
 * 在这之前是一个方案一张卡——阿里云百炼三张并排（按量 / Token Plan / Coding Plan），
 * 第一眼的问题变成"这三张有什么区别"，而那恰恰是用户还不知道的事。合成一张之后，
 * 第一眼是"阿里云百炼"，第二眼才是"你买的是哪个方案"——那个他答得上来。
 *
 * 分组键是服务端给的 `vendor`；没给的（老模板、第三方加的）自己独占一张卡，
 * 界面不用改。方案按 `plan_order` 排，默认选第一个。
 */
export interface VendorCardData {
  id: string
  label: string
  summary: string
  plans: ModelProviderTemplate[]
}

export function groupTemplates(templates: ModelProviderTemplate[]): VendorCardData[] {
  const cards: VendorCardData[] = []
  const byId = new Map<string, VendorCardData>()
  for (const tpl of templates) {
    const id = tpl.vendor ?? templateSlug(tpl.kind, tpl.default_base_url)
    let card = byId.get(id)
    if (card === undefined) {
      card = {
        id,
        label: tpl.vendor_label ?? tpl.label,
        summary: tpl.vendor_summary ?? tpl.summary,
        plans: [],
      }
      byId.set(id, card)
      cards.push(card)
    }
    card.plans.push(tpl)
  }
  for (const card of cards) {
    card.plans.sort((a, b) => (a.plan_order ?? 99) - (b.plan_order ?? 99))
  }
  return cards
}

/** 一张厂商卡：图标 + 卡名 + 方案单选 + 选中那个方案的说明与动作。 */
function VendorCard({
  card,
  busy,
  takenIds,
  assignment,
  pricing,
  openPlan,
  onOpenPlan,
  onDiscover,
  onSubmit,
}: {
  card: VendorCardData
  busy: boolean
  takenIds: string[]
  assignment?: string
  pricing?: ModelPricingView
  openPlan: string | null
  onOpenPlan: (slug: string | null) => void
  onDiscover: React.ComponentProps<typeof ModelForm>['onDiscover']
  onSubmit: (values: ModelFormValues, kind: ModelProviderKind) => void
}): React.ReactNode {
  const { t } = useApp()
  const [planIndex, setPlanIndex] = useState(0)
  const plan = card.plans[planIndex] ?? card.plans[0]
  if (plan === undefined) return null
  const slug = templateSlug(plan.kind, plan.default_base_url)

  return (
    <div
      className="rounded-lg border p-2.5"
      data-testid="model-template"
      data-kind={plan.kind}
      data-vendor={card.id}
      data-template={slug}
    >
      <p className="flex items-center gap-2 text-sm font-medium">
        {/* WP45 / WP90：图标按**卡的 id** 认（官网抓回来的官方图，运行时不联网） */}
        <BrandIcon provider={card.id} />
        {card.label}
      </p>
      <p className="mt-0.5 text-xs text-muted-foreground">{card.summary}</p>

      {card.plans.length < 2 ? null : (
        <fieldset className="mt-2 flex flex-wrap gap-1.5" data-testid="model-plans">
          <legend className="sr-only">{t('models.plan')}</legend>
          {card.plans.map((p, i) => (
            <label
              key={`${p.kind}:${p.plan_label ?? p.label}`}
              className={`cursor-pointer rounded-full border px-2 py-0.5 text-[11px] ${
                i === planIndex
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'text-muted-foreground'
              }`}
              data-testid="model-plan"
              data-selected={i === planIndex}
            >
              <input
                type="radio"
                className="sr-only"
                name={`plan-${card.id}`}
                checked={i === planIndex}
                onChange={() => {
                  setPlanIndex(i)
                  onOpenPlan(null)
                }}
              />
              {p.plan_label ?? p.label}
            </label>
          ))}
        </fieldset>
      )}

      <ol className="mt-1.5 list-decimal space-y-0.5 pl-4 text-[11px] text-muted-foreground">
        {plan.steps.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
      <div className="mt-1.5 flex flex-wrap gap-2">
        {plan.links.map((link) => (
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

      {/*
        订阅登录那种方案**没有表单**——没有 key 可填，只有一个登录按钮。
        其余方案照旧：一个"填 API key"按钮展开原生表单。
      */}
      {plan.auth === 'subscription' && plan.subscription_provider !== undefined ? (
        <SubscriptionPlan
          provider={plan.subscription_provider}
          {...(assignment === undefined ? {} : { assignment })}
        />
      ) : openPlan === slug ? (
        <ModelForm
          template={plan}
          busy={busy}
          onDiscover={onDiscover}
          takenIds={takenIds}
          {...(pricing === undefined ? {} : { pricing })}
          onCancel={() => onOpenPlan(null)}
          onSubmit={(values) => onSubmit(values, plan.kind)}
        />
      ) : (
        <Button className="mt-2" size="sm" variant="outline" onClick={() => onOpenPlan(slug)}>
          <Plus aria-hidden />
          {t('models.add.button')}
        </Button>
      )}
    </div>
  )
}
