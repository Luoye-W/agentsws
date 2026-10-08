/**
 * 设置页「模型」的第二块：**生图**（WP127 交付 3，Luoye 09-23：生图单独设置一档）。
 *
 * WP274（决策 255）起它先回答一句话：**现在用谁**——按「单独指定的生图接口 > 文字模型同厂商且带生图 >
 * Agents 工坊积分」解析出来的那一条（服务端算，`ModelImageView.using`）：
 * 「你的 OpenAI 账号（GPT Image 2.5）」/「你的 Google 账号（Nano Banana 2.1）」/「Agents 工坊积分」。
 * 走自己的 key 标「不扣积分」，走云标单价。
 *
 * 下拉第一项是「自动」（就是上面那条规则）；也可以单独指定一条已配的接口，或者加一个**只用来生图**的
 * 自定义接口（OpenAI 兼容 images 形态）——加的时候用的就是文字模型那张原生表单（`ModelForm`，key 只走
 * 一次、进本机加密库），只是存成 `image_only`。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Image as ImageIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import { ModelForm, type ModelFormValues } from '@/components/models/model-form'
import { Button } from '@/components/ui/button'
import { Hint } from '@/components/ui/hint'
import type { ModelImageChoice, ModelImageView, ModelProviderTemplate } from '@/lib/api'
import {
  discoverModelProviderModels,
  getModelImage,
  listModelProviders,
  saveImageOnlyProvider,
  setModelImageRoute,
} from '@/lib/api'
import { useApp } from '@/lib/app-context'

/** 下拉里「加一个自定义生图接口」那一项的值（不会撞 provider id：id 只能小写字母数字）。 */
const CUSTOM = '__custom__'

/** 服务端存着的那一份（没单独指定 = 自动 = 空串）。老服务端没有 `override` 这一格，按有没有 provider_id 认。 */
function storedOf(d: ModelImageView | undefined): string {
  return d === undefined || d.override === false ? '' : (d.provider_id ?? '')
}

