/**
 * 设置 →「模型」（WP25 交付 C；WP426 整页重做，Luoye 10-19 真机 beta.3）。
 *
 * 原来「已配的」和「加一个」是一堆一样大的卡，每张卡里又有方案切换、风险提示、下拉、登出；顶上一条
 * 吓人的「升级后要重新验证」。WP426 分三块，主次清楚（参照 Claude 桌面版设置页的克制）：
 *
 * 1. **正在用**——已经接上的来源一行一个（API key、DeepSeek 账号、ChatGPT 订阅、工坊积分）；
 *    每行一枚看得懂的状态标签（「能用 · 能看图」「还没测」「连不上」，细节在 tooltip）；
 *    下面是「默认模型」、WP425 的「自己的用不了时用工坊积分」，「按用途分别选」折起来。
 * 2. **加一个**——紧凑列表，分两组：「登录账号 / 订阅」与「填 API key」。同一家的两种连法拆到两组
 *    （DeepSeek 账号 / DeepSeek 官方 key、ChatGPT 订阅 / OpenAI key）；已经接上的登录类不再重复出现。
 *    填 key 的点开才展开原生表单。
 * 3. **价目与用量**——折起来放最下面（价目表、今天花了多少、预算上限）。
 *
 * 「升级后要重新验证能不能看图」不再提示：默认模型还没验证过就**自己在后台测一次**（十来个 token），
 * 测完静默更新；只有测出来看不了图才说。
 *
 * key 这条线：值从 `ModelForm` 的 FormData 出来 → `saveModelProvider` 发出去 → 结束。
 * 这个文件里没有一处把它放进 state、query 缓存、URL 或日志。
 */
