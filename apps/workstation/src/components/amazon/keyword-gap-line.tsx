/**
 * WP398（docs/106 §13 A8）：「有 N 个竞品常用词你没写进标题 / 五点」那一行——点开看清单。
 *
 * 用在两处：岗位页「词库」块（每个自家 ASIN 一行），和 Listing 体检卡（WP396：每个 ASIN 那张卡里加这一行，
 * 用 {@link KeywordGapLine} 传 `asin` 即可，它自己取词库）。
 *
 * 一期没有搜索量：清单按「几家竞品在用」排，底下照实写一句（`sort_note`）。只出建议，不改 Amazon。
 */
import { useQuery } from '@tanstack/react-query'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { useRailState } from '@/components/rail/rail-state'
import {
  type AmazonKeywordGap,
  amazonKeywordsAddress,
  getAmazonKeywords,
} from '@/lib/amazon-keywords-api'
import { useApp } from '@/lib/app-context'

/** 点开后列几个（多的去词表看）。 */
const SHOW = 10

export function KeywordGapLineView({
  gap,
  sortNote,
  assignment,
}: {
  gap: AmazonKeywordGap
  sortNote: string
  assignment?: string | undefined
}): ReactNode {
  const { t } = useApp()
  const rail = useRailState()
  const [open, setOpen] = useState(false)
  const n = gap.common
  if (gap.competitors_compared === 0)
    return (
      <p className="text-sm text-ws-muted-fg" data-testid="amzkw-gap-line" data-asin={gap.asin}>
        {t('amzkw.gap.no_competitors')}
      </p>
    )
  if (gap.terms.length === 0)
    return (
      <p className="text-sm text-ws-muted-fg" data-testid="amzkw-gap-line" data-asin={gap.asin}>
        {t('amzkw.gap.none')}
      </p>
    )
  const shown = gap.terms.slice(0, SHOW)
  return (
    <div className="flex flex-col gap-1.5" data-testid="amzkw-gap-line" data-asin={gap.asin}>
      <button
        type="button"
        className="flex items-center gap-1 text-left text-sm hover:underline"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        data-testid="amzkw-gap-toggle"
      >
        {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        <span>{t('amzkw.gap.line', { n: n === 0 ? gap.terms.length : n })}</span>
        <span className="text-xs text-ws-muted-fg">{gap.asin}</span>
      </button>
      {open && (
        <div className="flex flex-col gap-1 pl-5" data-testid="amzkw-gap-list">
          <ul className="flex flex-col gap-1">
            {shown.map((term) => (
              <li
                key={term.id}
                className="flex flex-wrap items-baseline gap-x-2 text-sm"
                data-testid="amzkw-gap-term"
              >
                <span className="font-medium">{term.term}</span>
                <span className="text-xs text-ws-muted-fg">
                  {t('amzkw.gap.competitors', { n: term.competitors })}
                </span>
              </li>
            ))}
          </ul>
          {gap.terms.length > SHOW && (
            <button
              type="button"
              className="w-fit text-xs text-ws-muted-fg underline-offset-2 hover:underline"
              onClick={() => rail.openAddress(amazonKeywordsAddress(assignment))}
            >
              {t('amzkw.more', { n: gap.terms.length - SHOW })}
            </button>
          )}
          <p className="text-xs text-ws-muted-fg" data-testid="amzkw-sort-note">
            {sortNote}
          </p>
        </div>
      )}
    </div>
  )
}

/** 体检卡里用：给一个自家 ASIN，自己取词库那一份差距；还没有词库 / 这个 ASIN 没算过就不出这一行。 */
export function KeywordGapLine({
  assignment,
  asin,
}: {
  assignment?: string | undefined
  asin: string
}): ReactNode {
  const { lang } = useApp()
  const view = useQuery({
    queryKey: ['amazon-keywords', assignment],
    queryFn: () => getAmazonKeywords(assignment),
  })
  const gap = view.data?.gaps.find((g) => g.asin === asin.toUpperCase())
  if (view.data === undefined || gap === undefined) return null
  return (
    <KeywordGapLineView
      gap={gap}
      sortNote={lang === 'en' ? view.data.sort_note.en : view.data.sort_note.zh}
      assignment={assignment}
    />
  )
}