export function ImageModelSection({ assignment }: { assignment?: string }): React.ReactNode {
  const { t } = useApp()
  const client = useQueryClient()
  const view = useQuery({
    queryKey: ['model-image', assignment],
    queryFn: () => getModelImage(assignment),
    retry: false,
  })
  const providers = useQuery({
    queryKey: ['model-providers', assignment],
    queryFn: () => listModelProviders(assignment),
  })
  const [provider, setProvider] = useState('')
  const [model, setModel] = useState('')
  const [editModel, setEditModel] = useState('')
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 服务端那份变了（别处改了 / 刚加载完）就跟上
  useEffect(() => {
    if (view.data === undefined) return
    const stored = storedOf(view.data)
    setProvider(stored)
    setModel(stored === '' ? '' : (view.data.model ?? ''))
    setEditModel(stored === '' ? '' : (view.data.edit_model ?? ''))
  }, [view.data])

  const refresh = (): void => {
    void client.invalidateQueries({ queryKey: ['model-image'] })
    void client.invalidateQueries({ queryKey: ['model-providers'] })
  }

  const save = useMutation({
    mutationFn: () =>
      setModelImageRoute(
        {
          provider_id: provider,
          ...(provider === '' || model.trim() === '' ? {} : { model: model.trim() }),
          ...(provider === '' || editModel.trim() === '' ? {} : { edit_model: editModel.trim() }),
        },
        assignment,
      ),
    onSuccess: () => {
      setError(null)
      setSaved(true)
      refresh()
    },
    onError: (e: Error) => {
      setSaved(false)
      setError(e.message)
    },
  })

  /** 自定义生图接口：原生表单交出来的值只在这一次调用里存在。 */
  const addCustom = useMutation({
    mutationFn: async (values: ModelFormValues) => {
      await saveImageOnlyProvider(
        values.id,
        {
          label: values.label,
          base_url: values.base_url,
          model: values.model,
          region: values.region,
          ...(values.api_key === undefined ? {} : { api_key: values.api_key }),
        },
        assignment,
      )
      return setModelImageRoute({ provider_id: values.id, model: values.model }, assignment)
    },
    onSuccess: () => {
      setError(null)
      setSaved(true)
      refresh()
    },
    onError: (e: Error) => {
      setSaved(false)
      setError(e.message)
    },
  })

  // 这个进程没装生图设置（老的服务端）：这一块整个不出现
  if (view.isError || view.data === undefined) return null
  const data = view.data
  const choices = data.choices as ModelImageChoice[]
  const picked = choices.find((c) => c.provider_id === provider)
  const using = data.using
  const customTemplate: ModelProviderTemplate = {
    kind: 'openai_compatible',
    label: t('models.image.custom_title'),
    summary: t('models.image.custom_hint'),
    auth: 'api_key',
    default_base_url: 'https://api.openai.com/v1',
    default_model: 'gpt-image-2.5-flare',
    region: 'global',
    steps: [],
    links: [],
  }

  return (
    <section className="flex flex-col gap-2" data-testid="models-image">
      <h4 className="flex items-center gap-1.5 text-sm font-medium">
        <ImageIcon className="size-4" aria-hidden />
        {t('models.image.title')}
        <Hint text={t('models.image.auto_hint')} />
      </h4>
      {/* 一句话：现在用谁 */}
      {using === undefined ? (
        <p className="text-xs text-amber-600 dark:text-amber-400" data-testid="models-image-none">
          {data.unavailable_reason ?? t('models.image.no_choices')}
        </p>
      ) : (
        <p
          className="flex flex-wrap items-center gap-1.5 text-xs"
          data-slot="status"
          data-testid="models-image-using"
          data-source={using.source}
        >
          <span>{t('models.image.using', { label: using.label })}</span>
          <span
            className={
              using.own_key
                ? 'rounded bg-emerald-500/10 px-1.5 py-px text-[11px] text-emerald-700 dark:text-emerald-400'
                : 'rounded bg-muted px-1.5 py-px text-[11px] text-muted-foreground'
            }
            data-slot="badge"
            data-testid="models-image-badge"
          >
            {using.own_key ? t('models.image.badge.own') : t('models.image.badge.credits')}
          </span>
        </p>
      )}
      {/* 积分出图的单价常显（WP127）；走自己的 key 时与他无关，不显示 */}
      {data.credits_per_image === undefined || using?.own_key === true ? null : (
        <p
          className="text-[11px] text-muted-foreground"
          data-slot="status"
          data-testid="models-image-price"
        >
          {t('models.image.price', { credits: data.credits_per_image })}
        </p>
      )}
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex min-w-0 flex-col gap-1 text-xs">
          <span className="text-muted-foreground">{t('models.image.source')}</span>
          <select
            className="max-w-full rounded-md border bg-background px-2 py-1 text-xs"
            value={provider}
            data-testid="models-image-select"
            onChange={(event) => {
              const next = event.currentTarget.value
              setProvider(next)
              setSaved(false)
              const choice = choices.find((c) => c.provider_id === next)
              setModel(choice?.default_model ?? '')
              setEditModel(choice?.default_edit_model ?? '')
            }}
          >
            <option value="">
              {data.auto === undefined
                ? t('models.image.auto_none')
                : t('models.image.auto', { label: data.auto.label })}
            </option>
            {choices.map((c) => (
              <option key={c.provider_id} value={c.provider_id}>
                {c.official ? t('models.image.official') : c.label}
                {c.image_only === true ? ` · ${t('models.image.image_only')}` : ''}
              </option>
            ))}
            <option value={CUSTOM}>{t('models.image.custom')}</option>
          </select>
        </label>
        {provider === '' || provider === CUSTOM ? null : (
          <>
            <label className="flex flex-col gap-1 text-xs">
              <span className="text-muted-foreground">{t('models.image.gen_model')}</span>
              <input
                className="h-7 w-44 rounded-md border bg-background px-2 text-xs"
                value={model}
                data-testid="models-image-model"
                onChange={(event) => {
                  setModel(event.currentTarget.value)
                  setSaved(false)
                }}
              />
            </label>
            <label className="flex flex-col gap-1 text-xs">
              <span className="text-muted-foreground">{t('models.image.edit_model')}</span>
              <input
                className="h-7 w-44 rounded-md border bg-background px-2 text-xs"
                value={editModel}
                placeholder={t('models.image.edit_same')}
                data-testid="models-image-edit-model"
                onChange={(event) => {
                  setEditModel(event.currentTarget.value)
                  setSaved(false)
                }}
              />
            </label>
          </>
        )}
        {provider === CUSTOM ? null : (
          <Button
            size="xs"
            disabled={save.isPending}
            data-testid="models-image-save"
            onClick={() => {
              save.mutate()
            }}
          >
            {t('models.image.save')}
          </Button>
        )}
      </div>
      {provider === CUSTOM ? (
        <div className="rounded-lg border p-2.5" data-testid="models-image-custom">
          <p className="mb-1 text-[11px] text-muted-foreground">{t('models.image.custom_hint')}</p>
          <ModelForm
            template={customTemplate}
            busy={addCustom.isPending}
            takenIds={(providers.data?.providers ?? []).map((p) => p.id)}
            onCancel={() => {
              setProvider(storedOf(data))
            }}
            onSubmit={(values) => {
              addCustom.mutate(values)
            }}
            onDiscover={(probe) =>
              discoverModelProviderModels(
                probe.id,
                {
                  base_url: probe.base_url,
                  region: probe.region,
                  ...(probe.api_key === undefined ? {} : { api_key: probe.api_key }),
                },
                assignment,
              )
            }
          />
        </div>
      ) : null}
      {provider === '' || provider === CUSTOM || picked === undefined || picked.official ? null : (
        <p className="text-[11px] text-muted-foreground" data-slot="status">
          {t('models.image.own_price')}
        </p>
      )}
      {/* 单独指定的那一条坏了：只在"现在选的就是服务端存着的那一份"时说——正在改的时候不唠叨 */}
      {using === undefined ||
      data.unavailable_reason === undefined ||
      saved ||
      provider !== storedOf(data) ? null : (
        <p
          className="text-[11px] text-amber-600 dark:text-amber-400"
          data-testid="models-image-reason"
        >
          {data.unavailable_reason}
        </p>
      )}
      {saved ? (
        <p className="text-[11px] text-emerald-600 dark:text-emerald-400">
          {t('models.image.saved')}
        </p>
      ) : null}
      {error === null ? null : <p className="text-[11px] text-destructive">{error}</p>}
    </section>
  )
}