import { VISION_MODEL_EXAMPLES } from '@agentsws/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CheckCircle2, ChevronDown, Plus, RefreshCw, Trash2, XCircle } from 'lucide-react'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { BrandIcon } from '@/components/brand-icons'
import { BrandScopeNote } from '@/components/brand-scope-note'
import { BrandMark, GroupLabel, InfoTip, StatusPill, testedMs, useFresh } from '@/components/design'
import { TutorialHint } from '@/components/help/tutorial-link'
import { AiSourceOrder } from '@/components/models/ai-source-order'
import { DeepSeekAccountLogin } from '@/components/models/deepseek-account-login'
import { ImageModelSection } from '@/components/models/image-model-section'
import { ModelStatusIcons } from '@/components/models/model-check-steps'
import { ModelForm, type ModelFormValues, suggestProviderId } from '@/components/models/model-form'
import { QuotaNotice } from '@/components/models/quota-notice'
import {
  AI_SUBSCRIPTION_CARDS,
  SubscriptionPlan,
  subscriptionTemplateShown,
} from '@/components/models/subscription-plan'
import { WebSearchToggle } from '@/components/models/web-search-toggle'
import { CloudPlanActions } from '@/components/settings/model-cloud-card'
import { Button } from '@/components/ui/button'
import { Hint } from '@/components/ui/hint'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import type {
  ModelAiSourceView,
  ModelDefaultsView,
  ModelPricingRefreshResult,
  ModelPricingView,
  ModelProviderKind,
  ModelProviderTemplate,
  ModelProviderView,
  ModelPurposeName,
  ModelTestResult,
  SubscriptionProviderId,
} from '@/lib/api'
import {
  DEEPSEEK_ACCOUNT_PROVIDER_ID,
  discoverModelProviderModels,
  getDeepSeekAccount,
  getModelDefaults,
  getModelPricing,
  getModelSubscription,
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
import { firstSentence, HELP_BY_VENDOR, templateGuide } from '@/lib/help'
import { compactChoices } from '@/lib/model-picker-compact'
import { cn } from '@/lib/utils'

/**
 * 一张模板卡的稳定标识（WP88）。
 *
 * 「OpenAI 兼容（自定义）」和「阿里云百炼」都是 `openai_compatible`——按 `kind` 认会撞，
 * 所以按**接口地址**认（与表单里「编号」的猜法同一个 `suggestProviderId`）。
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
  'classify',
]

/** 这条模板是不是「登录」那一类（订阅 / 账号 / 工坊积分）——没有 key 可填。 */
export function isLoginTemplate(tpl: Pick<ModelProviderTemplate, 'auth' | 'kind'>): boolean {
  return (
    tpl.kind === 'agentsws_cloud' ||
    tpl.auth === 'cloud' ||
    tpl.auth === 'subscription' ||
    isAccountTemplate(tpl)
  )
}

/** WP426：「加一个」里的一行——同一家的登录类与填 key 类拆成两行，分在两组。 */
export interface AddItem extends VendorCardData {
  group: 'login' | 'key'
  /** 厂商 id（图标、教程、词条都按它找）。 */
  vendor: string
}

/** 按厂商合成之后再按「登录 / 填 key」拆开（顺序跟服务端给的一样）。 */
export function splitAddItems(templates: ModelProviderTemplate[]): {
  login: AddItem[]
  key: AddItem[]
} {
  const login: AddItem[] = []
  const key: AddItem[] = []
  for (const card of groupTemplates(templates)) {
    const logins = card.plans.filter(isLoginTemplate)
    const keys = card.plans.filter((p) => !isLoginTemplate(p))
    if (logins.length > 0)
      login.push({
        ...card,
        id: `${card.id}:login`,
        vendor: card.id,
        group: 'login',
        plans: logins,
      })
    if (keys.length > 0)
      key.push({ ...card, id: `${card.id}:key`, vendor: card.id, group: 'key', plans: keys })
  }
  return { login, key }
}

export function ModelsPanel({ assignment }: { assignment?: string }): React.ReactNode {
  const { t } = useApp()
  const client = useQueryClient()
  /** 现在展开的是哪一行的表单（{@link templateSlug}）。 */
  const [adding, setAdding] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [tests, setTests] = useState<Record<string, ModelTestResult>>({})
  const [error, setError] = useState<string | null>(null)
  const [priceRefresh, setPriceRefresh] = useState<ModelPricingRefreshResult | null>(null)
  /** 这次打开页面时已经替用户在后台测过的那几条（同一条只测一次）。 */
  const silentlyTested = useRef(new Set<string>())
  const [silentTesting, setSilentTesting] = useState<string | null>(null)

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
  const templates = providers.data?.templates ?? []
  /*
   * WP426：登录类的现状（与卡里那几个件同一个 queryKey，共用缓存，不多打一次）——
   * 登上了就进「正在用」，「加一个」里不再重复出现。
   */
  const subProvider: SubscriptionProviderId | undefined = templates.find(
    (tpl) =>
      tpl.auth === 'subscription' &&
      tpl.subscription_provider !== undefined &&
      subscriptionTemplateShown(tpl) &&
      AI_SUBSCRIPTION_CARDS.some((c) => c.provider === tpl.subscription_provider && c.enabled),
  )?.subscription_provider
  const subscription = useQuery({
    queryKey: ['model-subscription', subProvider, assignment],
    queryFn: () => getModelSubscription(subProvider ?? 'openai-codex', assignment),
    enabled: subProvider !== undefined,
  })
  const hasAccountTemplate = templates.some((tpl) => isAccountTemplate(tpl))
  const account = useQuery({
    queryKey: ['deepseek-account', assignment],
    queryFn: () => getDeepSeekAccount(assignment),
    enabled: hasAccountTemplate,
    retry: false,
  })

  const refresh = (): void => {
    void client.invalidateQueries({ queryKey: ['model-providers'] })
    void client.invalidateQueries({ queryKey: ['model-defaults'] })
    // WP370：设置页与输入框 AI 钮同一份清单——存完 AI 钮跟着换
    void client.invalidateQueries({ queryKey: ['free-chat', 'models'] })
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
    /** WP374：按哪种接口去拉（Anthropic 兼容口要说）。 */
    kind?: ModelProviderKind
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

  /** WP66（52 O3）：这个品牌的模型设置跟不跟随公司默认（跟随与不跟随读的是两份设置，整页刷）。 */
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

  const rows = providers.data?.providers ?? []
  const settings = defaults.data
  const active = rows.filter((p) => p.active)
  const defaultRow =
    settings === undefined
      ? undefined
      : active.find((p) => `${p.id}/${p.model}` === settings.default)

  /*
   * WP426：默认模型还没验证过能不能看图（老用户升级上来）——不再叫人去点「测试」，
   * 自己在后台测一次（三步，十来个 token），测完静默刷新；只有测出来看不了图才提示。
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只看默认那一条的身份与验证状态（refresh 每次渲染都是新的）
  useEffect(() => {
    if (defaultRow === undefined || defaultRow.image_only === true) return
    if (defaultRow.vision_status !== 'unchecked') return
    if (silentlyTested.current.has(defaultRow.id)) return
    silentlyTested.current.add(defaultRow.id)
    const id = defaultRow.id
    setSilentTesting(id)
    void testModelProvider(id, assignment)
      .then(
        (result) => {
          setTests((prev) => ({ ...prev, [id]: result }))
          refresh()
        },
        () => undefined,
      )
      .finally(() => {
        setSilentTesting(null)
      })
  }, [defaultRow?.id, defaultRow?.vision_status, defaultRow?.image_only, assignment])

  if (providers.isPending || defaults.isPending) return <Skeleton className="h-64 w-full" />

  const visionStatus = defaultRow?.vision_status
  const { login: loginItems, key: keyItems } = splitAddItems(templates)
  const subSignedIn =
    subProvider !== undefined &&
    subscription.data?.available === true &&
    subscription.data.signed_in
  const accountRow = rows.find((p) => isDeepSeekAccountKind(p.kind))
  /** DeepSeek 账号登上了（还没存成一条来源也算——那一下由「正在用」里的件替他存 + 测）。 */
  const accountIn = account.data?.signed_in === true || accountRow !== undefined
  const cloudRow = rows.find((p) => p.kind === 'agentsws_cloud')
  /** 「加一个 → 登录」里已经接上的不再出现（它在「正在用」里）。 */
  const loginShown = loginItems.filter((item) => {
    const plan = item.plans[0]
    if (plan === undefined) return false
    if (item.plans.length > 1) return true
    if (plan.auth === 'subscription') return !subSignedIn
    if (isAccountTemplate(plan)) return !accountIn
    if (plan.kind === 'agentsws_cloud' || plan.auth === 'cloud') return cloudRow === undefined
    return true
  })
  const keyRows = rows.filter((p) => !isDeepSeekAccountKind(p.kind))
  const inUseCount = keyRows.length + (accountIn ? 1 : 0) + (subSignedIn ? 1 : 0)
  const defaultId = settings?.default ?? ''
  const isDefault = (prefix: string): boolean => defaultId.startsWith(`${prefix}/`)
  const readonly = settings?.inherit_org === true

  const editTemplate = (p: ModelProviderView): ModelProviderTemplate =>
    // WP88：同一个 kind 现在可能有两张卡，先按接口地址认是哪一张
    templates.find(
      (tpl) => templateSlug(tpl.kind, tpl.default_base_url) === templateSlug(p.kind, p.base_url),
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

  return (
    <div className="flex flex-col gap-8 pt-3 pb-2 text-sm" data-testid="models-panel">
      {/* WP66（52 O1）：模型设置按品牌各一份——多品牌时说一句这一页管的是谁 */}
      <BrandScopeNote testId="models-brand-scope" />

      {/* 52 O3「跟随公司默认」：只有多品牌、而且不是公司默认那个品牌才出现 */}
      {settings?.org_default !== false ? null : (
        <section
          className="flex items-center justify-between gap-3 rounded-xl border border-ws-line px-4 py-3"
          data-testid="models-inherit"
        >
          <div className="flex flex-col gap-0.5">
            <span className="flex items-center gap-1 font-medium">
              {t('models.inherit')}
              <Hint text={t('models.inherit.hint')} />
            </span>
            <span className="text-xs text-muted-foreground">
              {settings.inherit_org === true
                ? t('models.inherit.following', { brand: settings.org_default_brand ?? '' })
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
      {readonly ? (
        <p className="-mt-6 text-xs text-muted-foreground" data-testid="models-inherit-readonly">
          {t('models.inherit.readonly')}
        </p>
      ) : null}

      {error === null ? null : (
        <p className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </p>
      )}

      {/* ① 正在用 */}
      <Block
        title={t('models.in_use')}
        hint={t('models.in_use.hint')}
        testId="models-in-use"
        count={inUseCount}
      >
        {/* 只有测出来看不了图才说（还没验证过的那种，上面那段 effect 自己在后台测） */}
        {defaultRow === undefined || visionStatus !== 'no' ? null : (
          <p
            role="status"
            className="rounded-lg bg-ws-warn-bg px-3 py-2 text-xs text-ws-warn"
            data-testid="models-vision-banner"
            data-status={visionStatus}
          >
            {t('models.vision.banner.no', {
              model: defaultRow.model,
              models: VISION_MODEL_EXAMPLES.join('、'),
            })}
          </p>
        )}

        {inUseCount === 0 ? (
          <p
            className="rounded-xl border border-dashed border-ws-line px-4 py-6 text-center text-xs text-ws-muted-fg"
            data-testid="models-empty"
          >
            {t('models.empty')}
          </p>
        ) : (
          <ul className="ws-group divide-y divide-ws-line">
            {subSignedIn && subProvider !== undefined ? (
              <SourceShell
                testId="model-row-subscription"
                icon={<BrandIcon provider="openai" size={20} />}
                title={t('models.add.login.openai')}
                badge={isDefault(subProvider) ? t('models.default_badge') : undefined}
                status={
                  <StatusPill tone="good">{t('models.subscription.signed_in.short')}</StatusPill>
                }
              >
                <SubscriptionPlan
                  provider={subProvider}
                  {...(assignment === undefined ? {} : { assignment })}
                />
              </SourceShell>
            ) : null}
            {accountIn ? (
              <SourceShell
                testId="model-row-account"
                {...(accountRow === undefined ? {} : { rowId: accountRow.id })}
                icon={<BrandIcon provider="deepseek" size={20} />}
                title={t('models.add.login.deepseek')}
                badge={
                  isDefault(accountRow?.id ?? DEEPSEEK_ACCOUNT_PROVIDER_ID)
                    ? t('models.default_badge')
                    : undefined
                }
              >
                <DeepSeekAccountLogin {...(assignment === undefined ? {} : { assignment })} />
              </SourceShell>
            ) : null}
            {keyRows.map((p) => (
              <ProviderRow
                key={p.id}
                provider={p}
                isDefault={isDefault(p.id)}
                result={tests[p.id] ?? p.last_test}
                testing={
                  (runTest.isPending && runTest.variables === p.id) || silentTesting === p.id
                }
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
                body={
                  p.kind === 'agentsws_cloud' ? (
                    <CloudPlanActions {...(assignment === undefined ? {} : { assignment })} />
                  ) : null
                }
                form={
                  editing === p.id ? (
                    <ModelForm
                      imageOnly={p.image_only === true}
                      template={editTemplate(p)}
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
                  ) : null
                }
              />
            ))}
          </ul>
        )}

        {/* WP362：只登了 ChatGPT 订阅也要有默认模型这一块——按能选的清单判 */}
        {settings === undefined || (active.length === 0 && settings.choices.length === 0) ? null : (
          <DefaultsSection
            settings={settings}
            busy={saveDefaults.isPending}
            onChange={(input) => {
              saveDefaults.mutate(input)
            }}
          />
        )}
      </Block>

      {/* ② 加一个：两组，紧凑一行一家 */}
      <Block title={t('models.add')} hint={t('models.add.hint')} testId="models-add">
        {[
          { id: 'login' as const, title: t('models.add.login'), items: loginShown },
          { id: 'key' as const, title: t('models.add.key'), items: keyItems },
        ].map((g) =>
          g.items.length === 0 ? null : (
            <div key={g.id} className="flex flex-col gap-2" data-testid={`models-add-${g.id}`}>
              <GroupLabel>{g.title}</GroupLabel>
              <ul className="ws-group divide-y divide-ws-line">
                {g.items.map((item) => (
                  <AddRow
                    key={item.id}
                    item={item}
                    busy={save.isPending}
                    configured={rows}
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
              </ul>
            </div>
          ),
        )}
      </Block>

      {/* WP179 / WP353：「联网搜索」开关；WP127：「生图」单独一档 */}
      <div className="flex flex-col gap-6 border-t border-ws-line pt-6">
        <WebSearchToggle {...(assignment === undefined ? {} : { assignment })} />
        <ImageModelSection {...(assignment === undefined ? {} : { assignment })} />
      </div>

      {/* ③ 价目与用量：折起来放最下面 */}
      <Fold title={t('models.costs')} hint={t('models.costs.hint')} testId="models-costs">
        <section className="flex flex-col gap-1.5" data-testid="model-pricing">
          <div className="flex items-center justify-between gap-2">
            <h4 className="flex items-center gap-1 text-xs font-medium text-ws-muted-fg">
              {t('models.pricing')}
              <Hint text={t('models.pricing.hint')} />
            </h4>
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
          <p className="text-xs text-muted-foreground" data-slot="status">
            {pricing.data?.refreshed_at === undefined
              ? t('models.pricing.builtin')
              : t('models.pricing.refreshed_at', { at: pricing.data.refreshed_at.slice(0, 10) })}
          </p>
          {priceRefresh === null ? null : (
            <ul className="flex flex-col gap-0.5" data-testid="model-pricing-result">
              {priceRefresh.reason === undefined ? null : (
                <li className="text-xs text-ws-warn">{priceRefresh.reason}</li>
              )}
              {priceRefresh.vendors.map((v) => (
                <li
                  key={v.id}
                  className={v.ok ? 'text-xs text-muted-foreground' : 'text-xs text-ws-warn'}
                >
                  {v.ok
                    ? t('models.pricing.vendor_ok', { label: v.label, n: v.models })
                    : t('models.pricing.vendor_failed', { label: v.label, reason: v.reason ?? '' })}
                </li>
              ))}
            </ul>
          )}
        </section>

        {usage.data === undefined || usage.data.rows.length === 0 ? null : (
          <section className="flex flex-col gap-2">
            <h4 className="text-xs font-medium text-ws-muted-fg">{t('models.usage')}</h4>
            <table className="w-full text-xs" data-testid="model-usage">
              <thead className="text-muted-foreground">
                <tr className="border-b border-ws-line">
                  <th className="py-1 text-left font-normal">{t('models.usage.purpose')}</th>
                  <th className="py-1 text-right font-normal">{t('models.usage.calls')}</th>
                  <th className="py-1 text-right font-normal">{t('models.usage.tokens')}</th>
                  <th className="py-1 text-right font-normal">{t('models.usage.cost')}</th>
                </tr>
              </thead>
              <tbody>
                {usage.data.rows.map((row) => (
                  <tr key={row.purpose} className="border-b border-ws-line last:border-0">
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
        )}

        {settings === undefined ? null : (
          <BudgetSection
            settings={settings}
            busy={saveDefaults.isPending}
            onChange={(input) => {
              saveDefaults.mutate(input)
            }}
          />
        )}
      </Fold>
    </div>
  )
}

/** 一块：标题（+ 问号 + 个数）在上，内容在下。 */
function Block({
  title,
  hint,
  count,
  testId,
  children,
}: {
  title: string
  hint?: string
  count?: number
  testId: string
  children: ReactNode
}): ReactNode {
  return (
    <section className="flex flex-col gap-3" data-testid={testId}>
      <h3 className="flex items-center gap-1.5 text-[13px] font-semibold text-ws-ink">
        {title}
        {count === undefined || count === 0 ? null : (
          <span className="ws-num rounded-full bg-ws-surface px-1.5 text-ws-tiny font-medium text-ws-muted-fg">
            {count}
          </span>
        )}
        {hint === undefined ? null : <Hint text={hint} />}
      </h3>
      {children}
    </section>
  )
}

/**
 * 折起来的一块（原生 `<details>`：键盘能开、读屏认得；收着时内容也在 DOM 里，搜索与测试照找）。
 * 标题是一整行可点的按钮样子：hover 有底色、右边一个会转的箭头。
 */
function Fold({
  title,
  hint,
  testId,
  children,
}: {
  title: string
  hint?: string
  testId: string
  children: ReactNode
}): ReactNode {
  return (
    <details
      className="group rounded-xl border border-ws-line bg-ws-card [&[open]>summary]:border-b [&[open]>summary]:border-ws-line"
      data-testid={testId}
    >
      <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-xl px-4 py-3 text-[13px] font-semibold text-ws-ink outline-none hover:bg-ws-surface/60 focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
        {title}
        {hint === undefined ? null : <Hint text={hint} />}
        <ChevronDown
          aria-hidden
          className="ml-auto size-4 text-ws-muted-fg transition-transform group-open:rotate-180"
        />
      </summary>
      <div className="flex flex-col gap-5 px-4 py-4">{children}</div>
    </details>
  )
}

/** 「正在用」里的一行：图标 + 名字 +（默认）+ 状态 + 动作；下面跟这一家自己的那一块。 */
function SourceShell({
  icon,
  title,
  badge,
  meta,
  status,
  actions,
  children,
  testId = 'model-row',
  rowId,
}: {
  icon: ReactNode
  title: ReactNode
  badge?: string | undefined
  meta?: ReactNode
  status?: ReactNode
  actions?: ReactNode
  children?: ReactNode
  testId?: string
  rowId?: string
}): ReactNode {
  return (
    <li
      className="flex flex-col gap-2.5 px-4 py-3"
      data-testid={testId}
      {...(rowId === undefined ? {} : { 'data-id': rowId })}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="flex size-5 shrink-0 items-center justify-center">{icon}</span>
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="truncate text-sm font-medium text-ws-ink">{title}</span>
          {badge === undefined ? null : (
            <span
              className="rounded-full border border-ws-brand/40 px-1.5 text-xs leading-4 font-medium text-ws-brand-ink"
              data-testid="model-default-badge"
            >
              {badge}
            </span>
          )}
          {meta}
          {status}
        </div>
        {actions === undefined ? null : (
          <div className="flex shrink-0 items-center gap-0.5">{actions}</div>
        )}
      </div>
      {children === undefined || children === null ? null : <div className="pl-8">{children}</div>}
    </li>
  )
}

/**
 * 已配的一条 API key / 工坊积分来源（WP214 → WP426）：图标 + 名字 + 模型短标签 + 一枚状态标签 + 测试 / 改 / 删。
 *
 * - 地址、完整模型 id 进模型标签的 tooltip，不在卡上常显；
 * - 状态是一句人话（「能用 · 能看图」），三步与上次测 · 耗时在 tooltip；
 * - 「通了：…」那一行只在**上次测试（服务端时间）两分钟内**以小字出现；没通的原因常显一句人话。
 */
function ProviderRow({
  provider,
  isDefault,
  result,
  testing,
  busy,
  onTest,
  onEdit,
  onRemove,
  body,
  form,
}: {
  provider: ModelProviderView
  isDefault: boolean
  result: ModelTestResult | undefined
  testing: boolean
  busy: boolean
  onTest: () => void
  onEdit: () => void
  onRemove: () => void
  body: ReactNode
  form: ReactNode
}): React.ReactNode {
  const { t } = useApp()
  // Fable 09-30：「刚测完两分钟」按服务端的上次测试时间算——刷新后仍在两分钟内的照样显示
  const fresh = useFresh(testedMs(result))
  const cloud = provider.kind === 'agentsws_cloud'
  return (
    <SourceShell
      rowId={provider.id}
      icon={
        cloud ? (
          <BrandMark size={18} playOnHover />
        ) : (
          <BrandIcon provider={provider.kind} size={18} className="shrink-0" />
        )
      }
      title={provider.label}
      badge={isDefault ? t('models.default_badge') : undefined}
      meta={
        <>
          <InfoTip
            text={provider.base_url}
            testId="model-row-model"
            className="shrink-0 rounded-md bg-ws-surface px-1.5 py-px font-mono text-xs text-ws-muted-fg"
          >
            {provider.model}
          </InfoTip>
          {provider.from_env === true ? (
            <span
              className="shrink-0 rounded-md bg-ws-surface px-1.5 py-px text-xs text-ws-muted-fg"
              data-slot="badge"
              data-testid="model-from-env"
            >
              {t('models.from_env')}
            </span>
          ) : null}
          {/* WP274：只用来生图的那一条（在「生图」那一块加的）：不挂文字模型、不在这里测 */}
          {provider.image_only === true ? (
            <span
              className="shrink-0 rounded-md bg-ws-surface px-1.5 py-px text-xs text-ws-muted-fg"
              data-slot="badge"
              data-testid="model-image-only"
              title={t('models.image.no_test')}
            >
              {t('models.image.image_only')}
            </span>
          ) : null}
        </>
      }
      status={
        provider.image_only === true ? null : <ModelStatusIcons result={result} pending={testing} />
      }
      actions={
        <>
          {provider.image_only === true ? null : (
            <Button size="xs" variant="ghost" disabled={busy} onClick={onTest}>
              {t('models.test')}
            </Button>
          )}
          {/* 工坊积分那一条没什么可改的（启用 / 停用在它自己那一块） */}
          {cloud ? null : (
            <Button size="xs" variant="ghost" onClick={onEdit}>
              {t('models.edit')}
            </Button>
          )}
          {provider.from_env === true || cloud ? null : (
            <Button
              size="icon-xs"
              variant="ghost"
              disabled={busy}
              onClick={onRemove}
              aria-label={t('models.remove')}
              title={t('models.remove')}
              className="text-ws-muted-fg hover:text-destructive"
            >
              <Trash2 aria-hidden />
            </Button>
          )}
        </>
      }
    >
      {provider.active &&
      body === null &&
      form === null &&
      provider.quota_exceeded === undefined &&
      (result === undefined || testing || (result.ok && !fresh)) ? null : (
        <div className="flex flex-col gap-2">
          {provider.active ? null : (
            <p className="text-xs text-destructive" data-testid="model-inactive">
              {provider.inactive_reason ?? t('models.inactive')}
            </p>
          )}
          {/* 没通 → 常显一句人话（错误必须一眼可见）；通了 → 只在刚点完测试的两分钟内出 */}
          {result === undefined || testing || (result.ok && !fresh) ? null : (
            <p
              className={
                result.ok
                  ? 'flex items-center gap-1 text-xs text-ws-good'
                  : 'flex items-center gap-1 text-xs text-destructive'
              }
              data-slot="status"
              data-testid="model-test-result"
              data-ok={result.ok ? 'true' : 'false'}
            >
              {result.ok ? (
                <CheckCircle2 className="size-3 shrink-0" aria-hidden />
              ) : (
                <XCircle className="size-3 shrink-0" aria-hidden />
              )}
              <span>
                {result.detail ?? (result.ok ? t('models.test.ok') : t('models.test.failed'))}
                {!fresh || result.model === undefined ? '' : ` · ${result.model}`}
                {!fresh || result.duration_ms === undefined ? '' : ` · ${result.duration_ms}ms`}
              </span>
            </p>
          )}
          {/* WP151：DeepSeek 余额不足——一行醒目提示 +「去充值」 */}
          {provider.quota_exceeded === undefined ? null : (
            <QuotaNotice
              account={isDeepSeekAccountKind(provider.kind)}
              topUpUrl={provider.quota_exceeded.top_up_url}
            />
          )}
          {body}
          {form}
        </div>
      )}
    </SourceShell>
  )
}

/**
 * WP425：AI 来源的那个开关——「自己的用不了时用工坊积分接着做」（登录了工坊账号默认开）。
 * 主用 / 备用是谁，上面「正在用」那张表已经写着了，这里只剩开关；长说明进问号。
 */
function AiSourceRow({
  view,
  busy,
  onToggle,
  onReorder,
}: {
  view: ModelAiSourceView
  busy: boolean
  onToggle: (on: boolean) => void
  /** WP430：拖动排序之后的新顺序。 */
  onReorder: (ids: string[]) => void
}): React.ReactNode {
  const { t } = useApp()
  return (
    <>
      {/* WP430（决策 1288）：自己配的不止一个时，按这里的顺序接（可拖动）；只有一个就不用排 */}
      {view.own.length < 2 ? null : (
        <div className="flex items-start justify-between gap-3 px-4 py-3">
          <span className="text-sm text-ws-ink">{t('models.ai_source.order')}</span>
          <div className="min-w-0 max-w-64 flex-1">
            <AiSourceOrder own={view.own} busy={busy} onReorder={onReorder} />
          </div>
        </div>
      )}
      <div
        className="flex items-center justify-between gap-3 px-4 py-3"
        data-testid="model-ai-source"
      >
        <div className="min-w-0">
          <p className="flex items-center gap-1 text-sm text-ws-ink">
            {t('models.fallback')}
            <Hint text={t('models.ai_source.hint')} />
          </p>
          <p className="mt-0.5 text-[12px] text-ws-muted-fg" data-testid="model-ai-source-backup">
            {view.backup.available ? view.backup.label : t('models.ai_source.backup_off')}
          </p>
        </div>
        <Switch
          checked={view.fallback_to_cloud}
          disabled={busy || !view.backup.available}
          aria-label={t('models.ai_source.switch')}
          data-testid="model-ai-source-switch"
          onCheckedChange={onToggle}
        />
      </div>
    </>
  )
}

const SELECT =
  'h-8 max-w-64 min-w-0 truncate rounded-lg border border-ws-line bg-background px-2 text-xs text-ws-ink outline-none hover:border-ws-muted-fg/50 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60'

/** 默认模型 + WP425 的备用开关 +（折起来的）按用途分别选。 */
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
  // WP426：与输入框 AI 钮同一口径——实验型号不列、别名与带版本号的同一个只留一个（选着的那个永远在）
  const keep = new Set(
    [settings.default, ...Object.values(settings.by_purpose)].filter(
      (x): x is string => x !== undefined && x !== '',
    ),
  )
  const choices = compactChoices(settings.choices, keep)
  return (
    <div className="ws-group divide-y divide-ws-line" data-testid="model-defaults">
      <label className="flex items-center justify-between gap-3 px-4 py-3">
        <span className="flex items-center gap-1 text-sm text-ws-ink">
          {t('models.default_model')}
          <Hint text={t('models.default_model.hint')} />
        </span>
        <select
          className={SELECT}
          value={settings.default}
          disabled={busy}
          data-testid="model-default-select"
          onChange={(event) => {
            onChange({ default: event.currentTarget.value })
          }}
        >
          {choices.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
      </label>
      {settings.ai_source === undefined ? null : (
        <AiSourceRow
          view={settings.ai_source}
          busy={busy}
          onToggle={(on) => {
            onChange({ fallback_to_cloud: on })
          }}
          onReorder={(ids) => {
            onChange({ source_order: ids })
          }}
        />
      )}
      <details className="group">
        <summary className="flex cursor-pointer list-none items-center gap-1.5 px-4 py-3 text-sm text-ws-ink outline-none hover:bg-ws-surface/60 focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
          {t('models.by_purpose')}
          <ChevronDown
            aria-hidden
            className="ml-auto size-4 text-ws-muted-fg transition-transform group-open:rotate-180"
          />
        </summary>
        <div className="flex flex-col gap-2 px-4 pb-3">
          {PURPOSES.map((purpose) => (
            <label key={purpose} className="flex items-center justify-between gap-3 text-xs">
              <span className="text-ws-muted-fg">{t(`models.purpose.${purpose}`)}</span>
              <select
                className={SELECT}
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
                {choices.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>
      </details>
    </div>
  )
}

/** WP43 ③：预算上限（规则说明进问号）——收在「价目与用量」里。 */
function BudgetSection({
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
    <section className="flex flex-col gap-2" data-testid="model-budget">
      <h4 className="flex items-center gap-1 text-xs font-medium text-ws-muted-fg">
        {t('models.budget')}
        <Hint text={t('models.budget.hint')} />
      </h4>
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
    <label className="flex flex-col gap-1 text-xs">
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
  // WP424：还没接通的订阅登录（Claude 订阅）留了位置、不显示
  for (const tpl of templates.filter(subscriptionTemplateShown)) {
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

/**
 * WP152：一张卡打开时默认选哪个方案。
 *
 * 默认第一个（`plan_order` 最小；DeepSeek 那张是「官方账户登录」）；但用户**已经配过**其中某一种的，
 * 打开时显示他已有的那种（按接口地址认，与 {@link templateSlug} 同一条判据）。几种都配了就取排前面的。
 */
export function defaultPlanIndex(
  plans: readonly ModelProviderTemplate[],
  configured: readonly Pick<ModelProviderView, 'kind' | 'base_url'>[],
  /**
   * 09-26（WP152 报告「需要 Luoye 定」第 1、2 条，Fable 定）：账号登录那一种的现状。
   * - 登录**过期被自动摘掉**（`session_expired` 在）：仍默认显示账户登录——「登录过期了，点一下重新登录」要一打开就看得到；
   * - 这台部署**用不了**账号登录（公司档 / 托管档，`available: false`）：没配过别的时默认显示 API 那种，不让人先看到一句"用不了"。
   */
  account?: { available: boolean; session_expired?: unknown },
): number {
  const accountAt = plans.findIndex((p) => isAccountTemplate(p))
  if (accountAt >= 0 && account?.session_expired !== undefined && account.available)
    return accountAt
  const have = new Set(configured.map((p) => templateSlug(p.kind, p.base_url)))
  const i = plans.findIndex((p) => have.has(templateSlug(p.kind, p.default_base_url)))
  if (i >= 0) return i
  if (accountAt === 0 && account?.available === false) {
    const other = plans.findIndex((p) => !isAccountTemplate(p))
    if (other >= 0) return other
  }
  return 0
}

/** WP157：挪到 `lib/help.ts`（连接卡也用），这里留一个出口不动调用方。 */
export { firstSentence }

/**
 * 「加一个」里的一行（WP426）：图标 + 名字 + 一句话 +（看教程）+ 动作。
 *
 * - 填 key 那一组：右边一个「填 API key」，点了在这一行下面展开原生表单（同一时间全页只开一张）；
 *   同一家有几个方案（百炼）时，名字下面一排小胶囊先选方案。
 * - 登录那一组：下面直接是这一家的登录件（DeepSeek 账号 / ChatGPT 订阅 / 工坊积分）——
 *   那几个件本身就是一两个按钮，不用再点开一层。
 */
function AddRow({
  item,
  busy,
  configured,
  takenIds,
  assignment,
  pricing,
  openPlan,
  onOpenPlan,
  onDiscover,
  onSubmit,
}: {
  item: AddItem
  busy: boolean
  /** WP152：已配的那几条（打开时默认显示他已有的那种方案）。 */
  configured: readonly ModelProviderView[]
  takenIds: string[]
  assignment?: string
  pricing?: ModelPricingView
  openPlan: string | null
  onOpenPlan: (slug: string | null) => void
  onDiscover: React.ComponentProps<typeof ModelForm>['onDiscover']
  onSubmit: (values: ModelFormValues, kind: ModelProviderKind) => void
}): React.ReactNode {
  const { t } = useApp()
  const [planIndex, setPlanIndex] = useState(() => defaultPlanIndex(item.plans, configured))
  const plan = item.plans[planIndex] ?? item.plans[0]
  if (plan === undefined) return null
  const slug = templateSlug(plan.kind, plan.default_base_url)
  const tutorial = HELP_BY_VENDOR[item.vendor]
  /*
   * 名字与那一句：认得的厂商用词条（登录 / 填 key 各一套）；没有就退回卡名与服务端介绍的第一句
   * （第三方加的模板）。
   */
  const nameKey = `models.add.${item.group}.${item.vendor}`
  const lineKey = `${nameKey}.line`
  const vendorLine = `models.vendor.${item.vendor}`
  const name = t(nameKey) === nameKey ? item.label : t(nameKey)
  const line =
    t(lineKey) !== lineKey
      ? t(lineKey)
      : t(vendorLine) !== vendorLine
        ? t(vendorLine)
        : firstSentence(item.summary)
  const open = openPlan === slug
  const cloud = plan.kind === 'agentsws_cloud' || plan.auth === 'cloud'
  const keyGroup = item.group === 'key'

  return (
    <li
      className="flex flex-col gap-2.5 px-4 py-3"
      data-testid="model-template"
      data-group={item.group}
      data-kind={plan.kind}
      data-vendor={item.vendor}
      data-template={slug}
    >
      <div className="flex items-center gap-3">
        <span className="flex size-5 shrink-0 items-center justify-center">
          {/* WP188：积分那一行是我们自己——用品牌标记，不是字母圆圈 */}
          {cloud ? (
            <BrandMark size={18} playOnHover />
          ) : (
            <BrandIcon provider={item.vendor} size={18} />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1 text-sm font-medium text-ws-ink">
            <span className="truncate">{name}</span>
          </p>
          <p className="truncate text-xs text-ws-muted-fg" data-testid="model-template-line">
            {line}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          {/*
            WP156：服务端那段整句介绍进问号。WP456-T6（§3.8 P2）：每家只留**一个**问号——悬停是介绍，
            点开是教程（原来是「ⓘ +『看教程』」两颗）。
          */}
          {tutorial !== undefined || plan.steps.length + plan.links.length > 0 ? (
            <TutorialHint
              text={item.summary}
              {...(tutorial !== undefined
                ? { slug: tutorial }
                : { guide: { title: item.label, markdown: templateGuide(plan) } })}
            />
          ) : item.summary === '' ? null : (
            <Hint text={item.summary} testId="model-template-summary" />
          )}
          {keyGroup ? (
            <Button
              size="sm"
              variant={open ? 'ghost' : 'outline'}
              aria-expanded={open}
              data-testid="model-add-open"
              onClick={() => onOpenPlan(open ? null : slug)}
            >
              {open ? (
                t('models.add.collapse')
              ) : (
                <>
                  <Plus aria-hidden />
                  {t('models.add.button')}
                </>
              )}
            </Button>
          ) : null}
        </div>
      </div>

      {item.plans.length < 2 ? null : (
        <fieldset className="flex flex-wrap gap-1.5 pl-8" data-testid="model-plans">
          <legend className="sr-only">{t('models.plan')}</legend>
          {item.plans.map((p, i) => (
            <label
              key={`${p.kind}:${p.plan_label ?? p.label}`}
              className={cn(
                'inline-flex cursor-pointer items-center rounded-full border px-2.5 py-0.5 text-xs transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring',
                i === planIndex
                  ? 'border-ws-brand/60 bg-ws-brand-soft/40 text-ws-brand-ink'
                  : 'border-ws-line text-ws-muted-fg hover:border-ws-muted-fg/50 hover:text-ws-ink',
              )}
              data-testid="model-plan"
              data-selected={i === planIndex}
            >
              <input
                type="radio"
                className="sr-only"
                name={`plan-${item.id}`}
                checked={i === planIndex}
                onChange={() => {
                  setPlanIndex(i)
                  onOpenPlan(null)
                }}
              />
              {p.plan_label ?? p.label}
              {/* 选中那个方案和别的有什么不同，进问号（在胶囊里，卡窄时不单独折行） */}
              {i === planIndex && plan.summary !== '' ? (
                <Hint text={plan.summary} testId="model-plan-summary" className="ml-1" />
              ) : null}
            </label>
          ))}
        </fieldset>
      )}

      {cloud ? (
        /* WP188：「Agents 工坊积分」不填 key——先关联账号 / 启用（与账号与积分同一个件） */
        <div className="pl-8" data-testid="model-plan-cloud">
          <CloudPlanActions {...(assignment === undefined ? {} : { assignment })} />
        </div>
      ) : isAccountTemplate(plan) ? (
        /* WP152：DeepSeek 账号登录——没有表单，就是那一个登录件 */
        <div className="pl-8" data-testid="model-plan-account">
          <DeepSeekAccountLogin {...(assignment === undefined ? {} : { assignment })} />
        </div>
      ) : plan.auth === 'subscription' && plan.subscription_provider !== undefined ? (
        <div className="pl-8">
          <SubscriptionPlan
            provider={plan.subscription_provider}
            {...(assignment === undefined ? {} : { assignment })}
          />
        </div>
      ) : open ? (
        <div className="pl-8">
          <ModelForm
            template={plan}
            busy={busy}
            onDiscover={onDiscover}
            takenIds={takenIds}
            {...(pricing === undefined ? {} : { pricing })}
            onCancel={() => onOpenPlan(null)}
            onSubmit={(values) => onSubmit(values, plan.kind)}
          />
        </div>
      ) : null}
    </li>
  )
}
