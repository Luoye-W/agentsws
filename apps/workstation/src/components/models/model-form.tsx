/**
 * 填模型 API key 的**原生表单**（13 §4.3，与连接页的 `SecureForm` 同一条纪律）。
 *
 * 1. 原生 `<form>` + `FormData` 收集，key 不进 React state、不进任何全局变量；
 * 2. key 字段 `type="password"` + `autoComplete="off"` + `data-1p-ignore`；
 * 3. 提交只打 `PUT /v1/models/providers/:id` 这一条路，提交完立刻 `form.reset()`；
 * 4. 全程没有一次 `console.*`。
 */
import { ChevronDown, Loader2, RefreshCw, ShieldCheck } from 'lucide-react'
import { type FormEvent, useId, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type {
  ModelListing,
  ModelPricingView,
  ModelProviderTemplate,
  ModelProviderView,
} from '@/lib/api'
import { findCatalogPrice } from '@/lib/api'
import { useApp } from '@/lib/app-context'

export interface ModelFormValues {
  id: string
  label: string
  base_url: string
  model: string
  embedding_model?: string
  region: 'cn' | 'global'
  api_key?: string
  price_in?: number
  price_out?: number
  price_cached?: number
  /** WP42：这三个价是照价目表填的还是用户自己改的。 */
  price_source?: 'catalog' | 'manual'
}

export function ModelForm({
  template,
  existing,
  busy,
  onCancel,
  onSubmit,
  onDiscover,
  pricing,
  takenIds,
}: {
  template: ModelProviderTemplate
  /** 改一条已有的：id 锁住，key 留空就是"别动已经存着的那一把"。 */
  existing?: ModelProviderView
  busy: boolean
  onCancel: () => void
  /** 唯一出口：值只在这一次调用里存在。 */
  onSubmit: (values: ModelFormValues) => void
  /**
   * WP42「拉取模型列表」。和提交同一条纪律：地址与 key 从 FormData 里现取，
   * 组装一次交出去，函数返回后表单这边不再引用。
   */
  onDiscover: (probe: {
    id: string
    base_url: string
    api_key?: string
    region: 'cn' | 'global'
  }) => Promise<ModelListing>
  /** WP42 内置价目表：选定模型后照它自动填价。 */
  pricing?: ModelPricingView
  /** 已经用掉的编号（自动生成时避开它们）。 */
  takenIds?: string[]
}): React.ReactNode {
  const { t } = useApp()
  const prefix = useId()
  const formRef = useRef<HTMLFormElement>(null)
  const [region, setRegion] = useState<'cn' | 'global'>(existing?.region ?? template.region)
  // 拉回来的模型清单。**只有模型名**——不含地址、不含 key
  const [listing, setListing] = useState<ModelListing | undefined>(existing?.last_listing)
  const [models, setModels] = useState<string[]>(existing?.models ?? [])
  const [listOpen, setListOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const [pulling, setPulling] = useState(false)
  /**
   * 价是"照价目表填的"还是"用户自己改的"。
   *
   * 一旦用户在价格框里敲过一个字，这一条就变成 `manual`——之后换模型不再自动改它，
   * 每周那次官网刷新也一条都不动它。改过的数字不该被任何自动的东西悄悄覆盖。
   */
  const [priceManual, setPriceManual] = useState(existing?.price_source === 'manual')
  /**
   * 「编号」（WP42 交付 4）。
   *
   * 这个字段对非技术用户太技术了——它只是这条配置在文件里的键名，用户既不该关心
   * 也没法凭直觉起一个。所以**按接口地址自动生成**（`deepseek` / `kimi` / `ollama`…），
   * 折进「高级」里；真要改的人打开一栏就能改。
   */
  const [autoId, setAutoId] = useState(() =>
    suggestProviderId(template.default_base_url, takenIds ?? []),
  )
  /** 现在这个模型在价目表里查到的那条（查不到就是 undefined，价格框留空让人自己填）。 */
  const [quote, setQuote] = useState(() =>
    findCatalogPrice(
      pricing,
      existing?.base_url ?? template.default_base_url,
      existing?.model ?? template.default_model,
    ),
  )

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    const form = event.currentTarget
    const data = new FormData(form)
    const text = (name: string): string => {
      const raw = data.get(name)
      return typeof raw === 'string' ? raw.trim() : ''
    }
    const num = (name: string): number | undefined => {
      const raw = text(name)
      if (raw === '') return undefined
      const parsed = Number(raw)
      return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined
    }
    const id = existing?.id ?? (text('id') === '' ? autoId : text('id'))
    const model = text('model')
    if (id === '' || model === '') {
      form.reportValidity()
      return
    }
    const key = text('api_key')
    const embedding = text('embedding_model')
    const price_in = num('price_in')
    const price_out = num('price_out')
    const price_cached = num('price_cached')
    onSubmit({
      id,
      label: text('label') === '' ? template.label : text('label'),
      base_url: text('base_url') === '' ? template.default_base_url : text('base_url'),
      model,
      region,
      ...(embedding === '' ? {} : { embedding_model: embedding }),
      ...(key === '' ? {} : { api_key: key }),
      ...(price_in === undefined ? {} : { price_in }),
      ...(price_out === undefined ? {} : { price_out }),
      ...(price_cached === undefined ? {} : { price_cached }),
      price_source: priceManual ? 'manual' : 'catalog',
    })
    // key 发出去之后连 DOM 里也不留
    form.reset()
  }

  /**
   * 换了模型名（或地址）之后，把价目表里那条价填进价格框。
   *
   * 直接写 DOM 的 `value`，而不是把价搬进 React state——这是个原生表单，
   * 值的真源就是那三个 input。用户改过（`priceManual`）就一个字都不碰。
   */
  const applyQuote = (base_url: string, model: string): void => {
    const hit = findCatalogPrice(pricing, base_url, model)
    setQuote(hit)
    if (priceManual) return
    const form = formRef.current
    if (form === null) return
    const set = (name: string, value: number | undefined): void => {
      const el = form.elements.namedItem(name)
      if (el instanceof HTMLInputElement) el.value = value === undefined ? '' : String(value)
    }
    set('price_in', hit?.in)
    set('price_out', hit?.out)
    set('price_cached', hit?.cached)
  }

  /**
   * 「拉取模型列表」。地址与 key 从**当前 DOM** 里现取——用户可能刚改完地址还没保存，
   * 拉的就该是新地址上的那一份。key 取出来只往 `onDiscover` 传一次，不进 state。
   */
  const pull = async (): Promise<void> => {
    const form = formRef.current
    if (form === null) return
    const data = new FormData(form)
    const text = (name: string): string => {
      const raw = data.get(name)
      return typeof raw === 'string' ? raw.trim() : ''
    }
    const id = existing?.id ?? (text('id') === '' ? autoId : text('id'))
    const base_url = text('base_url') === '' ? template.default_base_url : text('base_url')
    const key = text('api_key')
    setPulling(true)
    try {
      const result = await onDiscover({
        id: id === '' ? template.kind : id,
        base_url,
        region,
        ...(key === '' ? {} : { api_key: key }),
      })
      setListing(result)
      if (result.ok) {
        setModels(result.models)
        // 模板默认名不在接口清单里就换成第一个——用户不该看到一个接口不认的名字
        const el = document.getElementById(`${prefix}-model`) as HTMLInputElement | null
        if (el !== null && result.models.length > 0 && !result.models.includes(el.value)) {
          el.value = result.models[0] as string
        }
      }
    } catch (e) {
      setListing({
        ok: false,
        models: [],
        reason: e instanceof Error ? e.message : String(e),
        checked_at: '',
      })
    } finally {
      setPulling(false)
    }
  }

  const presets = template.presets ?? []

  return (
    <form
      ref={formRef}
      data-testid="model-form"
      data-kind={template.kind}
      className="mt-2 flex flex-col gap-3 rounded-lg border bg-muted/30 p-3"
      onSubmit={submit}
      autoComplete="off"
    >
      <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
        <ShieldCheck className="mt-px size-3.5 shrink-0" aria-hidden />
        <span>{t('models.never_ai')}</span>
      </p>

      {presets.length === 0 || existing !== undefined ? null : (
        <div className="flex flex-wrap gap-1.5" data-testid="model-presets">
          {presets.map((p) => (
            <Button
              key={p.id}
              type="button"
              size="xs"
              variant="outline"
              onClick={() => {
                const form = formRef.current
                if (form === null) return
                const set = (name: string, value: string): void => {
                  const el = form.elements.namedItem(name)
                  if (el instanceof HTMLInputElement) el.value = value
                }
                set('id', p.id)
                set('label', p.label)
                set('base_url', p.base_url)
                set('model', p.model)
                setRegion(p.region)
                setAutoId(suggestProviderId(p.base_url, takenIds ?? []))
                applyQuote(p.base_url, p.model)
              }}
            >
              {p.label}
            </Button>
          ))}
        </div>
      )}

      <Field id={`${prefix}-label`} label={t('models.field.label')}>
        <Input
          id={`${prefix}-label`}
          name="label"
          defaultValue={existing?.label ?? template.label}
          autoComplete="off"
        />
      </Field>

      <Field
        id={`${prefix}-base_url`}
        label={t('models.field.base_url')}
        hint={t('models.field.base_url.hint')}
      >
        <Input
          id={`${prefix}-base_url`}
          name="base_url"
          defaultValue={existing?.base_url ?? template.default_base_url}
          autoComplete="off"
          spellCheck={false}
          data-testid="model-base-url"
          onInput={(event) => {
            const url = event.currentTarget.value
            // 换了地址就等于换了一家：编号跟着改，价也重新查
            if (existing === undefined) setAutoId(suggestProviderId(url, takenIds ?? []))
            const form = formRef.current
            const model = form?.elements.namedItem('model')
            if (model instanceof HTMLInputElement) applyQuote(url, model.value)
          }}
        />
      </Field>

      {/*
        模型名：拉过清单就是一个**点开就列全部、打字能筛、也能手填**的组合框。
        不用原生 datalist（Chrome / Electron 里要先敲字才弹，不是下拉）；也不用 Radix 浮层
        （jsdom 里点不开）。一个 input + 一个内联 listbox，input 仍是 FormData 的来源。
      */}
      <Field
        id={`${prefix}-model`}
        label={t('models.field.model')}
        hint={models.length > 0 ? t('models.field.model.hint', { n: models.length }) : undefined}
      >
        <div className="flex items-center gap-1.5">
          <div className="relative flex-1">
            <Input
              id={`${prefix}-model`}
              name="model"
              required
              defaultValue={existing?.model ?? template.default_model}
              autoComplete="off"
              spellCheck={false}
              data-testid="model-name-input"
              data-options={models.length}
              role={models.length === 0 ? undefined : 'combobox'}
              aria-expanded={models.length === 0 ? undefined : listOpen}
              className={models.length === 0 ? undefined : 'pr-9'}
              onFocus={() => {
                if (models.length > 0) setListOpen(true)
              }}
              onBlur={() => {
                // 让 listbox 里的 mousedown 先落地再收
                window.setTimeout(() => setListOpen(false), 120)
              }}
              onInput={(event) => {
                setFilter(event.currentTarget.value)
                if (models.length > 0) setListOpen(true)
                const form = formRef.current
                const base = form?.elements.namedItem('base_url')
                const url =
                  base instanceof HTMLInputElement && base.value.trim() !== ''
                    ? base.value.trim()
                    : template.default_base_url
                applyQuote(url, event.currentTarget.value)
              }}
            />
            {models.length === 0 ? null : (
              <button
                type="button"
                aria-label={t('models.field.model.open')}
                data-testid="model-dropdown-toggle"
                className="absolute inset-y-0 right-0 flex w-9 items-center justify-center text-muted-foreground hover:text-foreground"
                onMouseDown={(e) => {
                  e.preventDefault()
                  setFilter('')
                  setListOpen((v) => !v)
                }}
              >
                <ChevronDown className="size-4" aria-hidden />
              </button>
            )}
            {models.length === 0 || !listOpen ? null : (
              <div
                role="listbox"
                data-testid="model-list"
                className="absolute z-20 mt-1 max-h-64 w-full overflow-auto rounded-md border bg-popover p-1 text-sm shadow-md"
              >
                {models
                  .filter((m) => filter === '' || m.toLowerCase().includes(filter.toLowerCase()))
                  .map((m) => (
                    <div key={m}>
                      <button
                        type="button"
                        role="option"
                        aria-selected={false}
                        className="w-full rounded px-2 py-1.5 text-left hover:bg-accent"
                        onMouseDown={(e) => {
                          e.preventDefault()
                          const el = document.getElementById(`${prefix}-model`)
                          if (el instanceof HTMLInputElement) {
                            el.value = m
                            const form = formRef.current
                            const base = form?.elements.namedItem('base_url')
                            const url =
                              base instanceof HTMLInputElement && base.value.trim() !== ''
                                ? base.value.trim()
                                : template.default_base_url
                            applyQuote(url, m)
                          }
                          setFilter('')
                          setListOpen(false)
                        }}
                      >
                        {m}
                      </button>
                    </div>
                  ))}
              </div>
            )}
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={pulling || busy}
            onClick={() => {
              void pull()
            }}
            data-testid="model-discover"
          >
            {pulling ? <Loader2 className="animate-spin" aria-hidden /> : <RefreshCw aria-hidden />}
            {t('models.discover')}
          </Button>
        </div>
        {listing === undefined || listing.ok ? null : (
          <p
            className="text-[11px] text-amber-600 dark:text-amber-400"
            data-testid="model-discover-failed"
          >
            {t('models.discover.failed', { reason: listing.reason ?? '' })}
          </p>
        )}
      </Field>

      <Field
        id={`${prefix}-api_key`}
        label={t('models.field.api_key')}
        hint={
          existing?.has_key === true
            ? t('models.field.api_key.keep')
            : t('models.field.api_key.hint')
        }
      >
        <Input
          id={`${prefix}-api_key`}
          name="api_key"
          // key 永远是 password 输入框，浏览器不会记、不会自动填
          type="password"
          required={existing?.has_key !== true}
          autoComplete="off"
          spellCheck={false}
          data-secret="true"
          data-1p-ignore="true"
          placeholder={existing?.has_key === true ? '••••••••' : 'sk-…'}
        />
      </Field>

      <Field
        id={`${prefix}-embedding_model`}
        label={t('models.field.embedding')}
        hint={t('models.field.embedding.hint')}
      >
        <Input
          id={`${prefix}-embedding_model`}
          name="embedding_model"
          defaultValue={existing?.embedding_model ?? ''}
          autoComplete="off"
          spellCheck={false}
        />
      </Field>

      <fieldset className="flex flex-col gap-1">
        <legend className="text-xs font-medium">{t('models.field.region')}</legend>
        <div className="flex gap-3 text-xs">
          {(['cn', 'global'] as const).map((r) => (
            <label key={r} className="flex cursor-pointer items-center gap-1.5">
              <input
                type="radio"
                name="region"
                value={r}
                checked={region === r}
                onChange={() => {
                  setRegion(r)
                }}
              />
              {t(`models.region.${r}`)}
            </label>
          ))}
        </div>
        <p className="text-[11px] text-muted-foreground">{t('models.field.region.hint')}</p>
      </fieldset>

      {/*
        价：选定模型之后照内置价目表自动填，并写清楚"来源：官网 {日期}"。
        用户在框里敲一个字就变成"手动"——之后换模型不自动改它，每周那次官网
        刷新也不动它。
      */}
      <div className="grid grid-cols-3 gap-2" data-testid="model-prices">
        {(
          [
            ['price_in', t('models.field.price_in'), existing?.price_in],
            ['price_out', t('models.field.price_out'), existing?.price_out],
            ['price_cached', t('models.field.price_cached'), existing?.price_cached],
          ] as const
        ).map(([name, label, value]) => (
          <Field key={name} id={`${prefix}-${name}`} label={label}>
            <Input
              id={`${prefix}-${name}`}
              name={name}
              type="number"
              step="0.001"
              min="0"
              defaultValue={value ?? (priceManual ? '' : (quote?.[priceKeyOf(name)] ?? ''))}
              autoComplete="off"
              data-testid={`model-${name}`}
              onInput={() => {
                setPriceManual(true)
              }}
            />
          </Field>
        ))}
      </div>
      <p className="text-[11px] text-muted-foreground" data-testid="model-price-source">
        {priceManual
          ? t('models.price.manual')
          : quote === undefined
            ? t('models.field.price.hint')
            : t('models.price.from_catalog', { as_of: quote.as_of, currency: quote.currency })}
      </p>

      {/*
        「编号」只是这条配置在文件里的键名——非技术用户既不该关心也没法凭直觉起一个，
        所以按接口地址自动生成，折进这里。真要改的人打开一栏就能改。
      */}
      {existing === undefined ? (
        <details
          className="rounded-md border bg-background/60 px-2 py-1.5"
          data-testid="model-advanced"
        >
          <summary className="cursor-pointer text-xs text-muted-foreground">
            {t('models.advanced')}
          </summary>
          <div className="mt-2">
            <Field
              id={`${prefix}-id`}
              label={t('models.field.id')}
              hint={t('models.field.id.hint')}
            >
              <Input
                key={autoId}
                id={`${prefix}-id`}
                name="id"
                required
                pattern="[a-z0-9][a-z0-9_-]*"
                defaultValue={autoId}
                autoComplete="off"
                spellCheck={false}
                data-testid="model-id-input"
              />
            </Field>
          </div>
        </details>
      ) : null}

      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" disabled={busy}>
          {busy ? t('models.saving') : t('models.save')}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel} disabled={busy}>
          {t('connections.cancel')}
        </Button>
      </div>
    </form>
  )
}

