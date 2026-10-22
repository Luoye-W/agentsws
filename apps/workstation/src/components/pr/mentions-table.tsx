/**
 * WP419（自查 P5 / P10）：信息监控拉回来的提及——右侧「报表」里一张积木表（按组 / 情绪 / 来源筛、说了什么能搜，
 * 点标题去原文）。以前拉回来的东西界面上一条都看不到，只能问 AI。没拉到的源照实说一句（不等于没人提）。
 */
import type { TableResult } from '@agentsws/deck'
import { useQuery } from '@tanstack/react-query'
import { type ReactNode, useMemo } from 'react'
import { BlockTable } from '@/components/blocks/block-view'
import { useScopeMonitor } from '@/components/pr/use-scope-monitor'
import type { RailScope } from '@/components/rail/rail-scope'
import { useApp } from '@/lib/app-context'
import { getPrMentions, type PrMentionRowView, prMentionsKey } from '@/lib/pr-watch-api'

export const PR_MENTIONS_TABLE_ID = 'pr.monitoring.mentions'

export function mentionsPayload(
  rows: readonly PrMentionRowView[],
  t: (key: string, vars?: Record<string, string | number>) => string,
): TableResult {
  return {
    columns: [
      { key: 'group', label: t('prm.col.group'), filter: 'select' },
      { key: 'what', label: t('prm.col.what'), filter: 'search', link_key: 'url' },
      { key: 'sentiment', label: t('prm.col.sentiment'), filter: 'select' },
      { key: 'origin', label: t('prm.col.origin'), filter: 'select' },
      { key: 'published_at', label: t('prm.col.when'), filter: 'date' },
    ],
    rows: [...rows]
      .sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at))
      .map((m) => ({
        id: m.id,
        group:
          m.competitor === undefined || m.competitor === ''
            ? t(`prm.group.${m.group ?? 'own'}`)
            : `${t(`prm.group.${m.group ?? 'own'}`)} · ${m.competitor}`,
        what: (m.title ?? m.text).replace(/\s+/gu, ' ').trim().slice(0, 160),
        sentiment: t(`prm.sent.${m.sentiment ?? 'none'}`),
        origin: m.origin,
        published_at: m.published_at,
        url: m.url,
      })),
  }
}

export function MentionsTable({
  scope,
  limit,
}: {
  scope: RailScope | undefined
  limit?: number
}): ReactNode {
  const { t } = useApp()
  const monitor = useScopeMonitor(scope)
  const assignment = monitor?.assignment
  const q = useQuery({
    queryKey: prMentionsKey(assignment ?? ''),
    queryFn: () => getPrMentions(assignment as string),
    enabled: assignment !== undefined,
    retry: false,
    staleTime: 60_000,
  })
  const rows = q.data?.rows ?? []
  const payload = useMemo(() => mentionsPayload(rows, t), [rows, t])
  if (assignment === undefined) return null
  const failed = monitor?.view?.failed ?? 0
  return (
    <section className="flex flex-col gap-1.5" data-testid="pr-mentions">
      <h4 className="text-xs tracking-wider text-ws-muted-fg uppercase">{t('prm.title')}</h4>
      {failed === 0 ? null : (
        <p className="text-[12px] text-ws-warn" data-testid="pr-mentions-failed">
          {t('prm.failed', { n: failed })}
        </p>
      )}
      {rows.length === 0 && q.isPending ? null : (
        <BlockTable
          payload={payload}
          tableId={PR_MENTIONS_TABLE_ID}
          dense
          testId="pr-mentions-table"
          empty={t('prm.empty')}
          {...(limit === undefined ? {} : { limit })}
        />
      )}
    </section>
  )
}
