/**
 * 首页（36 §3 二稿）：
 * ① 今日卡片队列（跨岗位合并）+ 告警 + 「预计 X 分钟」
 * ② 每个岗位一条核心数据条：3–4 个数字块，右上角「昨天 | 近 7 天」，「了解更多 →」跳岗位面板
 * ③ 每日摘要（一张）
 *
 * **首页无图表无表格**——那些在岗位面板里。
 */
import type { DeckCard, RangeName } from '@agentsws/deck'
import { useQuery } from '@tanstack/react-query'
import { Clock } from 'lucide-react'
import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { DeckSection } from '@/components/deck'
import { StatTileView } from '@/components/stat-tile'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { getHome } from '@/lib/api'
import { useApp } from '@/lib/app-context'

const RANGES: RangeName[] = ['yesterday', 'last_7d']

export function HomePage(): React.ReactNode {
  const { t } = useApp()
  const navigate = useNavigate()
  const [range, setRange] = useState<RangeName>('yesterday')

  const home = useQuery({ queryKey: ['home', range], queryFn: () => getHome(range) })

  /**
   * 37 §2.2b：卡片是指向事项的指针，`open` = 进入那个事项。
   *
   * 事项页由 WP22 做；在它落地之前，这里只是把人送到卡片所属的岗位页，
   * 而不是假装打开了一个不存在的现场。
   */
  const openCard = (card: DeckCard): void => {
    void navigate(`/positions/${card.position_id}?tab=cards`)
  }

  if (home.isPending) return <Skeleton className="h-64 w-full" />
  if (home.error !== null) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {t('error.generic')}：{home.error.message}
      </p>
    )
  }
  const data = home.data

  return (
    <div className="flex flex-col gap-6" data-testid="home">
      {/* ② 每岗位一条核心数据条 */}
      {data.tiles.map((bar) => (
        <section key={bar.position_id} data-testid="tile-bar" data-position={bar.position_id}>
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-medium">{bar.role_name}</h2>
            <div className="flex items-center gap-1">
              {RANGES.map((r) => (
                <Button
                  key={r}
                  size="xs"
                  variant={range === r ? 'secondary' : 'ghost'}
                  aria-pressed={range === r}
                  onClick={() => {
                    setRange(r)
                  }}
                >
                  {t(`range.${r}`)}
                </Button>
              ))}
              <Button size="xs" variant="ghost" asChild>
                <Link to={`/positions/${bar.position_id}?tab=view`}>{t('home.tiles.more')}</Link>
              </Button>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {bar.tiles.map((tile) => (
              <StatTileView key={tile.id} tile={tile} />
            ))}
          </div>
        </section>
      ))}

      {/* ① 告警（系统卡；P0 留在 deck 里） */}
      {data.alerts.length === 0 ? null : (
        <section data-testid="alerts">
          <h2 className="mb-2 text-sm font-medium">{t('home.alerts')}</h2>
          <ul className="flex flex-col gap-2">
            {data.alerts.map((a) => (
              <li key={a.id} className="rounded-lg border bg-card px-4 py-3 text-sm">
                {a.title}
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* ① 卡片 deck —— 一次一张（37 §1） */}
      <section data-testid="queue">
        <div className="mb-2 flex items-center justify-between gap-2">
          <h2 className="text-sm font-medium">{t('home.queue')}</h2>
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
            <Clock className="size-3" aria-hidden />
            {t('home.estimate', { minutes: data.estimated_minutes })}
          </span>
        </div>
        <DeckSection onOpen={openCard} />
      </section>

      {/* ③ 每日摘要 */}
      {data.digest === undefined ? null : (
        <section data-testid="digest">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">{t('home.digest')}</CardTitle>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">
              {data.digest.summary}
            </CardContent>
          </Card>
        </section>
      )}
    </div>
  )
}
