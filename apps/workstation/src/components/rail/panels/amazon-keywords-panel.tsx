/**
 * WP398（docs/106 §13 A8）：第三栏的 **Amazon 词表**（`agentsws://amazon-keywords/<分配>`）——
 * 对话里「帮我看看关键词」、岗位页「词库」块的「看词表」都开它。不占图标轨（只按地址开）。
 *
 * - 筛：全部 / 差距词 / 他牌名 + 按来源（联想 / 竞品 / 自家 / 自己加的；二期的两种来源有数了才出）；
 * - 每行：词、来源、几家竞品在用、你写没写进去；他牌名那行标「不能填进后台关键词」；
 * - 标记：核心 / 不要 / 已埋进 Listing（只动本机词库）；
 * - 顶上一句照实写：没有搜索量，按竞品里出现的次数排。
 */
import {
  AMAZON_KEYWORD_LATER_SOURCES,
  AMAZON_KEYWORD_MARKS,
  AMAZON_KEYWORD_SOURCE_LABELS,
  AMAZON_KEYWORD_SOURCES,
  type AmazonKeywordMark,
  type AmazonKeywordQuery,
  type AmazonKeywordSource,
} from '@agentsws/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import type { RailPanelBodyProps } from '@/components/rail/registry'
import { Badge } from '@/components/ui/badge'
import {
  type AmazonKeywordRow,
  listAmazonKeywords,
  markAmazonKeyword,
  parseAmazonKeywordsAddress,
} from '@/lib/amazon-keywords-api'
import { useApp } from '@/lib/app-context'

type Filter = 'all' | 'gap' | 'other_brand' | AmazonKeywordSource

const FILTERS: readonly Filter[] = [
  'all',
  'gap',
  'other_brand',
  ...AMAZON_KEYWORD_SOURCES.filter((s) => !AMAZON_KEYWORD_LATER_SOURCES.includes(s)),
]

const queryOf = (f: Filter): AmazonKeywordQuery =>
  f === 'all'
    ? {}
    : f === 'gap'
      ? { gap: true }
      : f === 'other_brand'
        ? { other_brand: true }
        : { source: f }

/** `B0DEMOEB02` → `B0…02`（一行里放得下几个）。 */
export const shortAsin = (asin: string): string =>
  asin.length > 6 ? `${asin.slice(0, 2)}…${asin.slice(-2)}` : asin

function Row({
  row,
  onMark,
}: {
  row: AmazonKeywordRow
  onMark(mark: AmazonKeywordMark, on: boolean): void
}): ReactNode {
  const { t, lang } = useApp()
  return (
    <li
      className="flex flex-col gap-1 border-b border-ws-line py-2 last:border-b-0"
      data-testid="amzkw-row"
      data-id={row.id}
    >
      {/* WP420（自查 B10 / U22）：一行说完——词 · 几家竞品 · 哪个 ASIN 没写（或已写进）· 来源 */}
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="text-sm font-medium" data-testid="amzkw-term">
          {row.term}
        </span>
        {row.competitors > 0 && (
          <span className="text-xs text-ws-muted-fg" data-testid="amzkw-row-competitors">
            {t('amzkw.gap.competitors', { n: row.competitors })}
          </span>
        )}
        {row.gap ? (
          <Badge variant="outline" data-testid="amzkw-gap-asins">
            {row.gap_asins === undefined || row.gap_asins.length === 0
              ? t('amzkw.filter.gap')
              : t('amzkw.gap.asins', { asins: row.gap_asins.map(shortAsin).join('、') })}
          </Badge>
        ) : row.in_own_text ? (
          <span className="inline-flex items-center gap-0.5 text-xs text-ws-muted-fg">
            <Check className="size-3" />
            {t('amzkw.own.has')}
          </span>
        ) : null}
        <span className="text-xs text-ws-muted-fg" data-testid="amzkw-sources">
          {row.sources.map((s) => (
            <span key={s} data-testid="amzkw-source" data-source={s} className="mr-1.5">
              {lang === 'en'
                ? AMAZON_KEYWORD_SOURCE_LABELS[s].en
                : AMAZON_KEYWORD_SOURCE_LABELS[s].zh}
            </span>
          ))}
        </span>
      </div>
      {row.other_brand !== undefined && (
        <p className="text-xs text-ws-warn" data-testid="amzkw-other-brand">
          {row.other_brand} · {t('amzkw.other_brand')}
        </p>
      )}
      <div className="flex flex-wrap gap-1">
        {AMAZON_KEYWORD_MARKS.map((m) => {
          const on = row.marks.includes(m)
          return (
            <button
              key={m}
              type="button"
              aria-pressed={on}
              // WP420（自查 U22）：做成看得出能点的小按钮（有边框）
              className={
                on
                  ? 'rounded-md border border-ws-ink/30 bg-ws-surface px-1.5 py-0.5 text-xs font-medium text-foreground'
                  : 'rounded-md border border-ws-line px-1.5 py-0.5 text-xs text-ws-muted-fg hover:bg-ws-surface'
              }
              onClick={() => onMark(m, !on)}
              data-testid="amzkw-mark"
              data-mark={m}
            >
              {t(`amzkw.mark.${m}`)}
            </button>
          )
        })}
      </div>
    </li>
  )
}

