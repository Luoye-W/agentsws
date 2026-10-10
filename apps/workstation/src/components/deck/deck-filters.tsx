/**
 * 筛选（37 §1 末段）。
 *
 * KefuAgent 只有 全部 / 客户在等 / 无人等待 三枚 chip。我们多岗位，所以多几样：
 * 岗位 chip + 等待 chip + 卡型下拉 + 来源下拉。
 *
 * 三条纪律：**不跳页**（只改这副牌的集合）、**计数按张数**（合并前的总数）、
 * **P0 永不被筛掉**（被筛掉的 P0 由 `pinned_p0` 回带，上面出一行提示）。
 *
 * WP288（决策 326，Luoye 10-09「字太多」）：平时**收进一个筛选图标**（「要你处理 N」那一行右侧），
 * 点开才是那几枚 chip / 下拉与语言切换；**只有正在筛选时**，标题下出一排已选条件（点 × 去掉）。
 * 原来常驻的那一整行筛选不再占地方。
 */
import type { DeckContentMode, DeckFilters, DeckKind, DeckSource } from '@agentsws/deck'
import { CONTENT_MODES } from '@agentsws/deck'
import { ListFilter, X } from 'lucide-react'
import { Pop } from '@/components/position/work-bits'
import { Button } from '@/components/ui/button'
import { useApp } from '@/lib/app-context'

export interface PositionOption {
  position_id: string
  role_name: string
}

/** 37 §3 的三种来源。 */
const SOURCES: DeckSource[] = ['todo', 'conversation', 'system']

/** 默认的语言（队列级）：不算「正在筛选」。 */
export const DEFAULT_CONTENT_MODE: DeckContentMode = 'zh_summary'

export type DeckCounts = {
  total: number
  customer_waiting: number
  nobody_waiting: number
  matched: number
}

function Chip({
  active,
  label,
  onClick,
}: {
  active: boolean
  label: string
  onClick: () => void
}): React.ReactNode {
  return (
    <button
      type="button"
      aria-pressed={active}
      className={
        active
          ? 'rounded-full border border-primary bg-primary/10 px-2.5 py-0.5 text-xs'
          : 'rounded-full border px-2.5 py-0.5 text-xs text-muted-foreground hover:text-foreground'
      }
      onClick={onClick}
    >
      {label}
    </button>
  )
}

/**
 * 改一个条件。传 `undefined` 就是**取消这个条件**，而不是"把它设成 undefined"——
 * `exactOptionalPropertyTypes` 下这两件事是不同的，所以这里真的把键删掉，
 * 免得 `{ waiting: undefined }` 被序列化成 `waiting=` 发上去。
 */
function patched<K extends keyof DeckFilters>(
  filters: DeckFilters,
  key: K,
  value: DeckFilters[K] | undefined,
): DeckFilters {
  const next: DeckFilters = { ...filters }
  if (value === undefined) delete next[key]
  else next[key] = value
  return next
}

/** 正在生效的条件数（语言不是默认的也算一条：人得知道自己看的不是中文摘要）。 */
export function activeFilterCount(filters: DeckFilters, mode: DeckContentMode): number {
  return Object.keys(filters).length + (mode === DEFAULT_CONTENT_MODE ? 0 : 1)
}

