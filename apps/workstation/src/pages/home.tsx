/**
 * 首页（36 §3 二稿）：
 * ① 今日卡片队列（跨岗位合并）+ 告警 + 「预计 X 分钟」
 * ② 每个岗位一条核心数据条：3–4 个数字块，右上角「昨天 | 近 7 天」，「了解更多 →」跳岗位面板
 * ③ 每日摘要（一张）
 *
 * **首页无图表无表格**——那些在岗位面板里。
 */
import type { DeckCard, RangeName } from '@agentsws/deck'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Clock } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { DeckCardView } from '@/components/deck/deck-card'
import { StatTileView } from '@/components/stat-tile'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { type DecideInput, decide, getHome } from '@/lib/api'
import { useApp } from '@/lib/app-context'

const RANGES: RangeName[] = ['yesterday', 'last_7d']

function CardList({
  cards,
  onDecide,
  errors,
  pendingId,
}: {
  cards: DeckCard[]
  onDecide: (card: DeckCard, input: DecideInput) => void
  errors: Record<string, string>
  pendingId: string | null
}): React.ReactNode {
  return (
    <div className="flex flex-col gap-3">
      {cards.map((card) => (
        <DeckCardView
          key={card.id}
          card={card}
          busy={pendingId === card.id}
          {...(errors[card.id] === undefined ? {} : { error: errors[card.id] })}
          onDecide={(req) => {
            onDecide(card, {
              action: req.action,
              version: req.version,
              ...(req.selected_option_id === undefined
                ? {}
                : { selected_option_id: req.selected_option_id }),
              ...(req.instruction === undefined ? {} : { instruction: req.instruction }),
            })
          }}
        />
      ))}
    </div>
  )
}

export function HomePage(): React.ReactNode {
  const { t } = useApp()
  const client = useQueryClient()
  const [range, setRange] = useState<RangeName>('yesterday')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [pendingId, setPendingId] = useState<string | null>(null)

  const home = useQuery({ queryKey: ['home', range], queryFn: () => getHome(range) })

  const mutation = useMutation({
    mutationFn: (input: { card: DeckCard; body: DecideInput }) =>
      decide(input.card.id, input.body, input.card.position_id),
    onMutate: (input) => {
      setPendingId(input.card.id)
      setErrors((prev) => {
        const next = { ...prev }
        delete next[input.card.id]
        return next
      })
    },
    onError: (error, input) => {
      setErrors((prev) => ({ ...prev, [input.card.id]: error.message }))
    },
    onSettled: () => {
      setPendingId(null)
      void client.invalidateQueries({ queryKey: ['home'] })
      void client.invalidateQueries({ queryKey: ['cards'] })
    },
  })

  const onDecide = (card: DeckCard, body: DecideInput): void => {
    mutation.mutate({ card, body })
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

      {/* ① 告警 */}
      {data.alerts.length === 0 ? null : (
        <section data-testid="alerts">
          <h2 className="mb-2 text-sm font-medium">{t('home.alerts')}</h2>
          <CardList cards={data.alerts} onDecide={onDecide} errors={errors} pendingId={pendingId} />
        </section>
      )}

      {/* ① 队列 */}
      <section data-testid="queue">
        <div className="mb-2 flex items-center justify-between gap-2">
          <h2 className="text-sm font-medium">{t('home.queue')}</h2>
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
            <Clock className="size-3" aria-hidden />
            {t('home.estimate', { minutes: data.estimated_minutes })}
          </span>
        </div>
        {data.queue.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('home.queue.empty')}</p>
        ) : (
          <CardList cards={data.queue} onDecide={onDecide} errors={errors} pendingId={pendingId} />
        )}
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
