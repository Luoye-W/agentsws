/**
 * WP227（Luoye 10-05 #13，docs/88 §2.2「营销与订阅：成捆、默认折起、不动邮箱」）：
 * 消息页「全部」的会话列表里，**营销信折成一捆**（只是界面上折起，邮箱里一封不挪、不标），
 * 每一条都挂一个「营销」小标签（图标 + 两个字，说明进 tooltip），一眼认得出。
 *
 * 判定沿用现有分类，不另起一套：
 * - 类型（WP212 `kind`）是「垃圾与营销」（`marketing`）——规则层看自动信头（List-Unsubscribe /
 *   Precedence: bulk …）给，发件人规则或模型也会给；
 * - 老记录没有类型时，看内置标签「营销订阅」（`newsletters`）。
 *
 * 有几种**不折**（照常在列表里，只挂标签）：标了「可疑」的（要人看见）、AI 判了要回的
 * （「没人接」）、人自己加了星标的。搜索时、「待确认」那一栏里也不折——人在找东西。
 */
import type { MessageThreadSummary } from '@agentsws/contracts'
import { ChevronDown, ChevronRight, Megaphone } from 'lucide-react'
import type { ReactNode } from 'react'
import { useApp } from '@/lib/app-context'
import { cn } from '@/lib/utils'

type Row = Pick<MessageThreadSummary, 'kind' | 'labels' | 'claim' | 'starred'>

/** 这条会话是营销信吗（挂「营销」标签）。 */
export function isMarketing(row: Pick<MessageThreadSummary, 'kind' | 'labels'>): boolean {
  if (row.kind !== undefined) return row.kind === 'marketing'
  return row.labels.includes('newsletters')
}

/** 营销信里哪些折进那一捆（可疑、要回、星标的不折）。 */
export function foldsAsMarketing(row: Row): boolean {
  return (
    isMarketing(row) &&
    !row.labels.includes('suspicious') &&
    row.claim !== 'unclaimed' &&
    !row.starred
  )
}

/** 把列表分成「照常列出的」与「折进营销那一捆的」，两边各自保持原来的顺序。 */
export function splitMarketing<T extends Row>(rows: readonly T[]): { listed: T[]; folded: T[] } {
  const listed: T[] = []
  const folded: T[] = []
  for (const r of rows) (foldsAsMarketing(r) ? folded : listed).push(r)
  return { listed, folded }
}

/** 每条营销信上那个小标签：喇叭图标 + 「营销」，说明在 tooltip。 */
export function MarketingTag(): ReactNode {
  const { t } = useApp()
  const hint = t('messages.promo.hint')
  return (
    <span
      data-testid="messages-promo-tag"
      data-slot="status"
      title={hint}
      data-hint={hint}
      className="inline-flex h-[18px] shrink-0 items-center gap-1 rounded-[6px] bg-ws-surface px-1.5 text-[11px] text-ws-muted-fg"
    >
      <Megaphone aria-hidden className="size-3" />
      {t('messages.promo.tag')}
    </span>
  )
}

/** 折起来的那一捆的头：喇叭 + 「营销」+ 封数，点了展开 / 收起。 */
export function MarketingFold({
  count,
  open,
  onToggle,
}: {
  count: number
  open: boolean
  onToggle(): void
}): ReactNode {
  const { t } = useApp()
  const hint = t('messages.promo.hint')
  const Chevron = open ? ChevronDown : ChevronRight
  return (
    <button
      type="button"
      data-testid="messages-promo-fold"
      aria-expanded={open}
      title={hint}
      data-hint={hint}
      onClick={onToggle}
      className={cn(
        'flex w-full items-center gap-2 rounded-[12px] px-2.5 py-2 text-left text-[13px] text-ws-muted-fg hover:bg-ws-surface',
        open && 'text-ws-body',
      )}
    >
      <Chevron aria-hidden className="size-3.5" />
      <Megaphone aria-hidden className="size-3.5" />
      <span className="flex-1">{t('messages.promo.tag')}</span>
      <span className="ws-num text-[12px]" data-testid="messages-promo-count">
        {count}
      </span>
    </button>
  )
}
