/**
 * 岗位页那张「连上这 N 个就能开工」的卡（54（将改号 55）§4 第二层，WP83）。
 *
 * 四条：
 *
 * 1. **来源是服务端算的**（`GET /v1/positions/:id/connections`）：这个岗位所有职责的
 *    `connectors[]` 并集 − 已连。界面不自己算——两边各算一份的话，卡上说缺的
 *    和岗位 `ready` 说的会对不上。
 * 2. **连上就少一条，连完卡自己消失**。`items` 空数组 = 不渲染任何东西，
 *    而不是渲染一张"恭喜你都连好了"的卡（那是在已经干完的事上再占一块地方）。
 * 3. **每一项一键跳那张安全表单**：`/connections?service=<provider>`，连接页会高亮它。
 *    凭据在那张原生表单里填（13 §4.3），这个组件从头到尾不碰任何值。
 * 4. **"还没做"不给按钮**（36 §3）。点进去无处可点的按钮，会让人在连接页上反复找、
 *    以为是自己哪里填错了——照实说那句话就好。
 */
import { useQuery } from '@tanstack/react-query'
import { Link2Off, TriangleAlert } from 'lucide-react'
import { Link } from 'react-router-dom'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Hint } from '@/components/ui/hint'
import { getPositionConnections } from '@/lib/api'
import { useApp } from '@/lib/app-context'

export function PositionConnections({ id }: { id: string }): React.ReactNode {
  const { t, lang } = useApp()
  const view = useQuery({
    queryKey: ['position-connections', id],
    queryFn: () => getPositionConnections(id),
    enabled: id !== '',
  })
  const data = view.data
  // 还在查、查失败、或者一条都不缺：都不出卡（36 §3「不确定的时候少说话」）
  if (data === undefined || data.items.length === 0) return null

  return (
    <Card data-testid="position-connections">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2 text-sm">
          <Link2Off className="size-4" aria-hidden />
          {t('position.connections.title', { n: String(data.items.length) })}
          {/* WP157：「连一个少一条、连完这张卡就不见了」进问号 */}
          <Hint text={t('position.connections.subtitle')} />
          {data.ready ? null : (
            <Badge variant="outline" className="gap-1" data-testid="position-not-ready">
              <TriangleAlert className="size-3" aria-hidden />
              {t('position.connections.not_ready')}
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <ul className="flex flex-col gap-2">
          {data.items.map((item) => (
            <li
              key={item.kind}
              className="flex flex-wrap items-start justify-between gap-3 rounded-md border p-2"
              data-testid="position-connection-item"
              data-kind={item.kind}
            >
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-2 text-sm">
                  {lang === 'zh' ? item.name.zh : item.name.en}
                  {/* 36 §3：**没连**与**还没做**是两回事，后者那句话（为什么还没有）进问号，
                      右边照样写着「还没做」 */}
                  {item.status === 'planned' && item.note !== undefined ? (
                    <Hint
                      text={lang === 'zh' ? item.note.zh : item.note.en}
                      testId="position-connection-note"
                    />
                  ) : null}
                  <span className="text-xs text-muted-foreground" data-slot="status">
                    {item.required
                      ? t('position.connections.required')
                      : t('position.connections.optional')}
                  </span>
                </p>
                <p className="text-xs text-muted-foreground" data-slot="data">
                  {t('position.connections.needed_by', { roles: item.needed_by.join('、') })}
                </p>
              </div>
              {item.status === 'available' && item.connect_service !== undefined ? (
                <Button asChild size="sm" variant="outline">
                  <Link
                    to={`/connections?service=${encodeURIComponent(item.connect_service)}`}
                    data-testid="position-connection-go"
                  >
                    {t('position.connections.connect')}
                  </Link>
                </Button>
              ) : (
                <span
                  className="text-xs text-muted-foreground"
                  data-testid="position-connection-planned"
                  data-slot="status"
                >
                  {t('position.connections.planned')}
                </span>
              )}
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  )
}