export function AmazonKeywordsPanel({ address, scope }: RailPanelBodyProps): ReactNode {
  const { t, lang } = useApp()
  const client = useQueryClient()
  const assignment = parseAmazonKeywordsAddress(address) ?? scope?.assignment
  const [filter, setFilter] = useState<Filter>('all')
  const list = useQuery({
    queryKey: ['amazon-keywords-list', assignment, filter],
    queryFn: () => listAmazonKeywords(queryOf(filter), assignment),
  })
  const mark = useMutation({
    mutationFn: (x: { id: string; mark: AmazonKeywordMark; on: boolean }) =>
      markAmazonKeyword(
        { id: x.id, ...(x.on ? { add: [x.mark] } : { remove: [x.mark] }) },
        assignment,
      ),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['amazon-keywords-list', assignment] })
      void client.invalidateQueries({ queryKey: ['amazon-keywords', assignment] })
    },
  })
  const label = (f: Filter): string =>
    f === 'all' || f === 'gap' || f === 'other_brand'
      ? t(`amzkw.filter.${f}`)
      : lang === 'en'
        ? AMAZON_KEYWORD_SOURCE_LABELS[f].en
        : AMAZON_KEYWORD_SOURCE_LABELS[f].zh
  const page = list.data
  return (
    <div className="flex flex-col gap-3 p-3" data-testid="amzkw-panel">
      <div className="flex flex-wrap gap-1" role="tablist">
        {FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            role="tab"
            aria-selected={filter === f}
            className={
              filter === f
                ? 'rounded-full bg-ws-surface px-2.5 py-0.5 text-xs font-medium'
                : 'rounded-full px-2.5 py-0.5 text-xs text-ws-muted-fg hover:bg-ws-surface'
            }
            onClick={() => setFilter(f)}
            data-testid="amzkw-filter"
            data-filter={f}
          >
            {label(f)}
          </button>
        ))}
      </div>
      {page !== undefined && (
        <p className="text-xs text-ws-muted-fg" data-testid="amzkw-panel-note">
          {t('amzkw.total', { n: page.total })} ·{' '}
          {lang === 'en' ? page.sort_note.en : page.sort_note.zh}
        </p>
      )}
      {list.isError ? (
        <p className="text-sm text-ws-muted-fg">{t('amzkw.panel.missing')}</p>
      ) : page === undefined ? null : page.items.length === 0 ? (
        <p className="text-sm text-ws-muted-fg" data-testid="amzkw-panel-empty">
          {t('amzkw.panel.empty')}
        </p>
      ) : (
        <ul className="flex flex-col">
          {page.items.map((r) => (
            <Row key={r.id} row={r} onMark={(m, on) => mark.mutate({ id: r.id, mark: m, on })} />
          ))}
        </ul>
      )}
    </div>
  )
}
