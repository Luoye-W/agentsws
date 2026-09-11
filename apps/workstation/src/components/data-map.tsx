/**
 * 47 J1 的"给人看的那一份"：设置页的**数据地图**（只读）。
 *
 * 它回答的是一个每个新同事都会问、而现在没人答得上来的问题：
 * **"我在这个系统里到底看得到什么？那些数字是从哪来的？多新？我能动它吗？"**
 *
 * 一行一类对象，四列：真源在哪、多新、我能看多大范围、能对它做什么。
 * 数据本身不在这一页——这里只是一张目录（47 J4：登记表不是新的存储）。
 *
 * 36 §7 三层信息：页面上只留一句副标题，"为什么" / "这一列什么意思"全进 tooltip。
 */

import type { TailoredAction, TailoredObject } from '@agentsws/ontology/view'
import { ORDER_RULE } from '@agentsws/ontology/view'
import { useQuery } from '@tanstack/react-query'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Hint } from '@/components/ui/hint'
import { Skeleton } from '@/components/ui/skeleton'
import { getPositionOntology } from '@/lib/api'
import { useApp } from '@/lib/app-context'

/** `cached:300` → "缓存 5 分钟"；其余两档直接查表。 */
function freshnessText(
  freshness: TailoredObject['freshness'],
  t: (k: string, v?: Record<string, string | number>) => string,
): string {
  if (freshness === 'realtime' || freshness === 'authored')
    return t(`datamap.freshness.${freshness}`)
  const seconds = Number.parseInt(freshness.slice('cached:'.length), 10)
  return t('datamap.freshness.cached', { n: Math.max(1, Math.round(seconds / 60)) })
}

function actionsOf(object: TailoredObject, actions: readonly TailoredAction[]): TailoredAction[] {
  return actions.filter((a) => a.object === object.id)
}

export function DataMapPanel({
  position,
  assignment,
}: {
  position: string
  assignment?: string
}): React.ReactNode {
  const { t } = useApp()
  const map = useQuery({
    queryKey: ['ontology', position],
    queryFn: () => getPositionOntology(position, assignment),
    retry: false,
  })

  return (
    <Card data-testid="data-map">
      <CardHeader>
        <CardTitle className="flex items-center gap-1 text-sm">
          {t('datamap.title')}
          <Hint text={t('datamap.hint')} />
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        {map.isPending ? <Skeleton className="h-40 w-full" /> : null}
        {map.error !== null ? (
          <p role="alert" className="text-sm text-destructive">
            {t('error.generic')}：{map.error.message}
          </p>
        ) : null}
        {map.data === undefined ? null : map.data.objects.length === 0 ? (
          <p className="text-muted-foreground">{t('datamap.empty')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs" data-testid="data-map-table">
              <thead className="text-muted-foreground">
                <tr className="border-b">
                  <th scope="col" className="py-1 text-left font-normal">
                    {t('datamap.col.object')}
                  </th>
                  <th scope="col" className="py-1 text-left font-normal">
                    <span className="inline-flex items-center gap-1">
                      {t('datamap.col.source')}
                      <Hint text={t('datamap.col.source.hint')} />
                    </span>
                  </th>
                  <th scope="col" className="py-1 text-left font-normal">
                    <span className="inline-flex items-center gap-1">
                      {t('datamap.col.freshness')}
                      <Hint text={t('datamap.col.freshness.hint')} />
                    </span>
                  </th>
                  <th scope="col" className="py-1 text-left font-normal">
                    <span className="inline-flex items-center gap-1">
                      {t('datamap.col.range')}
                      <Hint text={t('datamap.col.range.hint')} />
                    </span>
                  </th>
                  <th scope="col" className="py-1 text-left font-normal">
                    {t('datamap.col.actions')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {map.data.objects.map((o) => {
                  const mine = actionsOf(o, map.data.actions)
                  return (
                    <tr key={o.id} className="border-b last:border-0">
                      <td className="py-1">{o.label}</td>
                      <td className="py-1">{t(`datamap.source.${o.source_of_truth}`)}</td>
                      <td className="py-1">{freshnessText(o.freshness, t)}</td>
                      <td className="py-1">
                        {o.read_range === undefined ? '—' : t(`datamap.range.${o.read_range}`)}
                      </td>
                      <td className="py-1">
                        {mine.length === 0 ? (
                          <span className="text-muted-foreground">{t('datamap.actions.none')}</span>
                        ) : (
                          mine.map((a) => a.label).join('、')
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
        {/*
          47 J3：这段话与 Agent 提示词里那一段是**同一处生成的**（`ORDER_RULE`）。
          摆在这儿是为了让人看见"它是按什么顺序想问题的"——而不是让人去猜。
        */}
        <p className="flex items-start gap-1 text-xs text-muted-foreground">
          <span className="font-medium">{t('datamap.order')}</span>
          <Hint text={t('datamap.order.hint')} />
          <span data-testid="data-map-order">{ORDER_RULE}</span>
        </p>
      </CardContent>
    </Card>
  )
}
