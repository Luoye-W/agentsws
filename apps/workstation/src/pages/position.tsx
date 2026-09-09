/**
 * 岗位页 = 该岗位的世界（36 §3）：卡片 / 面板 / 记录 三个 Tab。
 *
 * 面板按数据源分块（店铺后台 / GA4 / Search Console / 广告后台）；
 * 数据源没接时出「去连接」，不出空图。
 */
import type { DeckCard, RangeName } from '@agentsws/deck'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link2Off } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { BlockCard } from '@/components/blocks/block-view'
import { DeckCardView } from '@/components/deck/deck-card'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  type DecideInput,
  decide,
  getPositionCards,
  getPositionRecords,
  getPositionView,
} from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { formatDate } from '@/lib/format'

const RANGES: RangeName[] = ['yesterday', 'last_7d']

function CardsTab({ id }: { id: string }): React.ReactNode {
  const { t } = useApp()
  const client = useQueryClient()
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [pendingId, setPendingId] = useState<string | null>(null)
  const cards = useQuery({ queryKey: ['cards', id], queryFn: () => getPositionCards(id) })

  const mutation = useMutation({
    mutationFn: (input: { card: DeckCard; body: DecideInput }) =>
      decide(input.card.id, input.body, id),
    onMutate: (input) => {
      setPendingId(input.card.id)
    },
    onError: (error, input) => {
      setErrors((prev) => ({ ...prev, [input.card.id]: error.message }))
    },
    onSettled: () => {
      setPendingId(null)
      void client.invalidateQueries({ queryKey: ['cards', id] })
      void client.invalidateQueries({ queryKey: ['home'] })
    },
  })

  if (cards.isPending) return <Skeleton className="h-40 w-full" />
  const list = cards.data?.cards ?? []
  if (list.length === 0)
    return <p className="text-sm text-muted-foreground">{t('position.cards.empty')}</p>
  return (
    <div className="flex flex-col gap-3">
      {list.map((card) => (
        <DeckCardView
          key={card.id}
          card={card}
          busy={pendingId === card.id}
          {...(errors[card.id] === undefined ? {} : { error: errors[card.id] })}
          onDecide={(req) => {
            mutation.mutate({
              card,
              body: {
                action: req.action,
                version: req.version,
                ...(req.selected_option_id === undefined
                  ? {}
                  : { selected_option_id: req.selected_option_id }),
                ...(req.instruction === undefined ? {} : { instruction: req.instruction }),
              },
            })
          }}
        />
      ))}
    </div>
  )
}

function ViewTab({ id }: { id: string }): React.ReactNode {
  const { t } = useApp()
  const [range, setRange] = useState<RangeName>('yesterday')
  const view = useQuery({
    queryKey: ['view', id, range],
    queryFn: () => getPositionView(id, range),
  })
  if (view.isPending) return <Skeleton className="h-64 w-full" />
  return (
    <div className="flex flex-col gap-6">
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
      </div>
      {(view.data?.sections ?? []).map((section) => (
        <section key={section.source} data-testid="view-section" data-source={section.source}>
          <h3 className="mb-2 text-sm font-medium">{section.label}</h3>
          {section.connected ? (
            <div className="grid gap-3 lg:grid-cols-2">
              {section.blocks.map((block) => (
                <BlockCard key={block.id} block={block} range={range} assignment={id} />
              ))}
            </div>
          ) : (
            <Card data-testid="connect-card">
              <CardHeader>
                <CardTitle className="flex items-center gap-1.5 text-sm">
                  <Link2Off className="size-4" aria-hidden />
                  {t('view.not_connected', { source: section.label })}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <Button size="sm" variant="outline" asChild>
                  <a href="/settings">{t('view.connect')}</a>
                </Button>
              </CardContent>
            </Card>
          )}
        </section>
      ))}
    </div>
  )
}

function RecordsTab({ id }: { id: string }): React.ReactNode {
  const { t, lang } = useApp()
  const records = useQuery({ queryKey: ['records', id], queryFn: () => getPositionRecords(id) })
  if (records.isPending) return <Skeleton className="h-40 w-full" />
  const rows = records.data?.payload?.rows ?? []
  if (rows.length === 0) return <p className="text-sm text-muted-foreground">—</p>
  return (
    <ol className="flex flex-col gap-3" data-testid="records">
      {rows.map((row) => (
        <li key={row.id} className="border-l pl-3">
          <div className="flex flex-wrap items-baseline gap-2 text-xs text-muted-foreground">
            <time dateTime={row.at}>{formatDate(row.at, lang)}</time>
            <span>{t(`kind.${row.kind}`)}</span>
            <span className="font-mono">{row.state}</span>
          </div>
          <div className="text-sm">{row.title}</div>
          <p className="text-xs text-muted-foreground">{row.summary}</p>
        </li>
      ))}
    </ol>
  )
}

export function PositionPage(): React.ReactNode {
  const { t, selectPosition } = useApp()
  const params = useParams<{ id: string }>()
  const [search, setSearch] = useSearchParams()
  const id = params.id ?? ''
  const tab = search.get('tab') ?? 'cards'

  // 进岗位页就把当前 Assignment 切过去（31 §3.1 一次请求一个 Assignment）
  useEffect(() => {
    if (id !== '') selectPosition(id)
  }, [id, selectPosition])

  return (
    <div className="flex flex-col gap-4" data-testid="position-page" data-position={id}>
      <Tabs
        value={tab}
        onValueChange={(next) => {
          setSearch((prev) => {
            const params = new URLSearchParams(prev)
            params.set('tab', next)
            return params
          })
        }}
      >
        <TabsList>
          <TabsTrigger value="cards">{t('position.tab.cards')}</TabsTrigger>
          <TabsTrigger value="view">{t('position.tab.view')}</TabsTrigger>
          <TabsTrigger value="records">{t('position.tab.records')}</TabsTrigger>
        </TabsList>
        <TabsContent value="cards">
          <CardsTab id={id} />
        </TabsContent>
        <TabsContent value="view">
          <ViewTab id={id} />
        </TabsContent>
        <TabsContent value="records">
          <RecordsTab id={id} />
        </TabsContent>
      </Tabs>
    </div>
  )
}
