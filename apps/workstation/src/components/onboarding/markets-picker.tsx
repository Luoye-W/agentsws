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
import { useState } from 'react'
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

/**
 * WP169（Luoye 09-27 定）：多一个市场，搜索可见度的探测就多一份花费——选了 2 个及以上时一句提示，
 * 细节进问号（36 §7）。这几个数与服务端同一口径（界面不另算价目，只把默认值摆出来）：
 * 每周默认问 6 个（`seo-service` 的 `DEFAULT_GEO_QUESTIONS`）× 3 个平台（`seo-core` 的
 * `geoPlatformsFor` 默认那三个）× 市场数 × 每次 0.2 积分（`metering/pricing.json` 的
 * `data.search.ai_answer`）；每日搜索结果页每个市场各 5 次（`MAX_SERP_CHECKS_PER_DAY`）。
 */
export const MARKETS_COST_DEFAULTS = {
  questions: 6,
  platforms: 3,
  credits_per_probe: 0.2,
  serp_per_market_per_day: 5,
} as const

/** 每周默认花费（积分）：问题 × 平台 × 市场 × 单价，保留一位小数。 */
export function weeklyProbeCredits(markets: number): number {
  const d = MARKETS_COST_DEFAULTS
  return Math.round(d.questions * d.platforms * markets * d.credits_per_probe * 10) / 10
}

/**
 * WP240（Fable 10-06 真机）：选中的市场最多先摆这么多个小标签，其余收进「还有 N 个」。
 * Shopify 店的国家切换器常常列着两百多个国家，原样铺开就是满满一屏。
 */
export const MARKETS_SHOWN = 8

/** WP240：按国名或国家码搜（不分大小写）。 */
export function matchesMarket(code: string, name: string, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (q === '') return true
  return code.toLowerCase().includes(q) || name.toLowerCase().includes(q)
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
  const [expanded, setExpanded] = useState(false)
  const [query, setQuery] = useState('')
  const rest = MARKET_COUNTRY_CODES.filter((c) => !value.includes(c))
  const hit = (c: string): boolean => matchesMarket(c, marketLabel(c, lang), query)
  const common = COMMON_MARKETS.filter((c) => rest.includes(c) && hit(c))
  const others = rest
    .filter((c) => !COMMON_MARKETS.includes(c) && hit(c))
    .map((c) => ({ c, name: marketLabel(c, lang) }))
    .sort((a, b) => a.name.localeCompare(b.name, lang === 'zh' ? 'zh-CN' : 'en'))
  const many = value.length > MARKETS_SHOWN
  const shown = many && !expanded ? value.slice(0, MARKETS_SHOWN) : value

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
        shown.map((code) => {
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
      {/* WP240：多了就收起来，留「还有 N 个 / 收起」与「全部清掉」 */}
      {many ? (
        <button
          type="button"
          className="rounded-sm px-1 text-[11px] text-ws-muted-fg underline-offset-2 hover:text-foreground hover:underline"
          data-testid="markets-more"
          onClick={() => {
            setExpanded((v) => !v)
          }}
        >
          {expanded ? t('markets.less') : t('markets.more', { n: value.length - MARKETS_SHOWN })}
        </button>
      ) : null}
      {many ? (
        <button
          type="button"
          disabled={disabled}
          className="rounded-sm px-1 text-[11px] text-ws-muted-fg underline-offset-2 hover:text-foreground hover:underline"
          data-testid="markets-clear"
          onClick={() => {
            onChange([])
          }}
        >
          {t('markets.clear')}
        </button>
      ) : null}
      {/* WP240：先搜再选——下拉里只剩搜得到的那几个 */}
      <input
        type="search"
        aria-label={t('markets.search')}
        placeholder={t('markets.search')}
        data-testid="market-search"
        disabled={disabled}
        className="h-6 w-28 rounded-sm border bg-transparent px-1 text-[11px]"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value)
        }}
      />
      <select
        aria-label={t('markets.add')}
        data-testid="market-add"
        disabled={disabled}
        className="h-6 max-w-28 rounded-sm border bg-transparent px-1 text-[11px] text-ws-muted-fg"
        value=""
        onChange={(e) => {
          const code = e.target.value
          if (code !== '' && !value.includes(code)) onChange([...value, code])
          setQuery('')
        }}
      >
        <option value="">
          {common.length + others.length === 0 ? t('markets.no_match') : `+ ${t('markets.add')}`}
        </option>
        {common.length === 0 ? null : (
          <optgroup label={t('markets.common')}>
            {common.map((c) => (
              <option key={c} value={c}>
                {marketLabel(c, lang)}
              </option>
            ))}
          </optgroup>
        )}
        {others.length === 0 ? null : (
          <optgroup label={t('markets.all')}>
            {others.map(({ c, name }) => (
              <option key={c} value={c}>
                {name}
              </option>
            ))}
          </optgroup>
        )}
      </select>
      {originText === undefined ? null : <Hint text={originText} testId="markets-origin" />}
      {value.length < 2 ? null : (
        <span
          className="flex basis-full items-center gap-1 text-[11px] text-ws-muted-fg"
          data-slot="status"
          data-testid="markets-cost"
        >
          {t('markets.cost')}
          <Hint
            testId="markets-cost-hint"
            text={t('markets.cost.hint', {
              q: String(MARKETS_COST_DEFAULTS.questions),
              p: String(MARKETS_COST_DEFAULTS.platforms),
              m: String(value.length),
              price: String(MARKETS_COST_DEFAULTS.credits_per_probe),
              c: String(weeklyProbeCredits(value.length)),
              serp: String(MARKETS_COST_DEFAULTS.serp_per_market_per_day),
            })}
          />
        </span>
      )}
    </div>
  )
}
