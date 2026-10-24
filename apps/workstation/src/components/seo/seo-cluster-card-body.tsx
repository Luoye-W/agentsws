/**
 * WP450（docs/109 §5.2 #9，docs/96「一张卡批一组」）：中栏「一组主题」卡（`seo_cluster`）的卡面。
 *
 * - 一眼：总页一行、分页几行（每行：哪天写、词、总页 / 分页、回头改哪一页）、内链几条、到日子交给谁写、这次规划花了多少；
 * - 「凭什么分成一组」折着：重叠最多的几对（前 10 名有几个网址一样），问号里说阈值；
 * - 每篇分页可以「去掉」（再点「放回」）；去掉了任何一篇，卡身里出「去掉 N 篇后批」= 带着改过的那组批
 *   （`approve` + `edited_payload`，服务端照改过的那组排日历）。卡底那排「就这样」照旧是整组原样批。
 */
import type { SeoClusterPayload } from '@agentsws/contracts'
import type { DeckCard } from '@agentsws/deck'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { type ReactNode, useState } from 'react'
import { CategoryTag } from '@/components/design'
import { Button } from '@/components/ui/button'
import { Hint } from '@/components/ui/hint'
import { decide } from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { SEO_CALENDAR_KEY } from '@/lib/seo-plan-api'

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** 这张卡是不是「一组主题」。 */
export function isSeoClusterPayload(p: unknown): p is SeoClusterPayload {
  return (
    isRecord(p) &&
    p.form === 'seo_cluster' &&
    isRecord(p.cluster) &&
    isRecord((p.cluster as Record<string, unknown>).pillar) &&
    Array.isArray(p.schedule)
  )
}

/** 去掉几篇分页之后的那一组（链接里涉及去掉那几篇的一并拿掉）。 */
export function withoutSpokes(
  p: SeoClusterPayload,
  removed: ReadonlySet<string>,
): SeoClusterPayload {
  const keep = (id: string): boolean => !removed.has(id)
  return {
    ...p,
    cluster: {
      ...p.cluster,
      spokes: p.cluster.spokes.filter((s) => keep(s.id)),
      links: p.cluster.links.filter((l) => keep(l.from) && keep(l.to)),
    },
    schedule: p.schedule.filter((s) => keep(s.post_id)),
  }
}

export function SeoClusterCardBody({
  card,
  payload,
}: {
  card: DeckCard
  payload: SeoClusterPayload
}): ReactNode {
  const { t } = useApp()
  const client = useQueryClient()
  const [removed, setRemoved] = useState<ReadonlySet<string>>(new Set())
  const approve = useMutation({
    mutationFn: () =>
      decide(
        card.id,
        {
          action: 'approve',
          version: card.version,
          via: 'workstation',
          edited_payload: withoutSpokes(payload, removed),
        } as never,
        card.position_id,
      ),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: ['approval'] })
      void client.invalidateQueries({ queryKey: ['deck'] })
      void client.invalidateQueries({ queryKey: [SEO_CALENDAR_KEY] })
    },
  })
  const c = payload.cluster
  const dateOf = (id: string): string | undefined =>
    payload.schedule.find((s) => s.post_id === id)?.date.slice(5)
  // 按哪天写排（同一天总页在前）
  const posts = [c.pillar, ...c.spokes].sort(
    (a, b) =>
      (dateOf(a.id) ?? '').localeCompare(dateOf(b.id) ?? '') ||
      (a.role === 'pillar' ? -1 : b.role === 'pillar' ? 1 : 0),
  )
  const toggle = (id: string): void => {
    const next = new Set(removed)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setRemoved(next)
  }
  return (
    <div className="mt-2.5 flex flex-col gap-2.5" data-testid="seo-cluster-card">
      <p className="text-xs text-ws-muted-fg" data-testid="seo-cluster-summary">
        {[
          t('seo_cluster.spokes', { n: c.spokes.length }),
          t('seo_cluster.links', { n: c.links.length }),
          t(`seo_cluster.writer.${payload.writer}`),
        ].join(' · ')}
      </p>
      <ul className="flex flex-col divide-y divide-ws-line rounded-ws-block border border-ws-line">
        {posts.map((p) => {
          const off = removed.has(p.id)
          return (
            <li
              key={p.id}
              className="flex min-w-0 items-center gap-2 px-3 py-2"
              data-testid="seo-cluster-post"
              data-role={p.role}
              data-removed={off ? 'true' : 'false'}
            >
              <span className="ws-num w-11 shrink-0 text-xs text-ws-muted-fg">
                {dateOf(p.id) ?? ''}
              </span>
              <span
                className={`flex min-w-0 flex-1 flex-col gap-0.5 ${off ? 'opacity-50 line-through' : ''}`}
              >
                <span className="flex min-w-0 items-center gap-1.5">
                  <CategoryTag>
                    {p.role === 'pillar'
                      ? t('seo_cluster.pillar')
                      : t('seo_cluster.group', { n: p.group + 1 })}
                  </CategoryTag>
                  <span className="truncate text-[13px] font-medium">{p.keyword}</span>
                </span>
                {p.kind === 'refresh' && p.existing_page !== undefined ? (
                  <span className="truncate text-xs text-ws-muted-fg">
                    {t('seo_cluster.refresh_of', {
                      page: p.existing_page.replace(/^https?:\/\/[^/]+/, ''),
                    })}
                  </span>
                ) : p.also !== undefined ? (
                  <span className="truncate text-xs text-ws-muted-fg">
                    {t('seo_cluster.also', { words: p.also.join(', ') })}
                  </span>
                ) : null}
              </span>
              {p.role === 'pillar' ? null : (
                <Button
                  size="xs"
                  variant="ghost"
                  data-testid="seo-cluster-toggle"
                  onClick={() => {
                    toggle(p.id)
                  }}
                >
                  {off ? t('seo_cluster.restore') : t('seo_cluster.remove')}
                </Button>
              )}
            </li>
          )
        })}
      </ul>
      {c.overlap.length === 0 ? null : (
        <details className="text-xs text-ws-muted-fg" data-testid="seo-cluster-overlap">
          <summary className="flex cursor-pointer items-center gap-1">
            {t('seo_cluster.overlap')}
            <Hint text={t('seo_cluster.overlap.hint')} />
          </summary>
          <ul className="mt-1.5 flex flex-col gap-1">
            {c.overlap.map((o) => (
              <li key={`${o.a}|${o.b}`}>
                {o.a} ↔ {o.b}：{t('seo_cluster.overlap.row', { n: o.shared })}
              </li>
            ))}
          </ul>
        </details>
      )}
      {payload.cost === undefined || payload.cost.credits === 0 ? null : (
        <p className="text-xs text-ws-muted-fg">
          {t('seo_cluster.cost', { credits: payload.cost.credits })}
        </p>
      )}
      {removed.size === 0 ? null : (
        <Button
          size="sm"
          className="w-fit"
          data-testid="seo-cluster-approve-edited"
          disabled={approve.isPending || removed.size >= c.spokes.length}
          onClick={() => {
            approve.mutate()
          }}
        >
          {t('seo_cluster.approve_edited', { n: removed.size })}
        </Button>
      )}
    </div>
  )
}