function Field({
  id,
  label,
  hint,
  children,
}: {
  id: string
  label: string
  hint?: string | undefined
  children: React.ReactNode
}): React.ReactNode {
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id} className="text-xs">
        {label}
      </Label>
      {children}
      {hint === undefined ? null : <p className="text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  )
}

/** 三个价格框的 name → 价目表里那条价的字段名。 */
function priceKeyOf(name: 'price_in' | 'price_out' | 'price_cached'): 'in' | 'out' | 'cached' {
  return name === 'price_in' ? 'in' : name === 'price_out' ? 'out' : 'cached'
}

/** 主机名 → 一个短编号。认得出的几家写死，认不出的取主机名头一段。 */
const ID_BY_HOST: readonly (readonly [RegExp, string])[] = [
  [/(^|\.)deepseek\.com$/, 'deepseek'],
  [/(^|\.)openai\.com$/, 'openai'],
  [/(^|\.)(moonshot\.(cn|ai)|kimi\.com)$/, 'kimi'],
  [/(^|\.)aliyuncs\.com$/, 'qwen'],
  [/(^|\.)(bigmodel\.cn|z\.ai)$/, 'zhipu'],
  [/(^|\.)siliconflow\.(cn|com)$/, 'siliconflow'],
  [/(^|\.)anthropic\.com$/, 'anthropic'],
  [/(^|\.)openrouter\.ai$/, 'openrouter'],
  [/^(127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\])$/, 'ollama'],
]

/**
 * 按接口地址猜一个编号（WP42 交付 4）。
 *
 * 编号只要满足「小写字母数字下划线短横线、32 位以内、这台机器上没重」——
 * 认得出的几家给个好记的名字，认不出的取主机名头一段。重名就在后面加个序号。
 */
export function suggestProviderId(baseUrl: string, taken: readonly string[]): string {
  let host = ''
  try {
    const raw = baseUrl.trim()
    host = new URL(raw.includes('://') ? raw : `https://${raw}`).hostname.toLowerCase()
  } catch {
    host = ''
  }
  let base = ID_BY_HOST.find(([re]) => re.test(host))?.[1]
  if (base === undefined) {
    const parts = host.split('.').filter((p) => p !== '' && p !== 'api' && p !== 'www')
    base = (parts[0] ?? 'model').replace(/[^a-z0-9_-]/g, '').slice(0, 24)
  }
  if (base === '' || /^[^a-z0-9]/.test(base)) base = 'model'
  if (!taken.includes(base)) return base
  for (let n = 2; n < 100; n += 1) {
    const candidate = `${base}-${n}`
    if (!taken.includes(candidate)) return candidate
  }
  return base
}