/** 「要你处理 N」右侧那个筛选图标 + 弹层（里面是原来那一整行）。 */
export function DeckFilterPop({
  filters,
  counts,
  positions,
  kinds,
  mode,
  onChange,
  onMode,
}: {
  filters: DeckFilters
  counts: DeckCounts
  /** 岗位页只有一个岗位，这时不出岗位 chip */
  positions: PositionOption[]
  /** 当前这副牌里出现过的卡型（下拉只列真有的，不列 16 种全表） */
  kinds: DeckKind[]
  mode: DeckContentMode
  onChange: (next: DeckFilters) => void
  onMode: (next: DeckContentMode) => void
}): React.ReactNode {
  const { t } = useApp()
  const patch = <K extends keyof DeckFilters>(key: K, value: DeckFilters[K] | undefined): void => {
    onChange(patched(filters, key, value))
  }
  const n = activeFilterCount(filters, mode)
  return (
    <Pop
      label=""
      ariaLabel={n === 0 ? t('deck.filter.open') : t('deck.filter.active', { n })}
      icon={
        <span className="relative inline-flex">
          <ListFilter className="size-4" aria-hidden />
          {n === 0 ? null : (
            <span
              aria-hidden
              className="absolute -top-1 -right-1.5 inline-flex size-3.5 items-center justify-center rounded-full bg-ws-brand text-[9px] font-semibold text-background"
            >
              {n}
            </span>
          )}
        </span>
      }
      testId="deck-filter"
      active={n > 0}
    >
      <div className="flex w-[260px] flex-col gap-2.5" data-testid="deck-filters">
        {positions.length > 1 ? (
          <div className="flex flex-wrap items-center gap-1.5">
            <Chip
              active={filters.position_id === undefined}
              label={t('deck.filter.all', { n: counts.total })}
              onClick={() => {
                patch('position_id', undefined)
              }}
            />
            {positions.map((p) => (
              <Chip
                key={p.position_id}
                active={filters.position_id === p.position_id}
                label={p.role_name}
                onClick={() => {
                  patch('position_id', p.position_id)
                }}
              />
            ))}
          </div>
        ) : null}
        <div className="flex flex-wrap items-center gap-1.5">
          <Chip
            active={filters.waiting === 'customer_waiting'}
            label={t('deck.filter.waiting', { n: counts.customer_waiting })}
            onClick={() => {
              patch(
                'waiting',
                filters.waiting === 'customer_waiting' ? undefined : 'customer_waiting',
              )
            }}
          />
          <Chip
            active={filters.waiting === 'nobody_waiting'}
            label={t('deck.filter.nobody', { n: counts.nobody_waiting })}
            onClick={() => {
              patch('waiting', filters.waiting === 'nobody_waiting' ? undefined : 'nobody_waiting')
            }}
          />
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <select
            className="rounded-full border bg-background px-2 py-0.5 text-xs"
            aria-label={t('deck.filter.kind')}
            value={filters.kind ?? ''}
            onChange={(e) => {
              patch('kind', e.target.value === '' ? undefined : (e.target.value as DeckKind))
            }}
          >
            <option value="">{t('deck.filter.kind.all')}</option>
            {kinds.map((k) => (
              <option key={k} value={k}>
                {t(`kind.${k}`)}
              </option>
            ))}
          </select>
          <select
            className="rounded-full border bg-background px-2 py-0.5 text-xs"
            aria-label={t('deck.filter.source')}
            value={filters.source ?? ''}
            onChange={(e) => {
              patch('source', e.target.value === '' ? undefined : (e.target.value as DeckSource))
            }}
          >
            <option value="">{t('deck.filter.source.all')}</option>
            {SOURCES.map((s) => (
              <option key={s} value={s}>
                {t(`deck.source.${s}`)}
              </option>
            ))}
          </select>
        </div>
        {/* 语言是**队列级**的，不是每张卡各选一次（37 §1 第 4 行） */}
        <fieldset
          className="inline-flex self-start rounded-full border p-0.5 text-xs"
          data-testid="deck-modes"
        >
          <legend className="sr-only">{t('deck.filter.lang')}</legend>
          {CONTENT_MODES.map((m) => (
            <button
              key={m}
              type="button"
              aria-pressed={m === mode}
              className={
                m === mode
                  ? 'rounded-full bg-primary px-2.5 py-0.5 text-primary-foreground'
                  : 'rounded-full px-2.5 py-0.5 text-muted-foreground hover:text-foreground'
              }
              onClick={() => {
                onMode(m)
              }}
            >
              {t(`deck.content.${m}`)}
            </button>
          ))}
        </fieldset>
      </div>
    </Pop>
  )
}

/**
 * 正在筛选时，标题下那一排已选条件（点一下就去掉那一条）。没在筛选就什么都不画。
 * 被筛掉的 P0 那一句提示也在这里（它只在筛选时才会出现）。
 */
export function DeckActiveFilters({
  filters,
  positions,
  mode,
  pinnedCount,
  onChange,
  onMode,
}: {
  filters: DeckFilters
  positions: PositionOption[]
  mode: DeckContentMode
  pinnedCount: number
  onChange: (next: DeckFilters) => void
  onMode: (next: DeckContentMode) => void
}): React.ReactNode {
  const { t } = useApp()
  const chips: { key: string; label: string; remove: () => void }[] = []
  if (filters.position_id !== undefined)
    chips.push({
      key: 'position',
      label:
        positions.find((p) => p.position_id === filters.position_id)?.role_name ??
        filters.position_id,
      remove: () => onChange(patched(filters, 'position_id', undefined)),
    })
  if (filters.waiting !== undefined)
    chips.push({
      key: 'waiting',
      label: t(
        filters.waiting === 'customer_waiting' ? 'deck.filter.waiting.on' : 'deck.filter.nobody.on',
      ),
      remove: () => onChange(patched(filters, 'waiting', undefined)),
    })
  if (filters.kind !== undefined)
    chips.push({
      key: 'kind',
      label: t(`kind.${filters.kind}`),
      remove: () => onChange(patched(filters, 'kind', undefined)),
    })
  if (filters.source !== undefined)
    chips.push({
      key: 'source',
      label: t(`deck.source.${filters.source}`),
      remove: () => onChange(patched(filters, 'source', undefined)),
    })
  if (mode !== DEFAULT_CONTENT_MODE)
    chips.push({
      key: 'mode',
      label: t(`deck.content.${mode}`),
      remove: () => onMode(DEFAULT_CONTENT_MODE),
    })
  if (chips.length === 0 && pinnedCount === 0) return null
  return (
    <div className="flex flex-col gap-1.5" data-testid="deck-active-filters">
      {chips.length === 0 ? null : (
        <div className="flex flex-wrap items-center gap-1.5">
          {chips.map((c) => (
            <button
              key={c.key}
              type="button"
              data-testid="deck-active-filter"
              data-filter={c.key}
              aria-label={t('deck.filter.remove', { what: c.label })}
              className="inline-flex items-center gap-1 rounded-full border border-primary bg-primary/10 py-0.5 pr-1.5 pl-2.5 text-xs hover:bg-primary/20"
              onClick={c.remove}
            >
              {c.label}
              <X className="size-3" aria-hidden />
            </button>
          ))}
        </div>
      )}
      {pinnedCount === 0 ? null : (
        <p className="text-xs text-amber-600 dark:text-amber-400" data-testid="deck-pinned-p0">
          {t('deck.pinned_p0', { n: pinnedCount })}
          <Button
            size="xs"
            variant="ghost"
            onClick={() => {
              onChange({})
            }}
          >
            {t('deck.back_to_all')}
          </Button>
        </p>
      )}
    </div>
  )
}
