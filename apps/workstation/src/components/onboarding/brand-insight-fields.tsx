/**
 * WP346（决策 872）：品牌档案第二版那几格——子品类、定位、价格带、目标人群、关键词、主要竞品。
 *
 * 首次设置第 ② 步的档案卡与设置页「品牌档案」用**同一个件**：每一格「值 + 铅笔」，点铅笔就地改；
 * AI 填的、人还没核过的那几格挂「AI 建议」（出处进 tooltip）。设置页另给一个 ✓——不改值、只说「对」。
 *
 * 图形化优先（界面少字）：人群三行、关键词三组画成标签、竞品一行一个名字（理由进 tooltip）。
 * 抓不到又没改过的格子整行不出（档案卡那条老规矩）；设置页要能补，所以 `showEmpty` 时空格子也摆出来。
 */
import type { BrandAudience, BrandCompetitor, BrandKeywords } from '@agentsws/contracts'
import { Check, Pencil, Plus, X } from 'lucide-react'
import { useState } from 'react'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { useApp } from '@/lib/app-context'

export type InsightKey =
  | 'subcategory'
  | 'positioning'
  | 'price_band'
  | 'audience'
  | 'keywords'
  | 'competitors'

export const INSIGHT_KEYS: readonly InsightKey[] = [
  'positioning',
  'subcategory',
  'price_band',
  'audience',
  'keywords',
  'competitors',
]

export interface InsightValues {
  subcategory?: string
  positioning?: string
  price_band?: string
  audience?: BrandAudience
  keywords?: BrandKeywords
  competitors?: BrandCompetitor[]
}

/** 逗号 / 顿号 / 换行隔开的一串 → 去空去重的数组。 */
export function splitList(text: string): string[] {
  const out: string[] = []
  for (const part of text.split(/[,，、\n]/)) {
    const v = part.trim()
    if (v !== '' && !out.some((o) => o.toLowerCase() === v.toLowerCase())) out.push(v)
  }
  return out
}

/** 一格是不是空的（空串、没有、三组关键词全空、人群没写谁买）。 */
export function insightEmpty(key: InsightKey, v: InsightValues): boolean {
  switch (key) {
    case 'audience':
      return (v.audience?.buyers ?? '').trim() === ''
    case 'keywords': {
      const k = v.keywords
      return k === undefined || k.brand.length + k.category.length + k.scenario.length === 0
    }
    case 'competitors':
      return (v.competitors ?? []).length === 0
    default:
      return (v[key] ?? '').trim() === ''
  }
}

/** 「AI 建议」小标（出处 / 说明进 tooltip，不铺在外面）。 */
export function AiTag({ field, title }: { field: string; title?: string }): React.ReactNode {
  const { t } = useApp()
  return (
    <span
      className="rounded-sm bg-violet-100 px-1 text-[11px] text-violet-900 dark:bg-violet-900/40 dark:text-violet-200"
      data-testid={`insight-ai-${field}`}
      title={title ?? t('intake.tag.ai.hint')}
    >
      {t('intake.tag.ai')}
    </span>
  )
}

const chip = 'rounded-sm bg-ws-subtle px-1.5 py-0.5 text-[11px]'

/** 一格的只读画法。 */
function ValueView({ field, v }: { field: InsightKey; v: InsightValues }): React.ReactNode {
  const { t } = useApp()
  if (insightEmpty(field, v)) return <span className="text-ws-muted-fg">{t('intake.empty')}</span>
  switch (field) {
    case 'audience': {
      const a = v.audience as BrandAudience
      return (
        <span className="flex flex-col gap-0.5" data-testid="insight-value-audience">
          <span>{a.buyers}</span>
          {a.payer === undefined || a.payer === '' ? null : (
            <span className="text-xs text-ws-muted-fg">
              {t('intake.audience.payer')}：{a.payer}
            </span>
          )}
          {(a.concerns ?? []).length === 0 ? null : (
            <span className="flex flex-wrap gap-1">
              {(a.concerns ?? []).map((c) => (
                <span key={c} className={chip}>
                  {c}
                </span>
              ))}
            </span>
          )}
        </span>
      )
    }
    case 'keywords': {
      const k = v.keywords as BrandKeywords
      return (
        <span className="flex flex-col gap-1" data-testid="insight-value-keywords">
          {(['brand', 'category', 'scenario'] as const)
            .filter((g) => k[g].length > 0)
            .map((g) => (
              <span key={g} className="flex flex-wrap items-center gap-1">
                <span className="text-[11px] text-ws-muted-fg">{t(`intake.keywords.${g}`)}</span>
                {k[g].map((w) => (
                  <span key={w} className={chip}>
                    {w}
                  </span>
                ))}
              </span>
            ))}
        </span>
      )
    }
    case 'competitors':
      return (
        <span className="flex flex-wrap gap-1" data-testid="insight-value-competitors">
          {(v.competitors ?? []).map((c) => (
            <span key={c.name} className={chip} title={c.reason}>
              {c.name}
            </span>
          ))}
        </span>
      )
    default:
      return <span data-testid={`insight-value-${field}`}>{v[field]}</span>
  }
}

