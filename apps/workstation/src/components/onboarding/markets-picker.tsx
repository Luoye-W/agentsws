/**
 * WP166：目标市场选择器——向导第 ② 步的档案卡与设置页「公司档案」用的是**同一个件**，
 * 存的是同一份 `WorkspaceProfile.markets`（唯一来源）。
 *
 * 图形化：选中的市场画成一排小标签（中文国名），每个带一个 ×；后面一个「加市场」下拉
 * （常用的排前面，其余按国名排）。出处进问号（36 §7 少字）：「我们从官网的配送政策看出来的」。
 * 一个都没有时明说「没看出来，请选一下」（空态可见，不藏）。
 */
import { COMMON_MARKETS, MARKET_COUNTRY_CODES } from '@agentsws/contracts'
import { X } from 'lucide-react'
import { Hint } from '@/components/ui/hint'
import { useApp } from '@/lib/app-context'

/** 市场 `US` → 「美国」（界面语言）。认不出来的原样给。 */
export function marketLabel(code: string, lang: 'zh' | 'en'): string {
  if (!/^[A-Za-z]{2}$/.test(code)) return code
  try {
    return (
      new Intl.DisplayNames([lang === 'zh' ? 'zh-CN' : 'en'], { type: 'region' }).of(
        code.toUpperCase(),
      ) ?? code
    )
  } catch {
    return code
  }
}

/** 出处里的 `locator` → 问号里那几个字的 key。 */
const KIND_OF: readonly [RegExp, string][] = [
  [/^shopify:localization/, 'markets.kind.localization'],
  [/^(hreflang|path:locale)/, 'markets.kind.hreflang'],
  [/^tld/, 'markets.kind.tld'],
  [/^policy:shipping/, 'markets.kind.shipping'],
  [/^text:ships-to/, 'markets.kind.ships_to'],
  [/^currency/, 'markets.kind.currency'],
]

export interface MarketsOrigin {
  from: 'site' | 'amazon' | 'store' | 'human'
  evidence?: readonly { locator: string }[]
  note?: string
}

/** 问号里那一句（从哪看出来的）。 */
export function useMarketsOriginText(): (origin: MarketsOrigin | undefined) => string | undefined {
  const { t, lang } = useApp()
  return (origin) => {
    if (origin === undefined) return undefined
    if (origin.from === 'human') return t('markets.from.human')
    if (origin.from === 'amazon') return t('markets.from.amazon')
    if (origin.from === 'store') return origin.note ?? t('markets.from.store')
    const kinds: string[] = []
    for (const e of origin.evidence ?? []) {
      const key = KIND_OF.find(([re]) => re.test(e.locator))?.[1]
      if (key !== undefined && !kinds.includes(key)) kinds.push(key)
    }
    if (kinds.length === 0) return undefined
    return t('markets.from.site', {
      what: kinds.map((k) => t(k)).join(lang === 'zh' ? '、' : ', '),
    })
  }
}

export function MarketsPicker({
  value,
  onChange,
  origin,
  disabled = false,
}: {
  value: readonly string[]
  onChange: (next: string[]) => void
  /** 出处（进问号）；人改过就是 `human`。不给就不出问号。 */
  origin?: MarketsOrigin | undefined
  disabled?: boolean
}): React.ReactNode {
  const { t, lang } = useApp()
  const originText = useMarketsOriginText()(origin)
  const rest = MARKET_COUNTRY_CODES.filter((c) => !value.includes(c))
  const common = COMMON_MARKETS.filter((c) => rest.includes(c))
  const others = rest
    .filter((c) => !COMMON_MARKETS.includes(c))
    .map((c) => ({ c, name: marketLabel(c, lang) }))
    .sort((a, b) => a.name.localeCompare(b.name, lang === 'zh' ? 'zh-CN' : 'en'))

  return (
    <div className="flex flex-wrap items-center gap-1" data-testid="markets-picker">
      {value.length === 0 ? (
        <span
          className="text-xs text-amber-700 dark:text-amber-300"
          data-slot="status"
          data-testid="markets-empty"
        >
          {t('markets.empty')}
        </span>
      ) : (
        value.map((code) => {
          const name = marketLabel(code, lang)
          return (
            <span
              key={code}
              className="inline-flex items-center gap-0.5 rounded-sm bg-ws-subtle px-1.5 py-0.5 text-[11px]"
              data-testid="market-chip"
              data-code={code}
            >
              {name}
              <button
                type="button"
                disabled={disabled}
                aria-label={t('markets.remove', { name })}
                data-testid={`market-remove-${code}`}
                className="text-ws-muted-fg hover:text-foreground"
                onClick={() => {
                  onChange(value.filter((c) => c !== code))
                }}
              >
                <X size={10} aria-hidden />
              </button>
            </span>
          )
        })
      )}
      <select
        aria-label={t('markets.add')}
        data-testid="market-add"
        disabled={disabled}
        className="h-6 rounded-sm border bg-transparent px-1 text-[11px] text-ws-muted-fg"
        value=""
        onChange={(e) => {
          const code = e.target.value
          if (code !== '' && !value.includes(code)) onChange([...value, code])
        }}
      >
        <option value="">+ {t('markets.add')}</option>
        <optgroup label={t('markets.common')}>
          {common.map((c) => (
            <option key={c} value={c}>
              {marketLabel(c, lang)}
            </option>
          ))}
        </optgroup>
        <optgroup label={t('markets.all')}>
          {others.map(({ c, name }) => (
            <option key={c} value={c}>
              {name}
            </option>
          ))}
        </optgroup>
      </select>
      {originText === undefined ? null : <Hint text={originText} testId="markets-origin" />}
    </div>
  )
}
