/**
 * WP479（决策 1625，Luoye 10-23）：一个已连接来源（ChatGPT 订阅 / DeepSeek 账号 / 各家 API key）勾哪些模型。
 *
 * 「正在用」里那一行下面一行小字按钮「模型 6/9」，点开是这个来源的全部可用模型：勾选框 + 名字 + 例外小标
 * （「不能看图」）+「新」；右上角一个「全选最新」。**模型选择器只列勾上的**（服务端那一份，AI 钮、默认模型下拉
 * 同一份）。默认 / 按用途在用的、API key 的主模型勾着、取消不了（原因进 tooltip）。工坊积分那一组不在这里。
 *
 * 铃铛「有新模型」点进来是 `/settings/models#models-<来源>`：那个来源自己展开、滚过去、亮两秒。
 * 「新」标看过就收（面板打开时告诉服务端「看过了」；这一次打开期间照样标着，免得一眼没看清就没了）。
 */
import { ChevronDown } from 'lucide-react'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { Hint } from '@/components/ui/hint'
import { Input } from '@/components/ui/input'
import type { ModelEnableModelView, ModelEnableSourceView } from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { cn } from '@/lib/utils'

/** 铃铛点进来的锚点：`#models-<provider_id>`。 */
export function enableAnchorOf(provider_id: string): string {
  return `models-${provider_id}`
}

/** 多于这么多个才出搜索框。 */
const SEARCH_FROM = 12
/** 亮多久。 */
const FLASH_MS = 2000

/** 「全选最新」：在现在勾的基础上把每条线最新那一版也勾上（已经勾的不动）。 */
export function withLatest(models: readonly ModelEnableModelView[]): string[] {
  return models.filter((m) => m.enabled || m.latest === true).map((m) => m.id)
}

/** 勾 / 取消一个之后整份勾选（锁着的总在）。 */
export function toggled(models: readonly ModelEnableModelView[], id: string): string[] {
  return models
    .filter((m) => (m.id === id ? !m.enabled : m.enabled) || m.locked !== undefined)
    .map((m) => m.id)
}

