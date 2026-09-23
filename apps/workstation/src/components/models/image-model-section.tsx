/**
 * 设置页「模型」的第二块：**生图**（WP127 交付 3，Luoye 09-23：生图单独设置一档）。
 *
 * 文字模型（必须能看图）与出图是两件事、两份钱：文字那一块在上面；这一块只管
 * "出图用谁"。可以不配——不配时要出图的岗位说一句人话让人来这里（`NO_IMAGE_MODEL_ZH`）。
 *
 * 能选的只有已经接上、而且有生图口的那几条（Agents 工坊官方接口 / OpenAI 兼容口）。
 * 官方接口出图按张扣积分，单价**常显**（`pricing.json` 的 `ai.image`）——不是选了之后
 * 才告诉你多少钱。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Image as ImageIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Hint } from '@/components/ui/hint'
import { getModelImage, setModelImage } from '@/lib/api'
import { useApp } from '@/lib/app-context'

export function ImageModelSection({ assignment }: { assignment?: string }): React.ReactNode {
  const { t } = useApp()
  const client = useQueryClient()
  const view = useQuery({
    queryKey: ['model-image', assignment],
    queryFn: () => getModelImage(assignment),
    retry: false,
  })
  const [provider, setProvider] = useState('')
  const [model, setModel] = useState('')
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 服务端那份变了（别处改了 / 刚加载完）就跟上
  useEffect(() => {
    if (view.data === undefined) return
    setProvider(view.data.configured ? (view.data.provider_id ?? '') : '')
    setModel(view.data.model ?? '')
  }, [view.data])

  const save = useMutation({
    mutationFn: () =>
      setModelImage(
        { provider_id: provider, ...(provider === '' || model.trim() === '' ? {} : { model }) },
        assignment,
      ),
    onSuccess: () => {
      setError(null)
      setSaved(true)
      void client.invalidateQueries({ queryKey: ['model-image'] })
    },
    onError: (e: Error) => {
      setSaved(false)
      setError(e.message)
    },
  })

  // 这个进程没装生图设置（老的服务端）：这一块整个不出现
  if (view.isError || view.data === undefined) return null
  const data = view.data
  const picked = data.choices.find((c) => c.provider_id === provider)
  const official = picked?.official === true

  return (
    <section className="flex flex-col gap-2" data-testid="models-image">
      <h4 className="flex items-center gap-1.5 text-sm font-medium">
        <ImageIcon className="size-4" aria-hidden />
        {t('models.image.title')}
        <Hint text={t('models.image.hint')} />
      </h4>
      {data.credits_per_image === undefined ? null : (
        <p className="text-[11px] text-muted-foreground" data-testid="models-image-price">
          {t('models.image.price', { credits: data.credits_per_image })}
        </p>
      )}
      {data.choices.length === 0 ? (
        <p className="text-xs text-muted-foreground" data-testid="models-image-empty">
          {t('models.image.no_choices')}
        </p>
      ) : (
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-muted-foreground">{t('models.image.source')}</span>
            <select
              className="rounded-md border bg-background px-2 py-1 text-xs"
              value={provider}
              data-testid="models-image-select"
              onChange={(event) => {
                const next = event.currentTarget.value
                setProvider(next)
                setSaved(false)
                const choice = data.choices.find((c) => c.provider_id === next)
                if (choice !== undefined && model.trim() === '') setModel(choice.default_model)
              }}
            >
              <option value="">{t('models.image.none')}</option>
              {data.choices.map((c) => (
                <option key={c.provider_id} value={c.provider_id}>
                  {c.official ? t('models.image.official') : c.label}
                </option>
              ))}
            </select>
          </label>
          {provider === '' ? null : (
            <label className="flex flex-col gap-1 text-xs">
              <span className="text-muted-foreground">{t('models.image.model')}</span>
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
          )}
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
        </div>
      )}
      {provider === '' || official ? null : (
        <p className="text-[11px] text-muted-foreground">{t('models.image.own_price')}</p>
      )}
      {data.unavailable_reason === undefined || saved ? null : (
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