/** 一格的改法。改一下就回调一次（父组件握着值；关掉编辑框就是改完了）。 */
function ValueEdit({
  field,
  v,
  onChange,
}: {
  field: InsightKey
  v: InsightValues
  onChange: (value: unknown) => void
}): React.ReactNode {
  const { t } = useApp()
  switch (field) {
    case 'positioning':
      return (
        <Textarea
          autoFocus
          data-testid="insight-input-positioning"
          className="min-h-14 text-sm"
          maxLength={800}
          value={v.positioning ?? ''}
          onChange={(e) => {
            onChange(e.target.value)
          }}
        />
      )
    case 'audience': {
      const a: BrandAudience = v.audience ?? { buyers: '' }
      const set = (patch: Partial<BrandAudience>): void => {
        onChange({ ...a, ...patch })
      }
      return (
        <span className="flex w-full flex-col gap-1">
          <Input
            autoFocus
            className="h-7"
            data-testid="insight-input-audience-buyers"
            placeholder={t('intake.audience.buyers')}
            value={a.buyers}
            onChange={(e) => {
              set({ buyers: e.target.value })
            }}
          />
          <Input
            className="h-7"
            data-testid="insight-input-audience-payer"
            placeholder={t('intake.audience.payer')}
            value={a.payer ?? ''}
            onChange={(e) => {
              set({ payer: e.target.value })
            }}
          />
          <Input
            className="h-7"
            data-testid="insight-input-audience-concerns"
            placeholder={`${t('intake.audience.concerns')}（${t('intake.list.hint')}）`}
            defaultValue={(a.concerns ?? []).join('，')}
            onChange={(e) => {
              set({ concerns: splitList(e.target.value) })
            }}
          />
        </span>
      )
    }
    case 'keywords': {
      const k: BrandKeywords = v.keywords ?? { brand: [], category: [], scenario: [] }
      return (
        <span className="flex w-full flex-col gap-1">
          {(['brand', 'category', 'scenario'] as const).map((g, i) => (
            <Input
              key={g}
              autoFocus={i === 0}
              className="h-7"
              data-testid={`insight-input-keywords-${g}`}
              placeholder={`${t(`intake.keywords.${g}`)}（${t('intake.list.hint')}）`}
              defaultValue={k[g].join('，')}
              onChange={(e) => {
                onChange({ ...k, [g]: splitList(e.target.value) })
              }}
            />
          ))}
        </span>
      )
    }
    case 'competitors': {
      const list = v.competitors ?? []
      const set = (next: BrandCompetitor[]): void => {
        onChange(next)
      }
      return (
        <span className="flex w-full flex-col gap-1">
          {list.map((c, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: 行就是按位置改的（名字可能正在改）
            <span key={i} className="flex items-center gap-1">
              <Input
                className="h-7 w-32"
                data-testid={`insight-input-competitor-name-${i}`}
                placeholder={t('intake.competitor.name')}
                value={c.name}
                onChange={(e) => {
                  set(list.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))
                }}
              />
              <Input
                className="h-7"
                placeholder={t('intake.competitor.reason')}
                value={c.reason}
                onChange={(e) => {
                  set(list.map((x, j) => (j === i ? { ...x, reason: e.target.value } : x)))
                }}
              />
              <button
                type="button"
                aria-label={t('intake.competitor.remove', { name: c.name })}
                className="text-ws-muted-fg hover:text-foreground"
                onClick={() => {
                  set(list.filter((_, j) => j !== i))
                }}
              >
                <X size={12} />
              </button>
            </span>
          ))}
          {list.length >= 8 ? null : (
            <button
              type="button"
              data-testid="insight-competitor-add"
              className="flex items-center gap-1 self-start text-xs text-ws-muted-fg hover:text-foreground"
              onClick={() => {
                set([...list, { name: '', reason: '' }])
              }}
            >
              <Plus size={12} />
              {t('intake.competitor.add')}
            </button>
          )}
        </span>
      )
    }
    default:
      return (
        <Input
          autoFocus
          className="h-7"
          data-testid={`insight-input-${field}`}
          maxLength={field === 'price_band' ? 60 : 80}
          value={v[field] ?? ''}
          onChange={(e) => {
            onChange(e.target.value)
          }}
        />
      )
  }
}

