/**
 * 填模型 API key 的**原生表单**（13 §4.3，与连接页的 `SecureForm` 同一条纪律）。
 *
 * 1. 原生 `<form>` + `FormData` 收集，key 不进 React state、不进任何全局变量；
 * 2. key 字段 `type="password"` + `autoComplete="off"` + `data-1p-ignore`；
 * 3. 提交只打 `PUT /v1/models/providers/:id` 这一条路，提交完立刻 `form.reset()`；
 * 4. 全程没有一次 `console.*`。
 */
import { ShieldCheck } from 'lucide-react'
import { type FormEvent, useId, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { ModelProviderTemplate, ModelProviderView } from '@/lib/api'
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
}

export function ModelForm({
  template,
  existing,
  busy,
  onCancel,
  onSubmit,
}: {
  template: ModelProviderTemplate
  /** 改一条已有的：id 锁住，key 留空就是"别动已经存着的那一把"。 */
  existing?: ModelProviderView
  busy: boolean
  onCancel: () => void
  /** 唯一出口：值只在这一次调用里存在。 */
  onSubmit: (values: ModelFormValues) => void
}): React.ReactNode {
  const { t } = useApp()
  const prefix = useId()
  const formRef = useRef<HTMLFormElement>(null)
  const [region, setRegion] = useState<'cn' | 'global'>(existing?.region ?? template.region)

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
    const id = existing?.id ?? text('id')
    const model = text('model')
    if (id === '' || model === '') {
      form.reportValidity()
      return
    }
    const key = text('api_key')
    const embedding = text('embedding_model')
    const price_in = num('price_in')
    const price_out = num('price_out')
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
    })
    // key 发出去之后连 DOM 里也不留
    form.reset()
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
              }}
            >
              {p.label}
            </Button>
          ))}
        </div>
      )}

      {existing === undefined ? (
        <Field id={`${prefix}-id`} label={t('models.field.id')} hint={t('models.field.id.hint')}>
          <Input
            id={`${prefix}-id`}
            name="id"
            required
            pattern="[a-z0-9][a-z0-9_-]*"
            defaultValue={template.kind === 'deepseek' ? 'deepseek' : ''}
            autoComplete="off"
            spellCheck={false}
          />
        </Field>
      ) : null}

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
        />
      </Field>

      <Field id={`${prefix}-model`} label={t('models.field.model')}>
        <Input
          id={`${prefix}-model`}
          name="model"
          required
          defaultValue={existing?.model ?? template.default_model}
          autoComplete="off"
          spellCheck={false}
        />
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

      <div className="grid grid-cols-2 gap-2">
        <Field id={`${prefix}-price_in`} label={t('models.field.price_in')}>
          <Input
            id={`${prefix}-price_in`}
            name="price_in"
            type="number"
            step="0.01"
            min="0"
            defaultValue={existing?.price_in ?? ''}
            autoComplete="off"
          />
        </Field>
        <Field id={`${prefix}-price_out`} label={t('models.field.price_out')}>
          <Input
            id={`${prefix}-price_out`}
            name="price_out"
            type="number"
            step="0.01"
            min="0"
            defaultValue={existing?.price_out ?? ''}
            autoComplete="off"
          />
        </Field>
      </div>
      <p className="text-[11px] text-muted-foreground">{t('models.field.price.hint')}</p>

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
  hint?: string
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