export function EnabledModels({
  source,
  busy,
  freshIds,
  onChange,
}: {
  source: ModelEnableSourceView
  busy: boolean
  /** 这一次打开面板时还是「新」的那几个（看过之后服务端不再标，这里照样标到面板关上）。 */
  freshIds: ReadonlySet<string>
  onChange: (enabled: string[]) => void
}): ReactNode {
  const { t } = useApp()
  const location = useLocation()
  const anchor = enableAnchorOf(source.provider_id)
  const linked = decodeURIComponent(location.hash.replace(/^#/, '')) === anchor
  const [open, setOpen] = useState(linked)
  const [flash, setFlash] = useState(linked)
  const [query, setQuery] = useState('')
  const box = useRef<HTMLDivElement>(null)

  // 铃铛点进来：展开、滚过去、亮两秒
  useEffect(() => {
    if (!linked) return
    setOpen(true)
    setFlash(true)
    box.current?.scrollIntoView?.({ block: 'center' })
    const off = setTimeout(() => setFlash(false), FLASH_MS)
    return () => clearTimeout(off)
  }, [linked])

  const models = source.models
  const on = models.filter((m) => m.enabled).length
  const isFresh = (m: ModelEnableModelView): boolean => m.fresh === true || freshIds.has(m.id)
  const anyFresh = models.some(isFresh)
  const q = query.trim().toLowerCase()
  // 新的排前面，其余照目录
  const shown = [...models.filter(isFresh), ...models.filter((m) => !isFresh(m))].filter(
    (m) => q === '' || m.id.toLowerCase().includes(q) || (m.name ?? '').toLowerCase().includes(q),
  )
  const latestMissing = models.some((m) => m.latest === true && !m.enabled)

  return (
    <div
      ref={box}
      className={cn(
        'flex flex-col gap-1.5 rounded-lg transition-shadow',
        flash ? 'ring-2 ring-ws-brand/60 ring-offset-2 ring-offset-background' : undefined,
      )}
      data-testid="model-enable"
      data-provider={source.provider_id}
      data-setting={anchor}
    >
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded-md text-xs text-ws-muted-fg outline-none hover:text-ws-ink focus-visible:ring-2 focus-visible:ring-ring"
          aria-expanded={open}
          data-testid="model-enable-toggle"
          onClick={() => setOpen((v) => !v)}
        >
          {t('models.enable.toggle', { on, all: models.length })}
          {anyFresh ? <NewBadge testId="model-enable-toggle-new" /> : null}
          <ChevronDown
            aria-hidden
            className={cn('size-3.5 transition-transform', open ? 'rotate-180' : undefined)}
          />
        </button>
        <Hint text={t('models.enable.toggle.hint')} />
        {open && latestMissing ? (
          <button
            type="button"
            className="ml-auto rounded-md text-xs text-ws-brand-ink outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
            title={t('models.enable.latest.hint')}
            disabled={busy}
            data-testid="model-enable-latest"
            onClick={() => onChange(withLatest(models))}
          >
            {t('models.enable.latest')}
          </button>
        ) : null}
      </div>

      {open ? (
        <div className="flex flex-col gap-1.5" data-testid="model-enable-list">
          {models.length <= SEARCH_FROM ? null : (
            <Input
              value={query}
              placeholder={t('models.enable.search')}
              className="h-7 max-w-64 text-xs"
              data-testid="model-enable-search"
              onChange={(e) => setQuery(e.currentTarget.value)}
            />
          )}
          <ul className="flex max-h-72 flex-col overflow-auto rounded-lg border border-ws-line bg-background p-1">
            {shown.map((m) => (
              <li key={m.id}>
                <ModelRow
                  model={m}
                  fresh={isFresh(m)}
                  disabled={busy || m.locked !== undefined}
                  onToggle={() => onChange(toggled(models, m.id))}
                />
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  )
}

function NewBadge({ testId }: { testId: string }): ReactNode {
  const { t } = useApp()
  return (
    <span
      className="rounded-full bg-ws-brand-soft px-1.5 text-xs leading-4 font-medium text-ws-brand-ink"
      data-testid={testId}
    >
      {t('models.enable.new')}
    </span>
  )
}

function ModelRow({
  model,
  fresh,
  disabled,
  onToggle,
}: {
  model: ModelEnableModelView
  fresh: boolean
  disabled: boolean
  onToggle: () => void
}): ReactNode {
  const { t } = useApp()
  const why =
    model.locked === 'default'
      ? t('models.enable.locked.default')
      : model.locked === 'main'
        ? t('models.enable.locked.main')
        : undefined
  return (
    <label
      className={cn(
        'flex items-center gap-2 rounded-md px-1.5 py-1 text-sm',
        model.locked === undefined ? 'cursor-pointer hover:bg-ws-surface' : 'cursor-default',
      )}
      title={why ?? model.id}
      data-testid="model-enable-row"
      data-model={model.id}
      data-enabled={model.enabled}
      data-fresh={fresh}
    >
      <input
        type="checkbox"
        checked={model.enabled}
        disabled={disabled}
        data-testid="model-enable-check"
        onChange={onToggle}
      />
      <span className="truncate text-ws-ink">{model.name ?? model.id}</span>
      {fresh ? <NewBadge testId="model-enable-new" /> : null}
      {model.vision === 'no' ? (
        <span className="shrink-0 text-xs text-ws-muted-fg" data-testid="model-enable-no-vision">
          {t('model.pick.cap.no_vision.short')}
        </span>
      ) : null}
      {model.in_use === true && model.locked === undefined ? (
        <span
          className="shrink-0 text-xs text-ws-muted-fg"
          title={t('models.enable.in_use.hint')}
          data-testid="model-enable-in-use"
        >
          {t('models.enable.in_use')}
        </span>
      ) : null}
    </label>
  )
}