/** 一行：标签 + 值（或改的框）+ AI 小标 + 铅笔 / ✓。 */
function InsightRow({
  field,
  values,
  ai,
  edited,
  onChange,
  onAccept,
  showEmpty,
  disabled,
}: {
  field: InsightKey
  values: InsightValues
  ai: boolean
  edited: boolean
  onChange: (field: InsightKey, value: unknown) => void
  onAccept?: ((field: InsightKey) => void) | undefined
  showEmpty: boolean
  disabled: boolean
}): React.ReactNode {
  const { t } = useApp()
  const [open, setOpen] = useState(false)
  const empty = insightEmpty(field, values)
  if (empty && !open && !showEmpty) return null
  return (
    <div className="flex items-start gap-2 text-sm" data-testid={`insight-row-${field}`}>
      <span className="w-24 shrink-0 pt-0.5 text-ws-muted-fg">{t(`intake.field.${field}`)}</span>
      {open ? (
        <span className="flex min-w-0 flex-1 items-start gap-1">
          <ValueEdit
            field={field}
            v={values}
            onChange={(value) => {
              onChange(field, value)
            }}
          />
          <button
            type="button"
            aria-label={t('intake.edit.done')}
            data-testid={`insight-done-${field}`}
            className="pt-1 text-ws-muted-fg hover:text-foreground"
            onClick={() => {
              setOpen(false)
            }}
          >
            <Check size={14} />
          </button>
        </span>
      ) : (
        <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-2">
          <ValueView field={field} v={values} />
          {ai && !empty ? <AiTag field={field} /> : null}
          {edited && !ai ? (
            <span className="text-[11px] text-ws-muted-fg" data-testid={`insight-edited-${field}`}>
              {t('intake.tag.edited')}
            </span>
          ) : null}
          {ai && !empty && onAccept !== undefined ? (
            <button
              type="button"
              aria-label={t('intake.ai.accept')}
              title={t('intake.ai.accept')}
              data-testid={`insight-accept-${field}`}
              disabled={disabled}
              className="text-ws-muted-fg hover:text-foreground"
              onClick={() => {
                onAccept(field)
              }}
            >
              <Check size={12} />
            </button>
          ) : null}
          <button
            type="button"
            aria-label={t('intake.edit')}
            data-testid={`insight-edit-${field}`}
            disabled={disabled}
            className="text-ws-muted-fg hover:text-foreground"
            onClick={() => {
              setOpen(true)
            }}
          >
            <Pencil size={12} />
          </button>
        </span>
      )}
    </div>
  )
}

/**
 * 那几格整块。`ai` 是哪几格挂「AI 建议」，`edited` 是哪几格人改过（挂「已改」）。
 * 给了 `onAccept`（设置页）就多一个 ✓：不改值，只说「对」。
 */
export function BrandInsightFields({
  values,
  ai,
  edited = [],
  onChange,
  onAccept,
  showEmpty = false,
  disabled = false,
}: {
  values: InsightValues
  ai: readonly string[]
  edited?: readonly string[]
  onChange: (field: InsightKey, value: unknown) => void
  onAccept?: (field: InsightKey) => void
  showEmpty?: boolean
  disabled?: boolean
}): React.ReactNode {
  return (
    <div className="flex flex-col gap-1.5" data-testid="brand-insight-fields">
      {INSIGHT_KEYS.map((f) => (
        <InsightRow
          key={f}
          field={f}
          values={values}
          ai={ai.includes(f)}
          edited={edited.includes(f)}
          onChange={onChange}
          onAccept={onAccept}
          showEmpty={showEmpty}
          disabled={disabled}
        />
      ))}
    </div>
  )
}
