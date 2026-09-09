/**
 * 筛选行（37 §1 末段）。
 *
 * KefuAgent 只有 全部 / 客户在等 / 无人等待 三枚 chip。我们多岗位，所以多一行：
 * 岗位 chip + 等待 chip + 卡型下拉 + 来源下拉。
 *
 * 三条纪律：**不跳页**（只改这副牌的集合）、**计数按张数**（合并前的总数）、
 * **P0 永不被筛掉**（被筛掉的 P0 由 `pinned_p0` 回带，上面出一行提示）。
 */
import type { DeckFilters, DeckKind, DeckSource } from '@agentsws/deck'
import { Button } from '@/components/ui/button'
import { useApp } from '@/lib/app-context'

export interface PositionOption {
  position_id: string
  role_name: string
}

/** 37 §3 的三种来源。 */
const SOURCES: DeckSource[] = ['todo', 'conversation', 'system']

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

export function DeckFilterRow({
  filters,
  counts,
  positions,
  kinds,
  pinnedCount,
  onChange,
}: {
  filters: DeckFilters
  counts: { total: number; customer_waiting: number; nobody_waiting: number; matched: number }
  /** 岗位页只有一个岗位，这时不出岗位 chip */
  positions: PositionOption[]
  /** 当前这副牌里出现过的卡型（下拉只列真有的，不列 16 种全表） */
  kinds: DeckKind[]
  pinnedCount: number
  onChange: (next: DeckFilters) => void
}): React.ReactNode {
  const { t } = useApp()
  /**
   * 改一枚 chip。
   *
   * 传 `undefined` 就是**取消这个条件**，而不是"把它设成 undefined"——
   * `exactOptionalPropertyTypes` 下这两件事是不同的，所以这里真的把键删掉，
   * 免得 `{ waiting: undefined }` 被序列化成 `waiting=` 发上去。
   */
  const patch = <K extends keyof DeckFilters>(key: K, value: DeckFilters[K] | undefined): void => {
    const next: DeckFilters = { ...filters }
    if (value === undefined) delete next[key]
    else next[key] = value
    onChange(next)
  }

  return (
    <div className="flex flex-col gap-2" data-testid="deck-filters">
      <div className="flex flex-wrap items-center gap-1.5">
        {positions.length > 1 ? (
          <>
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
            <span className="mx-1 h-4 w-px bg-border" />
          </>
        ) : null}
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
